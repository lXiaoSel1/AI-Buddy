import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createSocialRuntimeJournal,markModelNotSubmitted} from '../src/buddy-plugin-services/social-runtime-journal.mjs';
import {createModelSubmission} from '../src/model-submission.mjs';

async function fixture(t){const dataRoot=await mkdtemp(join(tmpdir(),'social-lifecycle-r2-'));let journal=createSocialRuntimeJournal({dataRoot});t.after(async()=>{await journal.close();await rm(dataRoot,{recursive:true,force:true});});return {get journal(){return journal;},restart:async()=>{await journal.close();journal=createSocialRuntimeJournal({dataRoot});},read:sql=>{const db=new DatabaseSync(join(dataRoot,'social-core','runtime-v1.sqlite'),{readOnly:true});try{return db.prepare(sql).all();}finally{db.close();}}};}
const request={id:'retained-step',input:{kind:'original',text:'ORIGINAL_REQUEST_TEXT'},scope:{pluginId:'plugin',accountBindingId:'account',bindingGeneration:1,characterId:'character'}};
test('journal retains exact not-sent attempts and cause classification across a safe identical retry',async t=>{
 const f=await fixture(t);await assert.rejects(f.journal.model(request,async()=>{throw markModelNotSubmitted(Object.assign(Error('too large'),{code:'MEMORY_CONTEXT_CAPACITY'}));}),{code:'SOCIAL_MODEL_NOT_SUBMITTED',causeCode:'MEMORY_CONTEXT_CAPACITY'});
 assert.equal(f.read('SELECT state FROM models')[0].state,'not-sent');assert.equal(JSON.parse(f.read('SELECT input FROM model_inputs')[0].input).text,'ORIGINAL_REQUEST_TEXT');await f.restart();
 assert.equal((await f.journal.model(request,async()=>({requestId:'actual',text:'complete'}))).text,'complete');const attempts=f.read('SELECT state FROM model_transport_attempts ORDER BY attempt');assert.deepEqual(attempts.map(x=>x.state),['not-sent','completed']);assert.equal(f.read("SELECT value FROM meta WHERE key='schema'")[0].value,'1');
});
test('private lifecycle stores bounded original terminal evidence without marking a result complete',async t=>{
 const f=await fixture(t),raw={method:'item/completed',params:{threadId:'thread',turnId:'turn',item:{id:'message',type:'agentMessage',text:'RAW_FINAL_RESPONSE'}}};
 await assert.rejects(f.journal.model(request,async()=>{
  const submission=createModelSubmission({onModelLifecycle:event=>f.journal.observeModelLifecycle({...request,event})},'codex',{requestId:7,threadId:'thread'});await submission.prepare();await submission.beforeSend();submission.attempt();await submission.evidence({transport:'codex',requestId:7,threadId:'thread',turnId:null,correlation:'unverified',complete:false,overflow:false,events:[raw]});throw await submission.failure(Object.assign(Error('ack missing'),{code:'CODEX_REQUEST_TIMEOUT'}));
 }),{code:'CODEX_REQUEST_TIMEOUT'});
 const events=f.read('SELECT body FROM model_transport_events ORDER BY sequence').map(row=>JSON.parse(row.body));assert.deepEqual(events.find(x=>x.phase==='terminal-evidence').evidence.events,[raw]);assert.equal(events.at(-1).phase,'unknown');assert.equal(f.read('SELECT state,result FROM models')[0].state,'unknown');assert.equal(f.read('SELECT result FROM models')[0].result,null);await f.restart();let replayed=false;await assert.rejects(f.journal.model(request,async()=>{replayed=true;return {requestId:'forbidden'};}),{code:'SOCIAL_MODEL_RESULT_UNKNOWN'});assert.equal(replayed,false);
});
test('serializable submission flags and leaked lifecycle callbacks cannot clear uncertain journal state',async t=>{
 const f=await fixture(t);await assert.rejects(f.journal.model(request,async()=>{throw Object.assign(Error('forged'),{code:'SOCIAL_MODEL_NOT_SUBMITTED',modelSubmission:{phase:'not-sent',source:'core-transport'}});}),/forged/);assert.equal(f.read('SELECT state FROM models')[0].state,'unknown');await assert.rejects(f.journal.model(request,async()=>({requestId:'forbidden'})),{code:'SOCIAL_MODEL_RESULT_UNKNOWN'});
});
test('late transport facts stay bound to the original attempt after a queue rejects or a result completes',async t=>{
 const f=await fixture(t);let late;await assert.rejects(f.journal.model(request,async({observeLifecycle})=>{late=observeLifecycle;throw Error('iterator rejected first');}),/iterator rejected first/);
 const raw={method:'turn/completed',params:{threadId:'late-thread',turn:{id:'late-turn',status:'completed'}}};late({phase:'terminal-evidence',source:'core-transport',transport:'codex',evidence:{correlation:'unverified',complete:false,events:[raw]}});late({phase:'not-sent',source:'core-transport',transport:'codex'});
 assert.equal(f.read('SELECT state FROM models')[0].state,'unknown');assert.deepEqual(JSON.parse(f.read("SELECT body FROM model_transport_events WHERE json_extract(body,'$.phase')='terminal-evidence'")[0].body).evidence.events,[raw]);await assert.rejects(f.journal.model(request,async()=>({requestId:'forbidden'})),{code:'SOCIAL_MODEL_RESULT_UNKNOWN'});
 const next={...request,id:'completed-step'};await f.journal.model(next,async({observeLifecycle})=>{late=observeLifecycle;return {requestId:'complete',text:'retained'};});late({phase:'unknown',source:'core-transport',transport:'codex'});const completed=f.read("SELECT state,result FROM models WHERE id='completed-step'")[0];assert.equal(completed.state,'completed');assert.equal(JSON.parse(completed.result).requestId,'complete');
});
