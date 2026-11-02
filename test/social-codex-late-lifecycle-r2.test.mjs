import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {CodexProvider} from '../src/codex-provider.mjs';
import {runR95Model,withR95ModelLifecycle} from '../src/r95-model-request.mjs';
import {createSocialRuntimeJournal} from '../src/buddy-plugin-services/social-runtime-journal.mjs';

const deferred=()=>{let release;const promise=new Promise(resolve=>release=resolve);return {promise,release};};
for(const mode of ['not-sent','terminal-evidence'])test('actual Codex stream persists late '+mode+' after signal rejects the iterator and journal first',async t=>{
 const root=await mkdtemp(join(tmpdir(),'social-codex-late-r2-')),dataRoot=join(root,'codex'),requests=[],audits=[],turnSeen=deferred(),claimEntered=deferred(),claimGate=deferred(),evidenceEntered=deferred(),evidenceGate=deferred(),controller=new AbortController(),journal=createSocialRuntimeJournal({dataRoot:root});
 const provider=new CodexProvider({binary:'synthetic-only.exe',defaultModel:'synthetic',dataRoot,env:{USERPROFILE:root,CODEX_HOME:join(root,'synthetic-home')},handshakeTimeoutMs:500,turnTimeoutMs:1000,audit:event=>audits.push(event),spawnImpl:()=>{
  const child=new EventEmitter();Object.assign(child,{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),killed:false,kill(){this.killed=true;}});child.stdin.on('data',bytes=>{for(const line of String(bytes).trim().split('\n')){const message=JSON.parse(line);requests.push(message);if(message.id==null)continue;queueMicrotask(()=>{if(child.killed)return;
   if(message.method==='turn/start'){const threadId=message.params.threadId;child.stdout.write(JSON.stringify({method:'item/completed',params:{threadId,turnId:'unverified-turn',item:{id:'message',type:'agentMessage',text:'RAW_LATE_TERMINAL'}}})+'\n');child.stdout.write(JSON.stringify({method:'turn/completed',params:{threadId,turn:{id:'unverified-turn',status:'completed'}}})+'\n');turnSeen.release();return;}
   const result=message.method==='account/read'?{account:{type:'chatgpt'}}:message.method==='thread/start'?{thread:{id:'synthetic-thread'}}:{};child.stdout.write(JSON.stringify({id:message.id,result})+'\n');
  });}});queueMicrotask(()=>child.emit('spawn'));return child;
 }});provider.setEnabled(true);
 t.after(async()=>{claimGate.release();evidenceGate.release();await provider.chatTail;provider.close();await journal.close();await rm(root,{recursive:true,force:true});const cwd=resolve(tmpdir(),'ai-buddy-chat',createHash('sha256').update(dataRoot).digest('hex').slice(0,24));assert.ok(cwd.startsWith(resolve(tmpdir(),'ai-buddy-chat')+sep));await rm(cwd,{recursive:true,force:true});});
 const scope={pluginId:'synthetic',characterId:'character',lifeId:'life'},input={kind:'social-chat',messages:[{role:'user',content:'original'}]},request={id:'original-attempt',scope,input},router={enabled:true,supportsSubmissionLifecycle:true,currentSelection:()=>({provider:'codex',model:'synthetic'}),selected:()=>({}),stream:options=>provider.stream(options)};
 const task=journal.model(request,async({observeLifecycle})=>withR95ModelLifecycle(async value=>{assert.deepEqual(value.scope,scope);assert.deepEqual(value.input,input);if(mode==='terminal-evidence'&&value.event.phase==='terminal-evidence'){evidenceEntered.release();await evidenceGate.promise;}observeLifecycle(value.event);},()=>runR95Model({provider:router,card:{id:'character'},scope,system:'JSON',input,signal:controller.signal,withOrigin:(_s,_k,fn)=>fn('original-provider-request'),beforeModelSubmit:mode==='not-sent'?async()=>{claimEntered.release();await claimGate.promise;}:()=>{}})));
 task.catch(()=>{});await (mode==='not-sent'?claimEntered.promise:turnSeen.promise);controller.abort();if(mode==='terminal-evidence')await evidenceEntered.promise;await assert.rejects(task,{code:'ABORT_ERR'});
 const db=new DatabaseSync(join(root,'social-core','runtime-v1.sqlite'),{readOnly:true});try{assert.equal(db.prepare('SELECT state FROM models').get().state,'unknown');claimGate.release();evidenceGate.release();await provider.chatTail;const events=db.prepare('SELECT body FROM model_transport_events ORDER BY sequence').all().map(row=>JSON.parse(row.body));assert.ok(events.some(event=>event.phase===mode),'the late private transport fact must survive the iterator failure');if(mode==='terminal-evidence'){const evidence=events.find(event=>event.phase===mode).evidence;assert.equal(evidence.complete,false);assert.equal(evidence.events[0].params.item.text,'RAW_LATE_TERMINAL');}const model=db.prepare('SELECT state,result FROM models').get();assert.equal(model.state,'unknown');assert.equal(model.result,null);assert.equal(requests.filter(row=>row.method==='turn/start').length,mode==='not-sent'?0:1);assert.ok(!JSON.stringify(audits).includes('RAW_LATE_TERMINAL'));let replayed=false;await assert.rejects(journal.model(request,async()=>{replayed=true;return {requestId:'forbidden'};}),{code:'SOCIAL_MODEL_RESULT_UNKNOWN'});assert.equal(replayed,false);}finally{db.close();}
});
