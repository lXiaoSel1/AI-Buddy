import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,renameSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,relative} from 'node:path';
import {validateMediaBuild,mediaRows,indexRows,shaBytes,assertFreshCandidateOutput} from '../scripts/media-baseline-validation.mjs';

function fixture(t){
 const dir=mkdtempSync(join(tmpdir(),'ai-buddy-media-proof-'));t.after(()=>{assert(!relative(resolve(tmpdir()),resolve(dir)).startsWith('..'));assert(dir.includes('ai-buddy-media-proof-'));rmSync(dir,{recursive:true,force:true});});
 const save=(p,v)=>{mkdirSync(join(p,'..'),{recursive:true});writeFileSync(p,typeof v==='string'||Buffer.isBuffer(v)?v:JSON.stringify(v));};
 const read=p=>JSON.parse(readFileSync(p));const resources={};const editions=[];
 for(const fps of[30,60]){
  const root=join(dir,String(fps)),video='assets/pet-characters/deepseek/idle/motion.webm',content=Buffer.from('old-'+fps);
  const clip={version:2,characterId:'deepseek',actionId:'idle',canvas:{width:576,height:624},anchor:{x:276,y:602},cycleMs:1000,loop:true,frames:[{timestampMs:0},{timestampMs:1000/fps}],video:{src:'./'+video,sha256:shaBytes(content),bytes:content.length,fps,encodedFrameCount:fps,crf:28}};
  save(join(root,'package.json'),{version:'1.9.2',animationProfile:fps+'fps'});save(join(root,video),content);save(join(root,'assets/still.webp'),'unchanged-still');
  save(join(root,'assets/character-sequence-manifest.json'),{deepseek:{idle:clip}});save(join(root,'assets/frame-sequence-manifest.json'),{idle:clip});
  const entry=path=>{const b=readFileSync(join(root,path));return{path,bytes:b.length,sha256:shaBytes(b)};};
  const index={version:1,appVersion:'1.9.2',edition:fps+'fps',defaultCharacter:'deepseek',shared:['assets/still.webp','assets/character-sequence-manifest.json','assets/frame-sequence-manifest.json'].map(entry),characters:{deepseek:[entry(video)]}};
  save(join(root,'assets/install-resource-index.json'),index);resources[fps]=root;editions.push({fps,profile:fps+'fps',videos:mediaRows({deepseek:{idle:clip}},fps),index:indexRows(index),indexHeader:Object.fromEntries(Object.entries(index).filter(([k])=>!['shared','characters'].includes(k)))});
 }
 const lock=join(dir,'legacy.json');save(lock,{schemaVersion:1,appVersion:'1.9.2',editions});
 function refresh(fps){const root=resources[fps],index=read(join(root,'assets/install-resource-index.json'));for(const r of[...index.shared,...index.characters.deepseek]){const b=readFileSync(join(root,r.path));r.bytes=b.length;r.sha256=shaBytes(b);}save(join(root,'assets/install-resource-index.json'),index);}
 function change(fps=30,mutate){const root=resources[fps],manifest=read(join(root,'assets/character-sequence-manifest.json')),clip=manifest.deepseek.idle;
  if(mutate)mutate(clip);else{const b=Buffer.from('new-slow-'+fps);save(join(root,clip.video.src.slice(2)),b);clip.video.bytes=b.length;clip.video.sha256=shaBytes(b);}
  save(join(root,'assets/character-sequence-manifest.json'),manifest);save(join(root,'assets/frame-sequence-manifest.json'),manifest.deepseek);refresh(fps);
 }
 function proof({warning=false,manual=true,accepted=true,sourceUnavailable=false}={}){
  const base={schemaVersion:1,kind:'ai-buddy-optimized-media-baseline',appVersion:'1.9.2',inventorySha256:'a'.repeat(64),methodSha256:'b'.repeat(64),userReviewExportSha256:'c'.repeat(64),editions:[30,60].map(fps=>({fps,profile:fps+'fps',files:mediaRows(read(join(resources[fps],'assets/character-sequence-manifest.json')),fps).map(x=>({...x,variant:fps===30?'C':'A',structuralPass:true,qualityWarnings:warning&&fps===30?['detail warning']:[],sourceUnavailable:sourceUnavailable&&fps===60}))}))};
  const baselinePath=join(dir,'baseline.json'),approvalPath=join(dir,'approval.json');save(baselinePath,base);
  const approval={schemaVersion:1,kind:'ai-buddy-optimized-media-approval',approved:true,approvedAt:new Date().toISOString(),mediaBaselineSha256:shaBytes(readFileSync(baselinePath)),inventorySha256:base.inventorySha256,methodSha256:base.methodSha256,userReviewExportSha256:base.userReviewExportSha256,selected:base.editions.flatMap(e=>e.files).map(x=>({...x,decisionSource:manual?'manual':'provisional-default',qualityWarningsAccepted:accepted}))};
  save(approvalPath,approval);return{baselinePath,approvalPath,base,approval};
 }
 const check=(extra={},fps=30)=>validateMediaBuild({resources:resources[fps],legacyLockPath:lock,...extra});
 return{dir,resources,save,read,lock,editions,change,refresh,proof,check};
}
test('unchanged legacy edition stays buildable without new approval',t=>{const f=fixture(t);assert.equal(f.check().mode,'legacy');assert.equal(f.check({},60).resources,4);});
test('legacy isolated sample builds keep their existing option',t=>{const f=fixture(t);assert.equal(f.check({interactionSamples:'isolated-samples'}).mode,'legacy');});
test('approved media cannot be overwritten by an interaction sample option',t=>{const f=fixture(t);f.change();const p=f.proof();assert.throws(()=>f.check({...p,interactionSamples:'unreviewed-samples'}),/cannot combine approved media with interaction samples/);});
test('changed media cannot build without approval',t=>{const f=fixture(t);f.change();assert.throws(()=>f.check(),/requires a new baseline/);});
test('valid selected media and unchanged metadata/index pass',t=>{const f=fixture(t);f.change();const p=f.proof();assert.equal(f.check(p).mode,'optimized');});
test('approval is bound to exact baseline bytes',t=>{const f=fixture(t);f.change();const p=f.proof();f.save(p.baselinePath,{...p.base,changed:true});assert.throws(()=>f.check(p),/another baseline/);});
test('draft approval is rejected',t=>{const f=fixture(t);f.change();const p=f.proof();f.save(p.approvalPath,{...p.approval,approved:false});assert.throws(()=>f.check(p),/explicit user approval/);});
test('approval must cover both editions, not just active one',t=>{const f=fixture(t);f.change();const p=f.proof();p.approval.selected.pop();f.save(p.approvalPath,p.approval);assert.throws(()=>f.check(p),/every video/);});
test('unselected warning cannot slip through provisional default',t=>{const f=fixture(t);f.change();const p=f.proof({warning:true,manual:false});assert.throws(()=>f.check(p),/not manually selected/);});
test('manual warning needs explicit warning acceptance',t=>{const f=fixture(t);f.change();const p=f.proof({warning:true,accepted:false});assert.throws(()=>f.check(p),/not accepted/);});
test('explicit manual warning acceptance can select the candidate',t=>{const f=fixture(t);f.change();assert.equal(f.check(f.proof({warning:true})).mode,'optimized');});
test('label A cannot disguise different bytes',t=>{const f=fixture(t);f.change();const p=f.proof();p.base.editions[0].files[0].variant='A';p.approval.selected[0].variant='A';f.save(p.baselinePath,p.base);p.approval.mediaBaselineSha256=shaBytes(readFileSync(p.baselinePath));f.save(p.approvalPath,p.approval);assert.throws(()=>f.check(p),/unchanged current file/);});
test('timeline or calibration drift is rejected even with internally consistent index',t=>{const f=fixture(t);f.change(30,c=>{c.cycleMs=999;c.anchor.x=275;});assert.throws(()=>f.check(),/timing, geometry/);});
test('unrelated static assets cannot be changed with compression',t=>{const f=fixture(t);f.save(join(f.resources[30],'assets/still.webp'),'modified-still');f.refresh(30);assert.throws(()=>f.check(),/non-video asset changed/);});
test('index hash cannot hide corrupt physical video',t=>{const f=fixture(t);f.save(join(f.resources[30],'assets/pet-characters/deepseek/idle/motion.webm'),'corrupt');assert.throws(()=>f.check(),/resource hash or size differs/);});
test('duplicate selected identity is rejected',t=>{const f=fixture(t);f.change();const p=f.proof();p.approval.selected.push(p.approval.selected[0]);f.save(p.approvalPath,p.approval);assert.throws(()=>f.check(p),/duplicate approval/);});
test('missing-source retention of A requires manual choice',t=>{const f=fixture(t);f.change();const p=f.proof({sourceUnavailable:true,manual:false});assert.throws(()=>f.check(p),/manual retention of A/);});
test('manual retention of unchanged A for missing source remains valid',t=>{const f=fixture(t);f.change();assert.equal(f.check(f.proof({sourceUnavailable:true})).mode,'optimized');});
test('DeepSeek mirror must remain identical to character manifest',t=>{const f=fixture(t);f.save(join(f.resources[30],'assets/frame-sequence-manifest.json'),{});f.refresh(30);assert.throws(()=>f.check(),/mirror differs/);});
test('partial baseline/approval arguments are rejected',t=>{const f=fixture(t);assert.throws(()=>f.check({baselinePath:join(f.dir,'unused.json')}),/supplied together/);});
test('unknown resource coverage is rejected',t=>{const f=fixture(t);const path=join(f.resources[30],'assets/install-resource-index.json'),index=f.read(path);index.shared.pop();f.save(path,index);assert.throws(()=>f.check(),/coverage changed/);});
test('safe replacement still needs manual choice when original C was flagged',t=>{const f=fixture(t);f.change();const p=f.proof({manual:false});p.base.editions[0].files[0].requiresManualSelection=true;p.base.editions[0].files[0].variant='B';p.approval.selected[0].variant='B';f.save(p.baselinePath,p.base);p.approval.mediaBaselineSha256=shaBytes(readFileSync(p.baselinePath));f.save(p.approvalPath,p.approval);assert.throws(()=>f.check(p),/manual version choice/);});
test('resource directory links are rejected even when their target remains inside the resource root',t=>{const f=fixture(t),root=f.resources[30],original=join(root,'assets/pet-characters/deepseek/idle'),target=join(root,'assets/actual-idle');renameSync(original,target);symlinkSync(target,original,process.platform==='win32'?'junction':'dir');assert.throws(()=>f.check(),/resource path contains a link/);});
test('new optimized candidate output is accepted without creating it',t=>{const f=fixture(t);assert.doesNotThrow(()=>assertFreshCandidateOutput(join(f.dir,'new-output')));});
test('existing optimized output is rejected before writing a shared program inode',t=>{const f=fixture(t);assert.throws(()=>assertFreshCandidateOutput(f.resources[30]),/output already exists/);});
test('candidate output cannot be created through a directory link',t=>{const f=fixture(t),link=join(f.dir,'linked-builds');symlinkSync(f.resources[30],link,process.platform==='win32'?'junction':'dir');assert.throws(()=>assertFreshCandidateOutput(join(link,'new-candidate')),/linked ancestor/);});
