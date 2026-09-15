import assert from 'node:assert/strict'
import test from 'node:test'
import { nextTick, ref } from 'vue'
import { mountComposable } from '../helpers/lifecycle.mjs'
import { parseTerminalIdentitySnapshot, usableIpCandidates } from '../../src/domains/transfer/domain/terminalIdentity'
import { useSftpConnection } from '../../src/domains/transfer/application/useSftpConnection'
import { sftpProfileRoute } from '../../src/domains/transfer/domain/fileSession'

function setup(t, config = {}) {
  const context = ref({ terminalId: 'a', connectionId: 'bastion', generation: 1, contextVersion: 0, status: 'remote', profile: { id: 'bastion', connectionRole: 'bastion', fileTransferMode: 'auto', target: {host:'gateway', username:'gateway-user'}, gateway:{host:'gateway'} } })
  const calls = [], cancels = [], commands = [], remembered = new Map()
  let connection, lastCommand = '', eventSequence = 0, ips = config.ips ?? '10.20.0.17 172.20.0.17'
  function deliver(command = lastCommand, values = {}) {
    const begin = command.match(/AI_TERM_IDENT_BEGIN_[A-Za-z0-9_]+/)?.[0]
    const end = command.match(/AI_TERM_IDENT_END_[A-Za-z0-9_]+/)?.[0]
    const output = `${begin}\nuser=${values.user ?? 'deploy'}\nhostname=app\nips=${values.ips ?? ips}\npwd=/srv/app\nmachine=0123456789abcdef0123456789abcdef\n${end}\n`
    connection.feedOutput({terminalId:'a',sequence:++eventSequence,delta:output,snapshot:output})
  }
  const bridge = {readiness:()=>config.readiness ?? 'ready', write:command=>{
    lastCommand=command
    commands.push(command)
    if(config.write) return config.write(command, deliver)
    if(config.writeError) throw new Error('socket closed')
    if(config.send===false) return false
    if(!config.noOutput) queueMicrotask(()=>deliver(command))
    return true
  }}
  const {state,unmount} = mountComposable(t, () => useSftpConnection({
    context:()=>context.value, bridge:()=>bridge,
    profileRoute:config.profileRoute,
    preferredHost:key=>remembered.get(key), rememberHost:(key,host)=>remembered.set(key,host),
    timeouts:config.timeouts ?? {identity:100,candidate:100,total:500},
    source:{probe:async(id,target,options)=>{calls.push({id,...target,...options}); return config.probe ? config.probe(target,calls.length,options) : {available:true,path:'/home/deploy',message:'ok'}},cancel:async id=>{cancels.push(id);return true}}
  }))
  connection=state
  return {connection,context,calls,cancels,commands,remembered,deliver,unmount,setIps:value=>ips=value,getCommand:()=>lastCommand}
}
const until=async predicate=>{for(let i=0;i<100;i++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,1))}throw Error('condition did not become true')}

test('candidate parser filters all invalid address families and canonicalizes duplicates', () => {
  assert.deepEqual(usableIpCandidates('127.0.0.1 127.0.1.1 0.0.0.0 169.254.2.3 224.1.2.3 255.255.255.255 999.1.2.3 010.2.3.4 :: ::1 fe80::1 ff02::1 ::ffff:127.0.0.2 10.20.0.17 10.20.0.17/24 2001:0db8::1 2001:db8::1 ::ffff:10.20.0.18'),
    ['10.20.0.17','2001:db8::1','10.20.0.18'])
})

test('identity parser requires its own complete output and does not read addresses from echo or paths', () => {
  const pending={begin:'AI_TERM_IDENT_BEGIN_123_abc',end:'AI_TERM_IDENT_END_123_abc'}
  assert.equal(parseTerminalIdentitySnapshot("printf 'AI_TERM_IDENT_BEGIN_123_abc'; ips=10.0.0.1; printf 'AI_TERM_IDENT_END_123_abc'",pending).complete,false)
  assert.equal(parseTerminalIdentitySnapshot(`${pending.begin}\nuser=deploy\nips=10.0.0.1`,pending).complete,false)
  const result=parseTerminalIdentitySnapshot(`${pending.begin}\nuser=deploy\nhostname=app\nips=\npwd=/tmp/10.0.0.1/user=data's\n${pending.end}`,pending)
  assert.equal(result.complete,true)
  assert.deepEqual(result.ips,[])
  assert.equal(result.values.pwd,"/tmp/10.0.0.1/user=data's")
})

test('second IP succeeds and becomes the preferred address on the next detection', async t => {
  const s=setup(t,{probe:target=>target.targetHost==='10.20.0.17'?{available:false,message:'connection refused'}:{available:true,path:'/',message:'ok'}})
  const target=await s.connection.connect()
  assert.equal(target.host,'172.20.0.17')
  assert.deepEqual(s.calls.map(x=>x.targetHost),['10.20.0.17','172.20.0.17'])
  assert.equal(s.connection.failures.value[0].kind,'network')
  await s.connection.connect()
  assert.equal(s.calls[2].targetHost,'172.20.0.17')
})

test('authentication and host-key failures retain their own causes', async t => {
  const s=setup(t,{probe:(_,n)=>({available:false,message:n===1?'authentication failed':'host key verification failed'})})
  assert.equal(await s.connection.connect(),null)
  assert.deepEqual(s.connection.failures.value.map(x=>x.kind),['authentication','host-key'])
  assert.equal(s.connection.phase.value,'error')
  assert.equal(s.connection.busy.value,false)
})

test('candidate timeout cancels the backend attempt then proceeds to the second IP', async t => {
  const s=setup(t,{timeouts:{identity:100,candidate:10,total:500},probe:(_,n)=>n===1?new Promise(()=>{}):{available:true,path:'/',message:'ok'}})
  assert.equal((await s.connection.connect()).host,'172.20.0.17')
  assert.equal(s.cancels[0],s.calls[0].taskId)
  assert.equal(s.connection.failures.value[0].kind,'timeout')
})

for(const config of [{noOutput:true},{send:false},{writeError:true},{readiness:'shell-busy'},{readiness:'line-busy'},{readiness:'unavailable'},{ips:''}]) {
  test(`identity failure returns to a retryable state: ${JSON.stringify(config)}`,async t=>{
    const s=setup(t,{...config,timeouts:{identity:10,candidate:50,total:100}})
    assert.equal(await s.connection.connect(),null)
    assert.equal(s.connection.phase.value,'error')
    assert.equal(s.connection.busy.value,false)
    assert.equal(s.calls.length,0)
    assert.ok(s.connection.error.value)
  })
}

test('cancelled or timed-out identity output cannot start a late connection',async t=>{
  const s=setup(t,{noOutput:true,timeouts:{identity:20,candidate:50,total:100}})
  const operation=s.connection.connect()
  await new Promise(resolve=>setTimeout(resolve,1))
  const command=s.getCommand()
  s.connection.cancel()
  await operation
  s.deliver(command)
  await nextTick()
  assert.equal(s.calls.length,0)
  assert.equal(s.connection.phase.value,'cancelled')
})

test('disconnect during a pending probe discards late success',async t=>{
  let finish
  const s=setup(t,{probe:()=>new Promise(resolve=>{finish=resolve})})
  const operation=s.connection.connect()
  while(!finish) await new Promise(resolve=>setTimeout(resolve,1))
  s.context.value.generation+=1
  await nextTick()
  finish({available:true,path:'/',message:'late'})
  await operation
  assert.equal(s.connection.binding.value,null)
  assert.equal(s.connection.phase.value,'stale')
  assert.equal(s.cancels.length,1)
})

test('write verification detects a server change inside the same SSH generation',async t=>{
  const s=setup(t)
  const original=await s.connection.connect()
  s.setIps('192.168.20.4')
  await assert.rejects(s.connection.verifyBeforeWrite(),/服务器|目标/)
  assert.equal(s.connection.binding.value,null)
  assert.equal(original.host,'10.20.0.17')
})

test('total connection budget includes identification and bounds later candidate attempts',async t=>{
  const s=setup(t,{ips:'10.0.0.1 10.0.0.2 10.0.0.3',timeouts:{identity:100,candidate:25,total:40},probe:()=>new Promise(()=>{})})
  assert.equal(await s.connection.connect(),null)
  assert.ok(s.calls.length<=2)
  assert.ok(s.calls.every(call=>call.timeoutMs<=25))
  assert.equal(s.connection.busy.value,false)
})

test('simultaneous identity requests reserve the terminal before either command is sent',async t=>{
  const s=setup(t,{noOutput:true})
  const first=s.connection.readIdentity(new AbortController().signal)
  await assert.rejects(s.connection.readIdentity(new AbortController().signal),/正在核对/)
  await until(()=>s.commands.length===1)
  s.deliver()
  assert.equal((await first).username,'deploy')
  assert.equal(s.commands.length,1)
})

test('identity output is not accepted until the asynchronous terminal write succeeds',async t=>{
  let acknowledge
  const s=setup(t,{write:()=>new Promise(resolve=>acknowledge=resolve)})
  const operation=s.connection.connect()
  await until(()=>acknowledge)
  s.deliver()
  await Promise.resolve();await Promise.resolve()
  assert.equal(s.calls.length,0)
  acknowledge(false)
  assert.equal(await operation,null)
  assert.match(s.connection.error.value,/发送失败/)
})

test('cancel and retry in the same turn ignores old identity output and permits a new request',async t=>{
  const s=setup(t,{noOutput:true})
  const first=s.connection.connect()
  await until(()=>s.commands.length===1)
  s.connection.cancel()
  const retry=s.connection.connect()
  await until(()=>s.commands.length===2)
  s.deliver(s.commands[0])
  assert.equal(s.calls.length,0)
  s.deliver(s.commands[1])
  assert.equal(await first,null)
  assert.equal((await retry).host,'10.20.0.17')
})

test('a cancelled write verification cannot invalidate a newer manual connection',async t=>{
  const config={noOutput:false},s=setup(t,config)
  await s.connection.connect()
  config.noOutput=true
  const verification=s.connection.verifyBeforeWrite()
  const rejected=assert.rejects(verification,/取消|变化/)
  await until(()=>s.commands.length===2)
  const target=await s.connection.connect({host:'192.168.2.10',username:'root'})
  await rejected
  s.deliver(s.commands[1],{ips:'10.0.0.99',user:'other'})
  assert.equal(s.connection.phase.value,'ready')
  assert.equal(s.connection.binding.value.revision,target.revision)
  assert.equal(s.connection.binding.value.host,'192.168.2.10')
})

test('connection status and transfer mode changes invalidate bindings synchronously',async t=>{
  const s=setup(t)
  await s.connection.connect({host:'192.168.2.10',username:'root'})
  s.context.value.profile.fileTransferMode='sftp-only'
  assert.equal(s.connection.binding.value,null)
  await assert.rejects(s.connection.verifyBeforeWrite(),/目标/)
  await s.connection.connect({host:'192.168.2.10',username:'root'})
  s.context.value.status='idle'
  assert.equal(s.connection.binding.value,null)
  assert.equal(s.connection.phase.value,'stale')
})

test('manual targets reject blank fields and whitespace suffixes without falling back to gateway credentials',async t=>{
  const s=setup(t)
  for(const manual of [{host:'',username:'deploy'},{host:'app',username:''},{host:'app other',username:'deploy'}]) {
    assert.equal(await s.connection.connect(manual),null)
    assert.equal(s.calls.length,0)
    assert.ok(s.connection.error.value)
  }
  assert.equal((await s.connection.connect({host:'app',username:'deploy'})).host,'app')
  assert.equal(s.connection.error.value,'')
})

test('live direct SSH sessions also identify the current nested server and account',async t=>{
  const s=setup(t)
  s.context.value.profile.connectionRole='direct'
  const target=await s.connection.connect()
  assert.equal(target.source,'terminal')
  assert.equal(target.username,'deploy')
  assert.equal(target.host,'10.20.0.17')
})

test('pre-cancelled configured writes and identity calls after unmount never dispatch',async t=>{
  const s=setup(t)
  await s.connection.connect({host:'app',username:'deploy'})
  const controller=new AbortController();controller.abort()
  await assert.rejects(s.connection.verifyBeforeWrite(controller.signal),/取消/)
  s.unmount()
  await assert.rejects(s.connection.readIdentity(new AbortController().signal),/取消/)
  assert.equal(s.commands.length,0)
})

test('the verified routing contract is captured on every candidate and the immutable target',async t=>{
  const s=setup(t,{probe:(target,n)=>n===1?{available:false,message:'connection refused'}:{available:true,message:'ok',profileRoute:target.profileRoute}})
  const original=sftpProfileRoute(s.context.value.profile)
  const target=await s.connection.connect()
  assert.ok(s.calls.every(call=>call.profileRoute===original))
  assert.equal(target.override.profileRoute,original)
  s.context.value.profile.target.port=2222
  assert.equal(target.override.profileRoute,original)
  assert.equal(s.connection.binding.value,null)
})

test('a file-only tab can retain its original backend route despite its presentation mode',async t=>{
  const route=ref(undefined),s=setup(t,{profileRoute:()=>route.value})
  route.value=sftpProfileRoute(s.context.value.profile)
  s.context.value.profile.fileTransferMode='sftp-gateway'
  s.context.value.status='sftp'
  const target=await s.connection.connect({host:'10.0.0.1',username:'deploy'})
  assert.equal(target.override.profileRoute,route.value)
  assert.equal(s.calls[0].profileRoute,route.value)
  assert.equal(s.commands.length,0)
})

test('opening an old task preserves its routing contract and stops when the backend profile changed',async t=>{
  let s
  s=setup(t,{probe:target=>{
    if(target.profileRoute!==sftpProfileRoute(s.context.value.profile))
      throw Error('SFTP_TARGET_CHANGED: connection routing changed')
    return {available:true,message:'ok',profileRoute:target.profileRoute}
  }})
  const original=sftpProfileRoute(s.context.value.profile)
  s.context.value.profile.target.port=2222
  assert.equal(await s.connection.connect({host:'10.0.0.1',username:'deploy',profileRoute:original}),null)
  assert.equal(s.calls[0].profileRoute,original)
  assert.match(s.connection.error.value,/连接配置.*变化/)
  assert.match(s.connection.failures.value[0].message,/SFTP_TARGET_CHANGED/)
  assert.equal(s.connection.failures.value[0].kind,'target-changed')
  assert.equal(s.connection.binding.value,null)
})

test('a changed backend route ends detection before trying more addresses',async t=>{
  const s=setup(t,{probe:()=>({available:true,message:'ok',profileRoute:'different backend route'})})
  assert.equal(await s.connection.connect(),null)
  assert.equal(s.calls.length,1)
  assert.match(s.connection.error.value,/连接配置.*变化/)
})

test('configured and manual directory preferences distinguish target and gateway ports',async t=>{
  const s=setup(t)
  const first=await s.connection.connect({host:'10.0.0.1',username:'deploy'})
  s.context.value.profile.target.port=2222
  const second=await s.connection.connect({host:'10.0.0.1',username:'deploy'})
  s.context.value.profile.gateway.port=2200
  const third=await s.connection.connect({host:'10.0.0.1',username:'deploy'})
  assert.equal(new Set([first.serverKey,second.serverKey,third.serverKey]).size,3)
})
