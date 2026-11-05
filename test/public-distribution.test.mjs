import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {assertPublicFileNames,assemblePublicDistribution} from '../scripts/build-distribution-202.mjs';
import {validateMediaBuild,shaBytes} from '../scripts/media-baseline-validation.mjs';
import {assertDistributionPaths,loadPublicAssetInventory,APPLICATION_VERSION,MEDIA_BASE_VERSION} from '../scripts/public-distribution-assets.mjs';
import {temporary,mediaFixture,pythonFixture,save,read,fileRow} from './support/public-distribution-fixtures.mjs';
test('public distribution preserves normal nested app resources',()=>{const rows=[{path:'assets/theme/deepseek/bg.webp'},{path:'dsh-platform/native-bridge-host.mjs'},{path:'media-notices/ffmpeg/LICENSE'}];assert.equal(assertPublicFileNames(rows),rows);});
test('private, deferred and aliased paths cannot enter a public application package',()=>{for(const p of ['local/token.json','a/../private','C:/user/foo','x\\outside','plugins/work-collaboration/lib/index.mjs','a/accounts-v1.sqlite','.ssh/key','test-data/run.sqlite','bili-media/ffmpeg.exe','ffmpeg.exe','other/ffprobe.exe','whisper-cli.exe','ggml-base.bin'])assert.throws(()=>assertPublicFileNames([{path:p}]));assert.throws(()=>assertPublicFileNames([{path:'assets/A.png'},{path:'assets/a.png'}]));});

const repo=fileURLToPath(new URL('..',import.meta.url));
function mediaCheck(f,options={}){return validateMediaBuild({resources:f.roots[30],legacyLockPath:f.legacyLockPath,baselinePath:f.baselinePath,approvalPath:f.approvalPath,...options});}
const versions={applicationVersion:APPLICATION_VERSION,mediaBaseVersion:MEDIA_BASE_VERSION};
test('real package/index manifest inputs separate application from its media baseline; legacy defaults still reject the mismatch',t=>{
 const f=mediaFixture(t);assert.equal(read(path.join(f.roots[30],'package.json')).version,APPLICATION_VERSION);assert.equal(read(path.join(f.roots[30],'assets/install-resource-index.json')).appVersion,'1.9.2');
 assert.throws(()=>mediaCheck(f),/application version differs/);const result=mediaCheck(f,versions);assert.equal(result.version,APPLICATION_VERSION);assert.equal(result.mediaBaseVersion,'1.9.2');assert.equal(result.videos,1);
 assert.throws(()=>mediaCheck(f,{applicationVersion:APPLICATION_VERSION}),/supplied together/);assert.throws(()=>mediaCheck(f,{...versions,mediaBaseVersion:APPLICATION_VERSION}),/media base version differs/);assert.throws(()=>mediaCheck(f,{...versions,applicationVersion:'9.9.9'}),/application version differs/);
 const indexPath=path.join(f.roots[30],'assets/install-resource-index.json'),index=read(indexPath);save(indexPath,{...index,appVersion:APPLICATION_VERSION});assert.equal(mediaCheck(f,versions).version,APPLICATION_VERSION);save(indexPath,{...index,appVersion:'9.9.9'});assert.throws(()=>mediaCheck(f,versions),/resource index header changed/);save(indexPath,index);
 save(path.join(f.roots[30],'package.json'),{version:'1.9.2',animationProfile:'30fps'});assert.equal(mediaCheck(f).version,'1.9.2');
});
test('public source-build evidence is explicit and cannot mix a private or supplied approval object',t=>{
 const f=mediaFixture(t);assert.throws(()=>mediaCheck(f,{publicEvidence:true}),/cannot be mixed/);assert.throws(()=>mediaCheck(f,{publicEvidence:'true'}),/must be boolean/);
});
test('complete approved asset inventory accepts only source-bound unindexed UI assets',t=>{
 const f=mediaFixture(t),root=f.roots[30],name='assets/food/biscuit.webp';save(path.join(root,name),'source-food');const source={...fileRow(root,name),owner:'shared'},assets=[...f.assets[30],source];
 assert.equal(mediaCheck(f,{...versions,assetInventory:assets,sourceAssets:[source]}).resources,5);
 assert.throws(()=>mediaCheck(f,{...versions,assetInventory:assets}),/unindexed asset lacks source binding/);
 save(path.join(root,name),'changed-food');assert.throws(()=>mediaCheck(f,{...versions,assetInventory:assets,sourceAssets:[source]}),/approved physical asset differs/);
});
test('extra physical asset and internally rehashed static replacement remain RED',t=>{
 const f=mediaFixture(t),root=f.roots[30],options={...versions,assetInventory:f.assets[30]};save(path.join(root,'assets/unapproved.png'),'unknown');assert.throws(()=>mediaCheck(f,options),/physical asset coverage differs/);fs.unlinkSync(path.join(root,'assets/unapproved.png'));
 save(path.join(root,'assets/still.webp'),'unauthorized-but-indexed');const index=read(path.join(root,'assets/install-resource-index.json'));index.shared[0]=fileRow(root,'assets/still.webp');save(path.join(root,'assets/install-resource-index.json'),index);assert.throws(()=>mediaCheck(f,options),/approved asset differs/);
});
test('bundled public inventory contains complete two-edition media and no private receipt paths/chat',()=>{
 const inventory=loadPublicAssetInventory(repo);assert.deepEqual(inventory.editions.map(e=>[e.fps,e.assets.length,e.videos.length]),[[30,4676,264],[60,4676,264]]);assert.equal(inventory.sourceAssets.filter(row=>row.path.startsWith('assets/food/')).length,21);assert.doesNotMatch(JSON.stringify(inventory),/receiptPath|approvalPath|[A-Z]:\\|decisionSource|用户在本轮/);
});
function assemblyPaths(t){const dir=temporary(t),values={};for(const name of ['baseline30','baseline60','runtime']){values[name]=path.join(dir,name);fs.mkdirSync(values[name]);}values.rcedit=path.join(dir,'stamp.exe');save(values.rcedit,'fixture-only');values.out=path.join(dir,'output');values.publicEvidence=true;return{dir,...values};}
test('actual assembler rejects nested/equal/inverse input-output trees before copying',t=>{
 const f=assemblyPaths(t);for(const out of [f.baseline30,path.join(f.baseline30,'fresh-output'),f.dir])assert.throws(()=>assemblePublicDistribution({...f,out}),/overlap/);assert.equal(fs.existsSync(path.join(f.baseline30,'fresh-output')),false);assert.equal(fs.existsSync(f.out),false);
});
test('actual assembler applies public privacy checks to runtime before media/build work',t=>{
 const f=assemblyPaths(t);save(path.join(f.runtime,'plugins/work-collaboration/index.mjs'),'private-fixture');assert.throws(()=>assemblePublicDistribution(f),/private or deferred public file/);assert.equal(fs.existsSync(f.out),false);
});
test('linked input roots, linked output ancestors and output collisions remain RED',t=>{
 const f=assemblyPaths(t),link=path.join(f.dir,'linked');fs.symlinkSync(f.baseline30,link,process.platform==='win32'?'junction':'dir');assert.throws(()=>assemblePublicDistribution({...f,baseline30:link}),/linked ancestor/);assert.throws(()=>assertDistributionPaths({inputs:[f.runtime],outputs:[path.join(link,'new')]}),/linked ancestor/);assert.throws(()=>assertDistributionPaths({inputs:[f.runtime],outputs:[f.out,path.join(f.out,'nested')]}),/output\/output overlap/);
});
const pythonScript=fileURLToPath(new URL('../scripts/package-installer-202.py',import.meta.url));
function groupPython(f){
 const driver="import importlib.util,sys,json;from pathlib import Path;script=Path(sys.argv[1]);sys.path.insert(0,str(script.parent));spec=importlib.util.spec_from_file_location('packaging_fixture',script);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);trees,groups=m.group_trees(Path(sys.argv[2]),inventory_path=Path(sys.argv[3]),inventory_sha256=sys.argv[4]);print(json.dumps({'ok':True,'editions':list(trees),'groups':len(groups)}))";
 const result=spawnSync(process.platform==='win32'?'py':'python3',[...process.platform==='win32'?['-3','-B']:['-B'],'-c',driver,pythonScript,f.candidate,f.inventoryPath,f.inventorySha256],{encoding:'utf8',windowsHide:true});if(result.error)throw result.error;return result;
}
test('Python group_trees consumes actual v2 producer fields on a complete small 11x24 fixture',t=>{
 const f=pythonFixture(t),result=groupPython(f);assert.equal(result.status,0,result.stderr);const value=JSON.parse(result.stdout);assert.equal(value.ok,true);assert.deepEqual(value.editions,['30fps','60fps']);assert(value.groups>20);
});
for(const mutation of ['extra-asset','static-rehash','video-corruption','code-change','version-change','index-ownership','approval-digest','runtime-private','runtime-code','duplicate-proof'])test('Python full group_trees rejects '+mutation+' even with attacker-rebound candidate receipt',t=>{
 const f=pythonFixture(t),base=path.join(f.candidate,'30fps/build');
 if(mutation==='extra-asset')save(path.join(base,'assets/extra.webp'),'unapproved');
 if(mutation==='static-rehash'){save(path.join(base,'assets/food/biscuit.webp'),'unapproved-food');const index=read(path.join(base,'assets/install-resource-index.json'));index.shared[0]=fileRow(base,'assets/food/biscuit.webp');save(path.join(base,'assets/install-resource-index.json'),index);}
 if(mutation==='video-corruption')save(path.join(base,'assets/characters/deepseek/action-0.webm'),'corrupt');
 if(mutation==='code-change')save(path.join(base,'main.cjs'),'changed-after-assembly');
 if(mutation==='version-change')save(path.join(base,'package.json'),{version:'1.9.2',animationProfile:'30fps'});
 if(mutation==='index-ownership'){const index=read(path.join(base,'assets/install-resource-index.json'));index.characters.claude.push(index.characters.deepseek.pop());save(path.join(base,'assets/install-resource-index.json'),index);}
 if(mutation==='approval-digest'){f.proof.approvedAssets.basis={...f.proof.approvedAssets.basis,approvalSha256:'f'.repeat(64)};save(path.join(f.candidate,'media-proof.json'),f.proof);}
 if(mutation==='runtime-private')save(path.join(f.candidate,'runtime/.ssh/private'),'fixture-only');
 if(mutation==='runtime-code')save(path.join(f.candidate,'runtime/AI Buddy.exe'),'tampered-runtime');
 if(mutation==='duplicate-proof'){f.proof.editions[1]={...f.proof.editions[0]};save(path.join(f.candidate,'media-proof.json'),f.proof);}
 if(!['code-change','approval-digest','runtime-private','runtime-code','duplicate-proof'].includes(mutation))f.rebind();
 const result=groupPython(f);assert.notEqual(result.status,0);assert.match(result.stderr,/ValueError:/);assert.doesNotMatch(result.stderr,/KeyError:/);
});
test('Python packaging paths reject nesting before any packaging output is created',t=>{
 const f=pythonFixture(t),out=path.join(f.candidate,'recursive-output'),driver="import importlib.util,sys;from pathlib import Path;script=Path(sys.argv[1]);sys.path.insert(0,str(script.parent));spec=importlib.util.spec_from_file_location('pkg',script);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);m.package(Path(sys.argv[2]),Path(sys.argv[3]),True)";
 const result=spawnSync(process.platform==='win32'?'py':'python3',[...process.platform==='win32'?['-3','-B']:['-B'],'-c',driver,pythonScript,f.candidate,out],{encoding:'utf8',windowsHide:true});if(result.error)throw result.error;assert.notEqual(result.status,0);assert.match(result.stderr,/input\/output overlap/);assert.equal(fs.existsSync(out),false);
});
test('Python portable scan permits only generated pointer defaults and rejects user-data lookalikes',t=>{
 const dir=temporary(t),tree=path.join(dir,'portable'),driver="import sys;from pathlib import Path;sys.path.insert(0,sys.argv[1]);from public_distribution_validation import scan_public;print(len(scan_public(Path(sys.argv[2]),allow_portable_defaults=True)))";
 for(const name of ['local/current-build.json','local/portable-defaults.json','local/install-manifests/'+ 'a'.repeat(64)+'.json'])save(path.join(tree,name),'{}');
 const args=[...process.platform==='win32'?['-3','-B']:['-B'],'-c',driver,path.dirname(pythonScript),tree],run=()=>spawnSync(process.platform==='win32'?'py':'python3',args,{encoding:'utf8',windowsHide:true}),good=run();if(good.error)throw good.error;assert.equal(good.status,0,good.stderr);assert.equal(good.stdout.trim(),'3');
 save(path.join(tree,'local/accounts-v1.sqlite'),'private-fixture');const bad=run();assert.notEqual(bad.status,0);assert.match(bad.stderr,/Private or deferred/);
});
function packagePython(f,out,operation){
 const setup="import importlib.util,sys,json,io,contextlib;from pathlib import Path;script=Path(sys.argv[1]);sys.path.insert(0,str(script.parent));spec=importlib.util.spec_from_file_location('packaging_fixture',script);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);candidate=Path(sys.argv[2]);out=Path(sys.argv[5]);bound=m.group_trees;m.group_trees=lambda value:bound(value,inventory_path=Path(sys.argv[3]),inventory_sha256=sys.argv[4]);";
 const result=spawnSync(process.platform==='win32'?'py':'python3',[...process.platform==='win32'?['-3','-B']:['-B'],'-c',setup+operation,pythonScript,f.candidate,f.inventoryPath,f.inventorySha256,out],{encoding:'utf8',windowsHide:true});if(result.error)throw result.error;return result;
}
test('Python plan-only rejects a reused packaging-plan leaf symlink and preserves external sentinel bytes',t=>{
 const f=pythonFixture(t),out=path.join(f.dir,'output'),sentinel=path.join(f.dir,'external-sentinel.txt');fs.mkdirSync(out);save(sentinel,'preserve-external-sentinel');try{fs.symlinkSync(sentinel,path.join(out,'packaging-plan.json'),'file');}catch(error){if(process.platform==='win32'&&['EPERM','EACCES'].includes(error.code)){t.skip('Windows file-symlink privilege unavailable; separate junction and injected-reparse cases cover the guard');return;}throw error;}
 const result=packagePython(f,out,'m.package(candidate,out,True)');assert.notEqual(result.status,0);assert.match(result.stderr,/Linked distribution/);assert.equal(fs.readFileSync(sentinel,'utf8'),'preserve-external-sentinel');assert.deepEqual(fs.readdirSync(out),['packaging-plan.json']);
});
test('Python resume rejects a nested output directory junction before changing any regular receipt',t=>{
 const f=pythonFixture(t),out=path.join(f.dir,'output'),external=path.join(f.dir,'external');fs.mkdirSync(path.join(out,'nested'),{recursive:true});fs.mkdirSync(external);save(path.join(out,'packaging-plan.json'),'keep-prior-plan');save(path.join(external,'sentinel.txt'),'preserve-external-directory');fs.symlinkSync(external,path.join(out,'nested/junction'),process.platform==='win32'?'junction':'dir');
 const result=packagePython(f,out,'m.package(candidate,out,True)');assert.notEqual(result.status,0);assert.match(result.stderr,/Linked distribution/);assert.equal(fs.readFileSync(path.join(out,'packaging-plan.json'),'utf8'),'keep-prior-plan');assert.equal(fs.readFileSync(path.join(external,'sentinel.txt'),'utf8'),'preserve-external-directory');
});
test('Python per-target check rejects a leaf introduced after existing-tree validation',t=>{
 const f=pythonFixture(t),out=path.join(f.dir,'output'),external=path.join(f.dir,'external'),sentinel=path.join(external,'late-sentinel.txt'),pending=path.join(f.dir,'pending-link');fs.mkdirSync(out);fs.mkdirSync(external);save(sentinel,'unchanged-after-late-link');fs.symlinkSync(external,pending,process.platform==='win32'?'junction':'dir');
 const operation="import os;original=m.group_trees;pending=out.parent/'pending-link';m.group_trees=lambda value:(os.rename(pending,out/'packaging-plan.json'),original(value))[1];m.package(candidate,out,True)";
 const result=packagePython(f,out,operation);assert.notEqual(result.status,0);assert.match(result.stderr,/Linked distribution/);assert.equal(fs.readFileSync(sentinel,'utf8'),'unchanged-after-late-link');
});
test('Python normal regular-file resume retains verified ZIPs and unrelated regular output files',t=>{
 const f=pythonFixture(t),out=path.join(f.dir,'output');fs.mkdirSync(out);save(path.join(out,'notes.txt'),'ordinary-task-output');
 const operation="capture=io.StringIO()\nwith contextlib.redirect_stdout(capture): first=m.package(candidate,out)\nbefore={p.name:(p.stat().st_mtime_ns,m.sha(p)) for p in out.glob('*.zip')}\ncapture=io.StringIO()\nwith contextlib.redirect_stdout(capture): second=m.package(candidate,out)\nafter={p.name:(p.stat().st_mtime_ns,m.sha(p)) for p in out.glob('*.zip')}\nassert before and before==after\nassert capture.getvalue().count('Verified reuse ')==len(before)\nassert first['packages']==second['packages']==len(before)\nassert (out/'notes.txt').read_text()=='ordinary-task-output'\nprint(json.dumps({'ok':True,'packages':len(before),'verifiedReuse':capture.getvalue().count('Verified reuse ')}))";
 const result=packagePython(f,out,operation);assert.equal(result.status,0,result.stderr);const value=JSON.parse(result.stdout);assert.equal(value.ok,true);assert(value.packages>20);assert.equal(value.verifiedReuse,value.packages);assert.equal(fs.readFileSync(path.join(out,'notes.txt'),'utf8'),'ordinary-task-output');
});
test('Python injected file-reparse metadata rejects a hardlinked leaf before changing its external peer',t=>{
 const f=pythonFixture(t),out=path.join(f.dir,'output'),sentinel=path.join(f.dir,'injected-sentinel.txt');fs.mkdirSync(out);save(sentinel,'preserve-injected-peer');fs.linkSync(sentinel,path.join(out,'packaging-plan.json'));
 const operation="original=Path.is_symlink;Path.is_symlink=lambda value:value==out/'packaging-plan.json' or original(value);m.package(candidate,out,True)";
 const result=packagePython(f,out,operation);assert.notEqual(result.status,0);assert.match(result.stderr,/Linked distribution/);assert.equal(fs.readFileSync(sentinel,'utf8'),'preserve-injected-peer');
});

test('Python mutable receipt replacement never truncates an external hardlink peer',t=>{
 const f=pythonFixture(t),out=path.join(f.dir,'output'),sentinel=path.join(f.dir,'hardlink-sentinel.txt');fs.mkdirSync(out);save(sentinel,'preserve-hardlink-peer');fs.linkSync(sentinel,path.join(out,'packaging-plan.json'));
 const result=packagePython(f,out,"print(json.dumps(m.package(candidate,out,True)))");assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).ok,true);assert.equal(fs.readFileSync(sentinel,'utf8'),'preserve-hardlink-peer');assert.doesNotThrow(()=>JSON.parse(fs.readFileSync(path.join(out,'packaging-plan.json'),'utf8')));
});
test('Python output target checks keep reads and copies inside the chosen output root',t=>{
 const f=pythonFixture(t),out=path.join(f.dir,'output'),outside=path.join(f.dir,'outside.txt');fs.mkdirSync(out);save(outside,'unchanged-outside');
 const operation="owner=m.OwnedOutput(out);outside=out.parent/'outside.txt'\nfor action in (lambda:owner.read_json(outside),lambda:owner.write_text(outside,'overwrite'),lambda:owner.copy_file(outside,outside)):\n try: action()\n except ValueError as error: assert 'outside owned output' in str(error)\n else: raise AssertionError('Escaped owned output')\nprint(json.dumps({'ok':True}))";
 const result=packagePython(f,out,operation);assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).ok,true);assert.equal(fs.readFileSync(outside,'utf8'),'unchanged-outside');
});
for(const fps of[30,60])test('release gate: actual accepted '+fps+'fps package/index inputs pass explicit version split', {skip:!process.env['AI_BUDDY_DISTRIBUTION_MEDIA'+fps]},()=>{
 const resources=process.env['AI_BUDDY_DISTRIBUTION_MEDIA'+fps],inventory=loadPublicAssetInventory(repo),assets=inventory.editions.find(e=>e.fps===fps),legacyLockPath=path.join(repo,'scripts/media-baselines/r192-r5.json');
 assert.equal(read(path.join(resources,'package.json')).version,'2.0.3');assert.equal(read(path.join(resources,'assets/install-resource-index.json')).appVersion,'2.0.3');
 assert.throws(()=>validateMediaBuild({resources,legacyLockPath}),/application version differs/);
 const proof=validateMediaBuild({resources,legacyLockPath,...versions,approvedMedia:inventory,assetInventory:assets.assets,sourceAssets:inventory.sourceAssets});assert.equal(proof.videos,264);assert.equal(proof.resources,4543);assert.equal(proof.mode,'optimized-public');
});
