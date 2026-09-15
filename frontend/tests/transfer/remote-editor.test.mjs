import assert from 'node:assert/strict'
import test from 'node:test'
import { ref } from 'vue'
import { mountComposable } from '../helpers/lifecycle.mjs'
import { useRemoteFileEditor } from '../../src/domains/transfer/application/useRemoteFileEditor'

function setup(t, hooks={}) {
  const props={connectionId:'a',terminalConnectionGeneration:1}
  let target={targetHost:'10.0.0.1',targetUsername:'deploy',...(hooks.profileRoute===undefined?{}:{profileRoute:hooks.profileRoute})},epoch=1,key='terminal-a',ready=true
  const writes=[],refreshes=[]
  const {state,unmount}=mountComposable(t,()=>useRemoteFileEditor({props,currentPath:ref('/srv'),status:ref(''),error:ref(''),remoteReady:()=>ready,remoteBusy:()=>false,remoteRequestEpoch:()=>epoch,transferStateKey:()=>key,targetOverride:()=>target,isCurrentRemoteRequest:(e,k,g)=>e===epoch&&k===key&&g===props.terminalConnectionGeneration,invalidateRemoteDirectoryCache:()=>{},loadDirectory:async path=>refreshes.push(path),verifyBeforeWrite:hooks.verify,onTargetChanged:hooks.targetChanged},
    {sftpReadTextFile:hooks.read??(async(_,path)=>({path,content:'original',revision:'rev-a'})),sftpSaveTextFile:async(...args)=>{writes.push(args);return hooks.save?hooks.save(...args):{path:args[1],content:args[2],revision:'rev-b'}}}))
  return {state,props,writes,refreshes,unmount,changeTarget:()=>{target={targetHost:'10.0.0.2',targetUsername:'root'}},changeRoute:route=>target={...target,profileRoute:route},invalidate:()=>epoch++,disconnect:()=>ready=false,changeKey:()=>key='terminal-b'}
}
const entry={name:'app.conf',path:'/srv/app.conf',isDir:false,size:10}

for(const change of ['connection','generation','target','epoch','disconnect','state-key']) test(`editor blocks a changed ${change} and preserves the draft`,async t=>{
  const s=setup(t);await s.state.openRemoteFileEditor(entry);s.state.remoteEditor.value.content='draft'
  if(change==='connection')s.props.connectionId='b'
  if(change==='generation')s.props.terminalConnectionGeneration++
  if(change==='target')s.changeTarget()
  if(change==='epoch')s.invalidate()
  if(change==='disconnect')s.disconnect()
  if(change==='state-key')s.changeKey()
  await s.state.saveRemoteFileEditor()
  assert.equal(s.writes.length,0)
  assert.equal(s.state.remoteEditor.value.content,'draft')
  assert.match(s.state.remoteEditor.value.error,/变化|停止/)
})

test('a pending read remains attached to its original server after switching',async t=>{
  let finish;const s=setup(t,{read:()=>new Promise(resolve=>finish=resolve)})
  const open=s.state.openRemoteFileEditor(entry);s.changeTarget();finish({path:entry.path,content:'server-a-content',revision:'a'});await open
  assert.equal(s.state.remoteEditor.value.target.override.targetHost,'10.0.0.1')
  assert.equal(s.state.remoteEditor.value.content,'server-a-content')
  assert.equal(s.state.remoteEditor.value.loading,false)
})

test('target changes while verifying block the eventual write',async t=>{
  let finish;const s=setup(t,{verify:()=>new Promise(resolve=>finish=resolve)})
  await s.state.openRemoteFileEditor(entry);s.state.remoteEditor.value.content='draft'
  const save=s.state.saveRemoteFileEditor();s.changeTarget();finish();await save
  assert.equal(s.writes.length,0)
  assert.equal(s.state.remoteEditor.value.content,'draft')
})

test('a dispatched save uses the captured destination and never refreshes a new target',async t=>{
  let finish;const s=setup(t,{save:()=>new Promise(resolve=>finish=resolve)})
  await s.state.openRemoteFileEditor(entry);s.state.remoteEditor.value.content='draft'
  const save=s.state.saveRemoteFileEditor();await Promise.resolve();s.changeTarget();finish({path:entry.path,content:'draft',revision:'b'});await save
  assert.equal(s.writes[0][0],'a')
  assert.deepEqual(s.writes[0][5],{targetHost:'10.0.0.1',targetUsername:'deploy'})
  assert.deepEqual(s.refreshes,[])
})

test('closing the owning session during verification prevents a later save dispatch',async t=>{
  let finish;const s=setup(t,{verify:()=>new Promise(resolve=>finish=resolve)})
  await s.state.openRemoteFileEditor(entry);s.state.remoteEditor.value.content='draft'
  const save=s.state.saveRemoteFileEditor()
  s.unmount();finish();await save
  assert.equal(s.writes.length,0)
})

test('edits made during an outstanding save remain an unsaved draft',async t=>{
  let finish;const s=setup(t,{save:()=>new Promise(resolve=>finish=resolve)})
  await s.state.openRemoteFileEditor(entry);s.state.remoteEditor.value.content='submitted'
  const save=s.state.saveRemoteFileEditor();await Promise.resolve()
  s.state.remoteEditor.value.content='newer draft'
  finish({path:entry.path,content:'submitted',revision:'b'});await save
  assert.equal(s.state.remoteEditor.value.content,'newer draft')
  assert.equal(s.state.remoteEditor.value.savedContent,'submitted')
  assert.equal(s.state.remoteEditorDirty.value,true)
})

test('editor saves carry the original routing contract and a changed route preserves the draft',async t=>{
  const s=setup(t,{profileRoute:'original-route'})
  await s.state.openRemoteFileEditor(entry)
  s.state.remoteEditor.value.content='first edit'
  await s.state.saveRemoteFileEditor()
  assert.equal(s.writes[0][5].profileRoute,'original-route')
  s.changeRoute('other-route')
  s.state.remoteEditor.value.content='retained draft'
  await s.state.saveRemoteFileEditor()
  assert.equal(s.writes.length,1)
  assert.equal(s.state.remoteEditor.value.target.override.profileRoute,'original-route')
  assert.equal(s.state.remoteEditor.value.content,'retained draft')
})

test('a backend routing rejection invalidates the current editor target and keeps the draft',async t=>{
  const rejected=[]
  let s
  s=setup(t,{targetChanged:reason=>{rejected.push(reason);s.disconnect()},save:async()=>{throw Error('SFTP_TARGET_CHANGED: connection routing changed')}})
  await s.state.openRemoteFileEditor(entry)
  s.state.remoteEditor.value.content='retained draft'
  await s.state.saveRemoteFileEditor()
  assert.match(rejected[0],/SFTP_TARGET_CHANGED/)
  assert.equal(s.state.remoteEditorTargetChanged.value,true)
  assert.equal(s.state.remoteEditor.value.content,'retained draft')
  assert.match(s.state.remoteEditor.value.error,/连接配置.*变化/)
  await s.state.saveRemoteFileEditor()
  assert.equal(s.writes.length,1)
})

test('routing rejection during file read invalidates only its current target',async t=>{
  let rejected=0,s
  s=setup(t,{targetChanged:()=>{rejected++;s.disconnect()},read:async()=>{throw Error('SFTP_TARGET_CHANGED: changed')}})
  await s.state.openRemoteFileEditor(entry)
  assert.equal(rejected,1)
  assert.equal(s.state.remoteEditor.value.loading,false)
  assert.equal(s.state.remoteEditorTargetChanged.value,true)
})

test('a late routing rejection from an old save cannot invalidate a newer target',async t=>{
  let fail,rejected=0
  const s=setup(t,{targetChanged:()=>rejected++,save:()=>new Promise((_,reject)=>fail=reject)})
  await s.state.openRemoteFileEditor(entry);s.state.remoteEditor.value.content='draft'
  const save=s.state.saveRemoteFileEditor();await Promise.resolve()
  s.changeTarget();fail(Error('SFTP_TARGET_CHANGED: changed'));await save
  assert.equal(rejected,0)
  assert.equal(s.state.remoteEditor.value.content,'draft')
})
