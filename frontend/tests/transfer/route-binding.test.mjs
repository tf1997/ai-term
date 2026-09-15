import assert from 'node:assert/strict'
import test from 'node:test'
import { webcrypto } from 'node:crypto'
import { captureFileTarget, sftpProfileRoute } from '../../src/domains/transfer/domain/fileSession'
import { createTransferTaskManager } from '../../src/domains/transfer/application/transferTaskManager'
import * as api from '../../src/domains/transfer/infrastructure/api'

const profile=()=>({id:'server',name:'Server',connectionRole:'bastion',jumpMode:'direct',fileTransferMode:'auto',menuProfileId:'',target:{host:' 10.0.0.1 ',port:22,username:' deploy ',password:'private-target-password'},gateway:{host:' gateway.example ',port:2200,username:' jump ',password:'private-gateway-password'}})
const until=async predicate=>{for(let i=0;i<100;i++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,1))}throw Error('condition did not become true')}

function ipc(t,handler) {
  const previous=globalThis.window
  globalThis.window={crypto:webcrypto,__TAURI_IPC__:message=>handler(message,value=>window[`_${message.callback}`](value),error=>window[`_${message.error}`](error))}
  t.after(()=>{if(previous===undefined) delete globalThis.window;else globalThis.window=previous})
}

test('routing contracts identify endpoints and route modes without retaining passwords',()=>{
  const original=profile(),route=sftpProfileRoute(original)
  assert.deepEqual(JSON.parse(route),['sftp-profile-route-v1','server','bastion','direct','auto','',['10.0.0.1',22,'deploy'],['gateway.example',2200,'jump']])
  assert.equal(route.includes('private-target-password'),false)
  assert.equal(route.includes('private-gateway-password'),false)
  const passwordChange=profile();passwordChange.target.password='rotated'
  assert.equal(sftpProfileRoute(passwordChange),route)
  for(const change of [value=>value.target.port=2222,value=>value.gateway.host='other-gateway',value=>value.gateway.username='other-account',value=>value.fileTransferMode='sftp-direct']) {
    const edited=profile();change(edited)
    assert.notEqual(sftpProfileRoute(edited),route)
  }
})

test('all SFTP RPCs preserve the captured route alongside their host and account',async t=>{
  const requests=[],target={targetHost:'10.0.0.1',targetUsername:'deploy',profileRoute:sftpProfileRoute(profile())}
  ipc(t,(message,resolve)=>{requests.push(message);resolve({available:true,message:'ok',path:'/srv',content:'text',revision:'r',entries:[]})})
  await Promise.all([
    api.sftpProbe('server',target),
    api.sftpListDirectory('server','/srv',target),
    api.sftpCreateDirectory('server','/srv/new',target),
    api.sftpDeletePath('server','/srv/old',false,target),
    api.sftpUploadFile('server','D:/a','/srv',target),
    api.sftpUploadPath('server','D:/a','/srv',target),
    api.sftpDownloadFile('server','/srv/a','D:/a',target),
    api.sftpDownloadPath('server','/srv/a','D:/',false,target),
    api.sftpReadTextFile('server','/srv/a',target),
    api.sftpSaveTextFile('server','/srv/a','text','r',false,target),
  ])
  assert.equal(requests.length,10)
  for(const request of requests) {
    assert.equal(request.connectionId,'server')
    assert.equal(request.targetHost,'10.0.0.1')
    assert.equal(request.targetUsername,'deploy')
    assert.equal(request.profileRoute,target.profileRoute,request.cmd)
  }
})

test('a queued upload retains its routing contract and an edited gateway cannot receive it',async t=>{
  const stored=profile(),original=sftpProfileRoute(stored),allowed=[],requests=[]
  let releaseFirst
  ipc(t,(message,resolve,reject)=>{
    requests.push(message)
    if(message.profileRoute!==sftpProfileRoute(stored)) {
      reject('SFTP_TARGET_CHANGED: connection routing changed')
      return
    }
    allowed.push(message)
    if(!releaseFirst) releaseFirst=()=>resolve({message:'done'})
    else resolve({message:'done'})
  })
  const target=captureFileTarget({terminalId:'a',connectionId:'server',generation:1,revision:1,serverKey:'server/deploy',host:'10.0.0.1',username:'deploy',label:'deploy@10.0.0.1',source:'configured',override:{targetHost:'10.0.0.1',targetUsername:'deploy',profileRoute:original}})
  const manager=createTransferTaskManager({cancel:async()=>true,listen:async()=>()=>{}})
  const request=name=>({binding:target,direction:'upload',itemName:name,sourcePath:`D:/${name}`,targetPath:`/srv/${name}`,execute:id=>api.sftpUploadPath(target.connectionId,`D:/${name}`,'/srv',target.override,{taskId:id})})
  const first=manager.enqueue(request('first')),queued=manager.enqueue(request('queued'))
  await until(()=>releaseFirst)
  stored.gateway.host='different-gateway.example'
  releaseFirst()
  assert.equal((await first.completed).status,'done')
  const rejected=await queued.completed
  assert.equal(rejected.status,'error')
  assert.match(rejected.progressText,/连接配置.*变化/)
  assert.equal(rejected.progressText.includes('SFTP_TARGET_CHANGED'),false)
  assert.equal(allowed.length,1)
  assert.equal(requests.length,2)
  assert.equal(requests[1].profileRoute,original)
  assert.equal(manager.activeCount.value,0)
})
