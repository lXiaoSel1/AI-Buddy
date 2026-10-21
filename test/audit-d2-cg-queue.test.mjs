import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CgService} from '../src/cg-service.mjs';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jp1sAAAAASUVORK5CYII=','base64');
const json=value=>new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});
const codec=bytes=>({png:bytes,thumbnail:bytes,width:1,height:1,extension:'png'});
const crypto={isEncryptionAvailable:()=>true,encryptString:key=>Buffer.from([...key].reverse().join('')),decryptString:bytes=>[...bytes.toString()].reverse().join('')};
const codex={defaultModel:'gpt-6.1-sol',enabled:false,close(){},setEnabled(){}};
const wait=async predicate=>{const end=Date.now()+6000;while(!predicate()){if(Date.now()>end)throw Error('Wait timed out');await new Promise(resolve=>setTimeout(resolve,15));}};
async function service(options={}){
 const cg=new CgService({dataRoot:mkdtempSync(join(tmpdir(),'audit-cg-')),codex,crypto,imageCodec:codec,referenceResolver:async()=>[{buffer:png}],fetchImpl:async()=>json({data:[{b64_json:png.toString('base64')}]}),pollInterval:1,...options});
 await cg.ready;const profile=await cg.save({kind:'custom',name:'CG',baseUrl:'http://127.0.0.1:31415/v1',model:'image-model',protocol:'openai-images',options:{references:true}});await cg.activate(profile.id);return cg;
}

test('an automatic job skipped because auto-generation is off ends cancelled, not stuck generating',async()=>{
 const cg=await service();await cg.setEnabled(true);
 await cg.enqueue({id:'auto',sourceEventId:'auto',automatic:true,prompt:'CG'});
 await cg.jobsMutate(()=>{cg.job('auto').remoteTask={id:'remote-1'};});
 await cg.setEnabled(false);assert.equal(cg.job('auto').status,'queued','jobs with a remote task are left queued');
 cg.start();await wait(()=>cg.job('auto').status!=='queued'&&cg.job('auto').status!=='generating');
 assert.equal(cg.job('auto').status,'cancelled');assert.equal(cg.status().busy,false);
 await cg.save({...cg.view().profiles[0],name:'CG 改名'});
 await cg.close();
});

test('a failing activity notification fails the job instead of leaving the queue busy',async()=>{
 const cg=await service({onActivity:({active})=>{if(active)throw Error('pet window is closing');}});
 cg.start();await cg.enqueue({id:'manual',sourceEventId:'manual',prompt:'CG'});
 await wait(()=>!['queued','planning','generating'].includes(cg.job('manual').status));
 assert.equal(cg.job('manual').status,'failed');assert.equal(cg.status().busy,false);
 await cg.close();
});

test('validated group references are reused by enqueue',async()=>{
 let resolved=0;const cg=await service({referenceResolver:async()=>{resolved++;return [{buffer:png}];}});
 const characters=[{id:'claude',name:'Claude'}],refs=await cg.validateReferences(characters,null);
 await cg.enqueue({id:'group',sourceEventId:'group',kind:'group',prompt:'CG',characters,resolvedRefs:refs});
 assert.equal(resolved,1);assert.equal(cg.job('group').references.length,1);
 await cg.close();
});
