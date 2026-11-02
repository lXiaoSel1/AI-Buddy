import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createSocialRuntimeJournal,markModelNotSubmitted} from '../src/buddy-plugin-services/social-runtime-journal.mjs';
async function fixture(t){const dataRoot=await mkdtemp(join(tmpdir(),'vision-journal-')),journal=createSocialRuntimeJournal({dataRoot});t.after(async()=>{await journal.close();await rm(dataRoot,{recursive:true,force:true});});return journal;}
test('only the private non-submission brand permits a safe identical retry',async t=>{
 const journal=await fixture(t),request={id:'step',input:{refs:['opaque']},scope:{characterId:'whale'}};let calls=0;
 await assert.rejects(journal.model(request,async()=>{calls++;throw markModelNotSubmitted(Error('preflight'));}),{code:'SOCIAL_MODEL_NOT_SUBMITTED'});
 assert.equal((await journal.model(request,async()=>{calls++;return{requestId:'actual-request',text:'seen'};})).text,'seen');assert.equal(calls,2);
});
test('a serializable not-submitted flag or cancellation code does not erase a possibly submitted call',async t=>{
 const journal=await fixture(t),request={id:'unknown',input:{refs:['opaque']},scope:{characterId:'whale'}};let calls=0;
 await assert.rejects(journal.model(request,async()=>{calls++;throw Object.assign(Error('uncertain'),{code:'ABORT_ERR',notSubmitted:true});}),/uncertain/);
 await assert.rejects(journal.model(request,async()=>{calls++;return{requestId:'must-not-run'};}),{code:'SOCIAL_MODEL_RESULT_UNKNOWN'});assert.equal(calls,1);
});
