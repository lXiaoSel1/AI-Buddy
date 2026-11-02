import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {openChatRequestStore} from '../src/chat-request-store.mjs';

async function fixture(t, options) {
  const root=await fs.mkdtemp(join(tmpdir(),'journal-replace-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  return {root,store:await openChatRequestStore(root,options)};
}
test('journal retries only the same atomic replace after a transient Windows sharing violation',async t=>{
  const attempts=[],waits=[];
  const {root,store}=await fixture(t,{platform:'win32',sleep:async n=>waits.push(n),rename:async(from,to)=>{
    attempts.push([from,to]);if(attempts.length<=2)throw Object.assign(Error('sharing violation'),{code:'EPERM'});await fs.rename(from,to);
  }});
  await store.put({requestId:'request-1',status:'generating',text:'original request'});
  assert.equal(attempts.length,3);assert.deepEqual(attempts[0],attempts[1]);assert.deepEqual(attempts[1],attempts[2]);
  assert.deepEqual(waits,[50,100]);
  assert.equal(JSON.parse(await fs.readFile(join(root,'chat-requests/request-1.json'),'utf8')).text,'original request');
});
test('permanent journal replacement failure preserves the previous committed bytes and does not poison the queue',async t=>{
  let deny=false,calls=0;const {root,store}=await fixture(t,{platform:'win32',sleep:async()=>{},rename:async(a,b)=>{
    calls++;if(deny)throw Object.assign(Error('denied'),{code:'EPERM'});return fs.rename(a,b);
  }});
  await store.put({requestId:'r',status:'queued',text:'kept'});const path=join(root,'chat-requests/r.json'),before=await fs.readFile(path);
  deny=true;await assert.rejects(store.put({requestId:'r',status:'generating',text:'not committed'}),{code:'EPERM'});
  assert.ok(calls<=8);assert.deepEqual(await fs.readFile(path),before);assert.equal(store.get('r').text,'kept');
  assert.deepEqual(await fs.readdir(join(root,'chat-requests')),['r.json']);
  deny=false;await store.put({requestId:'r',status:'completed',text:'done'});await store.flush();assert.equal(store.get('r').text,'done');
});
test('journal rejects non-sharing errors without retries and retains restart interruption semantics',async t=>{
  let deny=false,calls=0;const {root,store}=await fixture(t,{platform:'win32',sleep:async()=>assert.fail('must not retry'),rename:async(a,b)=>{
    calls++;if(deny)throw Object.assign(Error('disk full'),{code:'ENOSPC'});return fs.rename(a,b);
  }});
  await store.put({requestId:'r',status:'generating',text:'partial'});deny=true;
  await assert.rejects(store.put({requestId:'r',status:'completed'}),{code:'ENOSPC'});assert.equal(calls,2);
  const reopened=await openChatRequestStore(root);assert.equal(reopened.get('r').status,'interrupted');assert.equal(reopened.get('r').text,'partial');
});
