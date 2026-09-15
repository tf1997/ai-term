import assert from 'node:assert/strict'
import test from 'node:test'
import { createTransferTaskManager } from '../../src/domains/transfer/application/transferTaskManager'

const binding=id=>({terminalId:id,connectionId:id,generation:1,revision:1,serverKey:id,host:`host-${id}`,username:'deploy',label:`deploy@host-${id}`,source:'configured',override:{targetHost:`host-${id}`,targetUsername:'deploy'}})
const waitUntil=async predicate=>{for(let i=0;i<100;i++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,1))}throw Error('condition did not become true')}

test('concurrent server tasks keep immutable ownership and results after changing the viewed session',async()=>{
  const finishes={},progress={}
  const manager=createTransferTaskManager({cancel:async()=>true,listen:async(id,fn)=>{progress[id]=fn;return()=>delete progress[id]}})
  const a=binding('a')
  const first=manager.enqueue({binding:a,direction:'upload',itemName:'a.txt',sourcePath:'D:/a.txt',targetPath:'/srv/a.txt',execute:()=>new Promise(resolve=>finishes.a=resolve)})
  a.host='host-b';a.override.targetHost='host-b'
  const second=manager.enqueue({binding:binding('b'),direction:'download',itemName:'b.txt',sourcePath:'/srv/b.txt',targetPath:'D:/b.txt',execute:()=>new Promise(resolve=>finishes.b=resolve)})
  await waitUntil(()=>finishes.a&&finishes.b)
  progress[first.id]({taskId:first.id,percent:60})
  assert.equal(manager.jobs.value[0].binding.host,'host-a')
  assert.equal(manager.jobs.value[0].binding.override.targetHost,'host-a')
  assert.equal(manager.jobs.value[0].progressPercent,60)
  finishes.b({message:'done',localPath:'D:/b.txt'});finishes.a({message:'done',remotePath:'/srv/a.txt'})
  assert.equal((await first.completed).binding.terminalId,'a')
  assert.equal((await second.completed).binding.terminalId,'b')
  assert.equal(manager.activeCount.value,0)
})

test('queued items preserve order and cancellation of one task never cancels another server',async()=>{
  const events=[],cancelled=[],resolvers=[]
  const manager=createTransferTaskManager({cancel:async id=>{cancelled.push(id);return true},listen:async()=>()=>{}})
  const request=name=>({binding:binding('a'),direction:'upload',itemName:name,sourcePath:name,targetPath:`/srv/${name}`,execute:()=>{events.push(name);return new Promise(resolve=>resolvers.push(resolve))}})
  const a=manager.enqueue(request('one')),b=manager.enqueue(request('two')),c=manager.enqueue({...request('three'),binding:binding('b')})
  await waitUntil(()=>events.length===2)
  assert.deepEqual(events,['one','three'])
  await manager.cancel(b.id);assert.equal((await b.completed).status,'cancelled')
  await manager.cancel(a.id);assert.equal((await a.completed).status,'cancelled')
  assert.ok(cancelled.every(id=>id===a.id))
  assert.equal(cancelled.length,1)
  resolvers[1]({message:'done'});assert.equal((await c.completed).status,'done')
  resolvers[0]({message:'late'});await Promise.resolve()
  assert.equal(manager.jobs.value.find(job=>job.id===a.id).status,'cancelled')
})

test('cancellation while subscribing stops dispatch and cleans up a late listener',async()=>{
  let subscribe,stopped=false,executed=false
  const manager=createTransferTaskManager({cancel:async()=>true,listen:()=>new Promise(resolve=>subscribe=resolve)})
  const ticket=manager.enqueue({binding:binding('a'),direction:'upload',itemName:'x',sourcePath:'x',targetPath:'/x',execute:async()=>{executed=true;return{message:'done'}}})
  await waitUntil(()=>subscribe);await manager.cancel(ticket.id)
  assert.equal((await ticket.completed).status,'cancelled')
  subscribe(()=>{stopped=true});await waitUntil(()=>stopped)
  assert.equal(executed,false)
})

test('subscription timeout settles a queued task and disposes a listener that arrives afterwards',async()=>{
  let subscribe,stopped=0,executed=false
  const manager=createTransferTaskManager({cancel:async()=>true,listen:()=>new Promise(resolve=>subscribe=resolve)},{subscription:10,transfer:100})
  const ticket=manager.enqueue({binding:binding('a'),direction:'upload',itemName:'x',sourcePath:'x',targetPath:'/x',execute:async()=>{executed=true;return{message:'done'}}})
  assert.equal((await ticket.completed).status,'error')
  subscribe(()=>stopped++)
  await waitUntil(()=>stopped===1)
  assert.equal(executed,false)
  assert.equal(manager.activeCount.value,0)
})

test('a queued task captures nested identity and paths before the original request is edited',async()=>{
  let finish
  const manager=createTransferTaskManager({cancel:async()=>true,listen:async()=>()=>{}})
  const target=binding('a');target.identity={username:'deploy',hostname:'a',machine:'machine-a',ips:['10.0.0.1'],pwd:'/srv'}
  const running=manager.enqueue({binding:target,direction:'upload',itemName:'first',sourcePath:'D:/first',targetPath:'/srv/first',execute:()=>new Promise(resolve=>finish=resolve)})
  const request={binding:target,direction:'upload',itemName:'queued',sourcePath:'D:/original',targetPath:'/srv/original',execute:async()=>({message:'done'})}
  const queued=manager.enqueue(request)
  request.sourcePath='D:/other';request.targetPath='/other';target.identity.ips[0]='10.0.0.2';target.identity.username='root'
  const job=manager.jobs.value.find(job=>job.id===queued.id)
  assert.equal(job.status,'queued')
  assert.equal(job.sourcePath,'D:/original');assert.equal(job.targetPath,'/srv/original')
  assert.deepEqual(job.binding.identity.ips,['10.0.0.1'])
  assert.equal(job.binding.identity.username,'deploy')
  assert.ok(Object.isFrozen(job.binding));assert.ok(Object.isFrozen(job.binding.identity.ips))
  await waitUntil(()=>finish);finish({message:'done'})
  await running.completed;assert.equal((await queued.completed).status,'done')
})

test('closing a terminal only cancels its terminal-stream jobs while SFTP jobs continue',async()=>{
  let finishSftp
  const manager=createTransferTaskManager({cancel:async()=>true,listen:async()=>()=>{}})
  const a=manager.enqueue({binding:binding('a'),mode:'terminal',direction:'upload',itemName:'terminal',sourcePath:'x',targetPath:'/x',execute:()=>new Promise(()=>{})})
  const queued=manager.enqueue({binding:binding('a'),mode:'terminal',direction:'upload',itemName:'queued',sourcePath:'x',targetPath:'/x',execute:async()=>({message:'done'})})
  const sftp=manager.enqueue({binding:binding('a'),direction:'upload',itemName:'sftp',sourcePath:'x',targetPath:'/x',execute:()=>new Promise(resolve=>finishSftp=resolve)})
  await waitUntil(()=>finishSftp)
  manager.cancelTerminal('a')
  assert.equal((await a.completed).status,'cancelled')
  assert.equal((await queued.completed).status,'cancelled')
  assert.equal(manager.jobs.value.find(job=>job.id===sftp.id).status,'running')
  finishSftp({message:'done'});assert.equal((await sftp.completed).status,'done')
})

test('progress from another task and non-finite percentages cannot change the active job',async()=>{
  let progress,finish
  const manager=createTransferTaskManager({cancel:async()=>true,listen:async(_,fn)=>{progress=fn;return()=>{}}})
  const ticket=manager.enqueue({binding:binding('a'),direction:'upload',itemName:'x',sourcePath:'x',targetPath:'/x',execute:()=>new Promise(resolve=>finish=resolve)})
  await waitUntil(()=>finish)
  progress({taskId:ticket.id,percent:40})
  progress({taskId:'other',percent:80})
  progress({taskId:ticket.id,percent:NaN})
  assert.equal(manager.jobs.value[0].progressPercent,40)
  finish({message:'done'});await ticket.completed
})

test('transfer deadlines abort the executor, cancel the backend once and retain the timeout error',async()=>{
  let signal,unsubscribed=0
  const cancelled=[]
  const manager=createTransferTaskManager({cancel:async id=>{cancelled.push(id);return true},listen:async()=>()=>unsubscribed++},{subscription:100,transfer:10})
  const ticket=manager.enqueue({binding:binding('a'),direction:'upload',itemName:'x',sourcePath:'x',targetPath:'/x',execute:(_,current)=>{signal=current;return new Promise(()=>{})}})
  const job=await ticket.completed
  assert.equal(job.status,'error')
  assert.match(job.progressText,/超时/)
  assert.equal(signal.aborted,true)
  assert.deepEqual(cancelled,[ticket.id])
  assert.equal(unsubscribed,1)
})

test('a failing event-listener cleanup does not strand task completion or the next queued item',async()=>{
  const manager=createTransferTaskManager({cancel:async()=>true,listen:async()=>()=>{throw Error('listener closed')}})
  const request={binding:binding('a'),direction:'upload',itemName:'x',sourcePath:'x',targetPath:'/x',execute:async()=>({message:'done'})}
  const first=manager.enqueue(request),second=manager.enqueue(request)
  assert.equal((await first.completed).status,'done')
  assert.equal((await second.completed).status,'done')
  assert.equal(manager.activeCount.value,0)
})
