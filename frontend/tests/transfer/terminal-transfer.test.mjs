import assert from 'node:assert/strict'
import test from 'node:test'
import { File } from 'node:buffer'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { ref } from 'vue'
import { mountComposable } from '../helpers/lifecycle.mjs'
import { INLINE_TRANSFER_LIMIT, useTerminalFileTransfer } from '../../src/domains/transfer/application/useTerminalFileTransfer'

const until=async predicate=>{for(let i=0;i<100;i++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,1))}throw Error('condition did not become true')}
const binding=()=>({terminalId:'a',connectionId:'bastion',generation:1,revision:1,serverKey:'server-a',host:'10.0.0.1',username:'deploy',label:'deploy@10.0.0.1',source:'terminal',override:{targetHost:'10.0.0.1',targetUsername:'deploy'},identity:{username:'deploy',hostname:'app',machine:'0123456789abcdef',ips:['10.0.0.1'],pwd:'/srv'}})

function setup(t,options={}) {
  const commands=[],writes=[],interrupts=[],generation=ref(1)
  let sequence=0
  const bridge={readiness:()=>options.readiness??'ready',write:command=>{
    commands.push(command)
    return options.write?options.write(command):true
  },interrupt:()=>{interrupts.push(generation.value);return true}}
  const {state,unmount}=mountComposable(t,()=>useTerminalFileTransfer({bridge:()=>bridge,generation:()=>generation.value,timeoutMs:options.timeout??200},{writeFile:async(...args)=>writes.push(args)}))
  const deliver=(command=commands.at(-1),body='status=0',terminalId='a')=>{
    const begin=command.match(/AI_TERM_FILE_BEGIN_[A-Za-z0-9_]+/)?.[0],end=command.match(/AI_TERM_FILE_END_[A-Za-z0-9_]+/)?.[0].replace(/_DATA$/, '')
    const output=`${begin}\n${body}\n${end}\n`
    state.feedOutput({terminalId,sequence:++sequence,delta:output,snapshot:output})
  }
  return {state,commands,writes,interrupts,generation,deliver,unmount}
}

test('cancelling a dispatched terminal upload interrupts once and ignores its late result',async t=>{
  const s=setup(t),controller=new AbortController()
  const upload=s.state.upload(new File(['hello'],'a.txt'),'/srv/a.txt',binding(),controller.signal)
  const cancelled=assert.rejects(upload,/取消/)
  await until(()=>s.commands.length===1)
  controller.abort();controller.abort()
  await cancelled
  assert.deepEqual(s.interrupts,[1])
  s.deliver(s.commands[0])
  const retry=s.state.upload(new File(['hello'],'a.txt'),'/srv/a.txt',binding(),new AbortController().signal)
  await until(()=>s.commands.length===2)
  s.deliver(s.commands[1])
  assert.equal((await retry).targetPath,'/srv/a.txt')
})

test('cancelling before terminal dispatch sends neither a command nor an interrupt',async t=>{
  const s=setup(t),controller=new AbortController()
  const download=s.state.download('/srv/a.txt','D:/a.txt',binding(),controller.signal)
  controller.abort()
  await assert.rejects(download,/取消/)
  assert.deepEqual(s.commands,[])
  assert.deepEqual(s.interrupts,[])
  assert.deepEqual(s.writes,[])
})

test('terminal download timeout interrupts the command and never writes a late file',async t=>{
  const s=setup(t,{timeout:15})
  await assert.rejects(s.state.download('/srv/a.txt','D:/a.txt',binding(),new AbortController().signal),/超时/)
  assert.deepEqual(s.interrupts,[1])
  s.deliver(s.commands[0],'aGVsbG8=\nstatus=0')
  assert.deepEqual(s.writes,[])
})

test('a terminal generation change cancels pending work without interrupting the new session',async t=>{
  const s=setup(t)
  const download=s.state.download('/srv/a.txt','D:/a.txt',binding(),new AbortController().signal)
  const stopped=assert.rejects(download,/取消|变化|断开/)
  await until(()=>s.commands.length===1)
  s.generation.value=2
  await stopped
  s.deliver(s.commands[0],'aGVsbG8=\nstatus=0')
  assert.deepEqual(s.interrupts,[])
  assert.deepEqual(s.writes,[])
})

test('terminal downloads require their own terminal and markers before saving the decoded bytes',async t=>{
  const s=setup(t)
  const download=s.state.download('/srv/a.txt','D:/a.txt',binding(),new AbortController().signal,true)
  await until(()=>s.commands.length===1)
  s.deliver(s.commands[0],'aGVsbG8=\nstatus=0','b')
  s.deliver(s.commands[0].replaceAll('AI_TERM_FILE_','OTHER_FILE_'),'aGVsbG8=\nstatus=0')
  await Promise.resolve()
  assert.deepEqual(s.writes,[])
  s.deliver(s.commands[0],'aGVsbG8=\nstatus=0')
  assert.equal((await download).localPath,'D:/a.txt')
  assert.deepEqual(s.writes,[['D:/a.txt',[104,101,108,108,111],true]])
})

test('terminal output received before a failed write acknowledgement cannot save a file',async t=>{
  let acknowledge
  const s=setup(t,{write:()=>new Promise(resolve=>acknowledge=resolve)})
  const download=s.state.download('/srv/a.txt','D:/a.txt',binding(),new AbortController().signal)
  const failed=assert.rejects(download,/发送失败/)
  await until(()=>acknowledge)
  s.deliver(s.commands[0],'aGVsbG8=\nstatus=0')
  await Promise.resolve();await Promise.resolve()
  assert.deepEqual(s.writes,[])
  acknowledge(false);await failed
  assert.deepEqual(s.interrupts,[])
})

test('terminal transfer refuses concurrent commands, non-idle prompts and oversized uploads',async t=>{
  const s=setup(t)
  const first=s.state.download('/srv/a.txt','D:/a.txt',binding(),new AbortController().signal)
  await assert.rejects(s.state.download('/srv/b.txt','D:/b.txt',binding(),new AbortController().signal),/已有文件传输/)
  await until(()=>s.commands.length===1);s.deliver(s.commands[0],'\nstatus=0');await first
  const busy=setup(t,{readiness:'line-busy'})
  await assert.rejects(busy.state.download('/srv/a.txt','D:/a.txt',binding(),new AbortController().signal),/空闲提示符/)
  await assert.rejects(s.state.upload(new File([new Uint8Array(INLINE_TRANSFER_LIMIT+1)],'large'),'/srv/large',binding(),new AbortController().signal),/700 KB/)
  assert.deepEqual(busy.commands,[])
})

test('a terminal transfer waits for the prompt that follows a preceding identity or file marker',async t=>{
  const options={readiness:'shell-busy'},s=setup(t,options)
  const download=s.state.download('/srv/a.txt','D:/a.txt',binding(),new AbortController().signal)
  await new Promise(resolve=>setTimeout(resolve,5))
  assert.deepEqual(s.commands,[])
  options.readiness='ready'
  await until(()=>s.commands.length===1)
  s.deliver(s.commands[0],'aGVsbG8=\nstatus=0')
  await download
  assert.equal(s.writes.length,1)
})

test('a timed-out prompt wait cannot dispatch a late command after the terminal becomes ready',async t=>{
  const options={readiness:'shell-busy',timeout:10},s=setup(t,options)
  await assert.rejects(s.state.download('/srv/a.txt','D:/a.txt',binding(),new AbortController().signal),/超时/)
  options.readiness='ready'
  await new Promise(resolve=>setTimeout(resolve,25))
  assert.deepEqual(s.commands,[])
  assert.deepEqual(s.interrupts,[])
})

test('unmount cancels a pending download and prevents later writes or interrupts',async t=>{
  const s=setup(t)
  const download=s.state.download('/srv/a.txt','D:/a.txt',binding(),new AbortController().signal)
  const stopped=assert.rejects(download,/取消|断开/)
  await until(()=>s.commands.length===1)
  s.unmount();await stopped
  s.deliver(s.commands[0],'aGVsbG8=\nstatus=0')
  assert.deepEqual(s.writes,[]);assert.deepEqual(s.interrupts,[])
})

function availableShell() {
  if(process.platform!=='win32') return existsSync('/bin/bash')?'/bin/bash':undefined
  const gitPaths=spawnSync('where.exe',['git'],{encoding:'utf8',windowsHide:true}).stdout??''
  return gitPaths.trim().split(/\r?\n/).map(path=>join(dirname(dirname(path)),'bin','bash.exe')).find(existsSync)
}
const shell=availableShell()

function shellSetup(t,extra='') {
  const temporaryRoot=realpathSync(tmpdir()),prefix='ai-term-terminal-transfer-test-'
  const directory=mkdtempSync(join(temporaryRoot,prefix))
  t.after(()=>{
    const target=realpathSync(directory)
    assert.equal(dirname(target),temporaryRoot)
    assert.ok(basename(target).startsWith(prefix))
    rmSync(target,{recursive:true,force:true})
  })
  const writes=[]
  let transfer,sequence=0
  const identity=`PATH="/usr/bin:$PATH"\nid() { printf deploy; }; hostname() { printf app; }; cat() { if [ "$1" = /etc/machine-id ]; then printf 0123456789abcdef; else command cat "$@"; fi; }\n`
  const bridge={readiness:()=> 'ready',write:command=>{
    const result=spawnSync(shell,['--noprofile','--norc'],{cwd:directory,input:identity+extra+'\n'+command,encoding:'utf8',timeout:5_000,windowsHide:true})
    assert.ifError(result.error)
    assert.equal(result.status,0,result.stderr)
    transfer.feedOutput({terminalId:'a',sequence:++sequence,delta:result.stdout,snapshot:result.stdout})
    return true
  }}
  const {state}=mountComposable(t,()=>useTerminalFileTransfer({bridge:()=>bridge,generation:()=>1,timeoutMs:6_000},{writeFile:async(...args)=>writes.push(args)}))
  transfer=state
  return {state,directory,writes}
}

test('generated terminal commands round-trip binary data and quoted paths through a real shell',{skip:!shell},async t=>{
  const s=shellSetup(t),bytes=Uint8Array.from([0,255,13,10,39,34,92,100]),name="a ' quoted.txt"
  await s.state.upload(new File([bytes],name),`./${name}`,binding(),new AbortController().signal)
  assert.deepEqual(readFileSync(join(s.directory,name)),Buffer.from(bytes))
  assert.deepEqual(readdirSync(s.directory),[name])
  await s.state.download(`./${name}`,'local-result',binding(),new AbortController().signal)
  assert.deepEqual(s.writes,[['local-result',Array.from(bytes),false]])
})

for(const [name,extra] of [
  ['changed server account','id() { printf root; }'],
  ['failed base64 decoding','base64() { printf partial; return 1; }'],
]) test(`generated upload preserves the destination and removes temporary files on ${name}`,{skip:!shell},async t=>{
  const s=shellSetup(t,extra)
  writeFileSync(join(s.directory,'existing.txt'),'original')
  await assert.rejects(s.state.upload(new File(['replacement'],'existing.txt'),'./existing.txt',binding(),new AbortController().signal),/传输失败/)
  assert.equal(readFileSync(join(s.directory,'existing.txt'),'utf8'),'original')
  assert.deepEqual(readdirSync(s.directory),['existing.txt'])
})
