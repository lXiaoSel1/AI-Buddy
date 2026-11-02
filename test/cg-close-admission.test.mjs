import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {CgService} from '../src/cg-service.mjs';
const gate=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
async function fixture(t,referenceResolver=async()=>[]){
 const root=mkdtempSync(join(tmpdir(),'cg-close-admission-'));
 const cg=new CgService({dataRoot:root,codex:{defaultModel:'fixture',close(){}},crypto:{encryptString:value=>Buffer.from(value),decryptString:value=>value.toString()},imageCodec:bytes=>({png:bytes,thumbnail:bytes,width:1,height:1}),referenceResolver});
 await cg.ready;const profile=await cg.save({kind:'custom',name:'fixture',protocol:'openai-images',baseUrl:'http://127.0.0.1:3',model:'fixture',options:{references:true}});await cg.activate(profile.id);
 t.after(async()=>{await cg.close();rmSync(root,{recursive:true,force:true});});return cg;
}
test('closed CG service rejects enqueue before references or other preparation',async t=>{
 let references=0;const cg=await fixture(t,async()=>{references++;return [];});await cg.close();
 await assert.rejects(cg.enqueue({id:'too-late',sourceEventId:'too-late',prompt:'fixture'}),{code:'CG_SERVICE_CLOSED'});
 assert.equal(references,0);assert.equal(cg.jobs.length,0);
});
test('CG close drains admitted reference preparation before closing its reward journal',async t=>{
 const entered=gate(),release=gate();const cg=await fixture(t,async()=>{entered.resolve();await release.promise;return [];});
 const enqueuing=cg.enqueue({id:'in-flight',sourceEventId:'in-flight',prompt:'fixture'}).then(value=>({value}),error=>({error}));await entered.promise;
 let closed=false;const closing=cg.close().then(()=>{closed=true;});
 try{await new Promise(resolve=>setImmediate(resolve));assert.equal(closed,false,'close must wait for the real enqueue producer');}
 finally{release.resolve();await closing;}
 const result=await enqueuing;assert.equal(result.error?.code,'CG_SERVICE_CLOSED');assert.equal(cg.jobs.length,0);
});
