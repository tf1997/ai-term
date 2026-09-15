import assert from 'node:assert/strict'
import test from 'node:test'
import { nextTick, ref } from 'vue'
import { mountComposable } from '../helpers/lifecycle.mjs'
import { useDirectoryBrowser, DIRECTORY_CACHE_TTL } from '../../src/domains/transfer/application/useDirectoryBrowser'
import { createFileLocations } from '../../src/domains/transfer/application/fileLocations'

const entry=(name,path='/srv')=>({name,path:`${path}/${name}`,isDir:!name.includes('.'),size:10,modified:'1000'})
function setup(t,read) {
  let now=100_000
  const owner=ref('a'),calls=[]
  const {state}=mountComposable(t,()=>useDirectoryBrowser({contextKey:()=>owner.value,now:()=>now,read:async path=>{calls.push(path);return read?read(path):{path,entries:['.env','app','logs','readme.md'].map(name=>entry(name,path))}}}))
  return {state,owner,calls,advance:()=>now+=DIRECTORY_CACHE_TTL+1}
}

test('browser snapshots restore history, path drafts, selection, focus and scroll per server',async t=>{
  const s=setup(t)
  await s.state.load('/srv');await s.state.load('/srv/app')
  s.state.select(s.state.entries.value[1]);s.state.scroll.value=80;s.state.draft.value='/srv/unfinished'
  s.state.sort.value='modified';s.state.descending.value=true
  const a=s.state.snapshot()
  s.owner.value='b';s.state.restore();await s.state.load('/opt')
  s.owner.value='a';s.state.restore(a);await nextTick()
  assert.equal(s.state.path.value,'/srv/app');assert.equal(s.state.draft.value,'/srv/unfinished')
  assert.equal(s.state.scroll.value,80);assert.deepEqual(s.state.selected.value,a.selected)
  assert.equal(s.state.sort.value,'modified');assert.equal(s.state.descending.value,true)
  await s.state.goHistory(-1);assert.equal(s.state.path.value,'/srv')
  await s.state.goHistory(1);assert.equal(s.state.path.value,'/srv/app')
})

test('stale cached listing refreshes in the background without resetting browsing position',async t=>{
  const s=setup(t)
  await s.state.load('/srv');s.state.select(s.state.entries.value[1]);s.state.scroll.value=40;s.state.draft.value='/draft'
  await s.state.refreshIfStale();assert.equal(s.calls.length,1)
  s.advance();await s.state.refreshIfStale()
  assert.equal(s.calls.length,2);assert.equal(s.state.scroll.value,40);assert.equal(s.state.draft.value,'/draft')
  assert.deepEqual(s.state.selected.value,['/srv/app'])
})

test('late listing from another server cannot replace the current directory',async t=>{
  let finish
  const s=setup(t,path=>path==='/old'?new Promise(resolve=>finish=resolve):{path,entries:[entry('new',path)]})
  const old=s.state.load('/old');await Promise.resolve();await Promise.resolve()
  s.owner.value='b';s.state.restore();await s.state.load('/new')
  finish({path:'/old',entries:[entry('old','/old')]});await old
  assert.equal(s.state.path.value,'/new');assert.equal(s.state.entries.value[0].name,'new')
})

test('selection supports ranges and toggles, and filtering does not hide active batch targets',async t=>{
  const s=setup(t);await s.state.load('/srv')
  const [first,second,third]=s.state.visibleEntries.value
  s.state.select(first);s.state.select(third,{shiftKey:true})
  assert.equal(s.state.selectedEntries.value.length,3)
  s.state.select(second,{ctrlKey:true});assert.equal(s.state.selectedEntries.value.length,2)
  s.state.search.value='readme'
  assert.equal(s.state.selectedEntries.value.length,0)
})

test('path pairs, recent folders and bookmarks survive restarting without restoring a connection',()=>{
  const data=new Map(),storage={getItem:key=>data.get(key)??null,setItem:(key,value)=>data.set(key,value)}
  const first=createFileLocations(storage)
  first.remember('server-a/deploy','local','D:/build');first.remember('server-a/deploy','remote','/srv/app')
  first.remember('server-b/root','local','D:/logs');first.remember('server-b/root','remote','/var/log')
  first.toggleBookmark('server-a/deploy','remote','/srv/app');first.savePair('server-a/deploy','发布','D:/build','/srv/app')
  first.rememberHost('server-a/deploy','172.20.0.17')
  const next=createFileLocations(storage)
  assert.equal(next.get('server-a/deploy').local,'D:/build');assert.equal(next.get('server-b/root').local,'D:/logs')
  assert.deepEqual(next.get('server-a/deploy').remoteBookmarks,['/srv/app'])
  assert.equal(next.get('server-a/deploy').pairs[0].remote,'/srv/app')
  assert.equal(next.get('server-a/deploy').preferredHost,'172.20.0.17')
  assert.equal(next.get('server-a/root').remote,'')
  assert.equal('binding' in next.get('server-a/deploy'),false)
})

test('invalid or unavailable preference storage leaves file browsing usable',()=>{
  const broken=createFileLocations({getItem:()=>'{',setItem:()=>{throw new Error('full')}})
  assert.doesNotThrow(()=>broken.remember('server','remote','/srv'))
  assert.equal(broken.get('server').remote,'/srv')
})

test('returning to a pending path starts a fresh read and a late response cannot corrupt its cache',async t=>{
  const finishes=[]
  const s=setup(t,path=>path==='/a'?new Promise(resolve=>finishes.push(resolve)):{path,entries:[]})
  const first=s.state.load('/a')
  await s.state.load('/b')
  const latest=s.state.load('/a')
  assert.equal(finishes.length,2)
  finishes[1]({path:'/a',entries:[entry('latest','/a')]});assert.equal(await latest,true)
  finishes[0]({path:'/a',entries:[entry('stale','/a')]});assert.equal(await first,false)
  await s.state.load('/b');await s.state.load('/a')
  assert.equal(s.state.entries.value[0].name,'latest')
  assert.equal(finishes.length,2)
})

test('an explicit refresh supersedes an older request for the same path',async t=>{
  const finishes=[]
  const s=setup(t,path=>new Promise(resolve=>finishes.push(()=>resolve({path,entries:[entry(`version-${finishes.length}`,path)]}))))
  const old=s.state.load('/srv')
  const refresh=s.state.load('/srv',{force:true})
  assert.equal(finishes.length,2)
  finishes[1]();assert.equal(await refresh,true)
  finishes[0]();assert.equal(await old,false)
  assert.equal(s.state.loading.value,false)
})

test('invalidation discards a pending listing so it cannot repopulate a stale cache',async t=>{
  let finish,calls=0
  const s=setup(t,path=>++calls===1?new Promise(resolve=>finish=resolve):{path,entries:[entry('current',path)]})
  const old=s.state.load('/srv')
  s.state.invalidate('/srv')
  finish({path:'/srv',entries:[entry('stale','/srv')]})
  assert.equal(await old,false)
  await s.state.load('/srv')
  assert.equal(s.state.entries.value[0].name,'current')
})

test('a synchronous listing failure does not leave a permanently cached pending request',async t=>{
  let calls=0
  const {state}=mountComposable(t,()=>useDirectoryBrowser({contextKey:()=> 'a',read:path=>{
    if(++calls===1) throw Error('connection lost')
    return Promise.resolve({path,entries:[]})
  }}))
  assert.equal(await state.load('/srv'),false)
  assert.equal(await state.load('/srv'),true)
  assert.equal(calls,2)
})

test('a cached history navigation cannot overwrite a newer directory history position',async t=>{
  const s=setup(t)
  await s.state.load('/a');await s.state.load('/b');await s.state.load('/c')
  const back=s.state.goHistory(-1)
  await s.state.load('/d');await back
  assert.equal(s.state.history.value[s.state.historyIndex.value],'/d')
})

test('path suggestions from a previous server are ignored',async t=>{
  let finish
  const s=setup(t,path=>new Promise(resolve=>finish=()=>resolve({path,entries:[entry('old',path)]})))
  const suggestions=s.state.suggestions('/srv/')
  s.owner.value='b';finish()
  assert.deepEqual(await suggestions,[])
})
