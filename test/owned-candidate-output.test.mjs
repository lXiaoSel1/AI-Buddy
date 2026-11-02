import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createOwnedCandidateOutput} from '../scripts/owned-candidate-output.mjs';

const fixture=t=>{const root=fs.mkdtempSync(join(tmpdir(),'buddy-owned-build-'));t.after(()=>fs.rmSync(root,{recursive:true,force:false}));return root;};

test('successful candidate staging commits once to a fresh final directory',t=>{
 const root=fixture(t),build=createOwnedCandidateOutput(root,'candidate');
 fs.writeFileSync(join(build.stagePath,'main.cjs'),'program');
 assert.equal(build.commit(),join(fs.realpathSync.native(root),'candidate'));
 assert.equal(fs.readFileSync(join(root,'candidate','main.cjs'),'utf8'),'program');
 assert.equal(fs.existsSync(join(root,'candidate','.build-owner.json')),false);
 assert.throws(()=>build.abort(),/no longer open/);
});

test('failed candidate staging is removed only with its original owner marker',t=>{
 const root=fixture(t),build=createOwnedCandidateOutput(root,'candidate');
 fs.writeFileSync(join(build.stagePath,'partial.webm'),'temporary');
 build.abort();
 assert.equal(fs.existsSync(build.stagePath),false);
 assert.equal(fs.existsSync(join(root,'candidate')),false);
});

test('stage marker tampering blocks recursive cleanup',t=>{
 const root=fixture(t),build=createOwnedCandidateOutput(root,'candidate');
 const marker=join(build.stagePath,'.build-owner.json'),saved=fs.readFileSync(marker,'utf8');
 fs.writeFileSync(marker,'{}');
 assert.throws(()=>build.abort(),/marker changed/);
 assert.equal(fs.existsSync(build.stagePath),true);
 fs.writeFileSync(marker,saved);
 build.abort();
});

test('a pre-existing final output is rejected without changing its contents',t=>{
 const root=fixture(t),existing=join(root,'candidate');fs.mkdirSync(existing);fs.writeFileSync(join(existing,'keep.txt'),'keep');
 assert.throws(()=>createOwnedCandidateOutput(root,'candidate'),/already exists/);
 assert.equal(fs.readFileSync(join(existing,'keep.txt'),'utf8'),'keep');
});

test('transient Windows rename sharing failure commits the same staged candidate',t=>{
 const root=fixture(t);let calls=0;
 const build=createOwnedCandidateOutput(root,'candidate',{rename:(from,to)=>{
  calls++;
  if(calls===1)throw Object.assign(new Error('temporary sharing lock'),{code:'EPERM'});
  fs.renameSync(from,to);
 }});
 fs.writeFileSync(join(build.stagePath,'main.cjs'),'stable-program');
 assert.equal(build.commit(),join(fs.realpathSync.native(root),'candidate'));
 assert.equal(calls,2);
 assert.equal(fs.readFileSync(join(root,'candidate','main.cjs'),'utf8'),'stable-program');
});
