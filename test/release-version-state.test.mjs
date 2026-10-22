import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {checkReleaseVersion,checkResourceVersion} from '../scripts/check-release-version.mjs';

function fixture(t,{version='1.9.0',publishedVersion='1.8.0',stage='approved',metadata=true,resourceBaseVersion='1.8.0',installerVersion='1.8.0'}={}){
 const base=process.env.AI_BUDDY_VERSION_TEST_ROOT||tmpdir();mkdirSync(base,{recursive:true});const root=mkdtempSync(join(base,'release-version-state-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const save=(path,value)=>writeFileSync(join(root,path),typeof value==='string'?value:JSON.stringify(value));
 save('package.json',{version});save('package-lock.json',{version,packages:{'':{version}}});
 if(metadata)save('release.json',{schemaVersion:1,version,stage,publishedVersion,resourceBaseVersion,installerVersion});
 const marker=metadata?`<!-- ai-buddy-source-version: ${version} -->\n`:'';
 for(const file of['README.md','README.en.md'])save(file,marker+`Source ${version}.\nCurrent published: [v${publishedVersion}](https://github.com/lXiaoSel1/ai-buddy/releases/tag/v${publishedVersion})\n`+`[Installer](https://github.com/lXiaoSel1/AI-Buddy/releases/download/v${publishedVersion}/AI-Buddy-Setup-${publishedVersion}-win-x64.exe)\nAI-Buddy-${publishedVersion}-Windows-x64-30fps.zip.part01\n`);
 mkdirSync(join(root,'docs'));save('docs/BUILD.md',`The formal ${version} binary requires packaging and verification before publication.`);
 const patch=(path,fn)=>save(path,fn(path.endsWith('.json')?JSON.parse(readFileSync(join(root,path),'utf8')):readFileSync(join(root,path),'utf8')));
 return {root,save,patch};
}

test('approved 1.9 source keeps real 1.8 downloads and explicit resource/installer provenance',t=>{
 const f=fixture(t);assert.deepEqual(checkReleaseVersion(f.root),{ok:true,version:'1.9.0',stage:'approved',publishedVersion:'1.8.0',resourceBaseVersion:'1.8.0',installerVersion:'1.8.0'});
});
test('published stage requires the published release to equal the source version',t=>{
 const f=fixture(t,{stage:'published'});assert.throws(()=>checkReleaseVersion(f.root),/Published source/);
 const correct=fixture(t,{stage:'published',publishedVersion:'1.9.0',installerVersion:'1.9.0'});assert.equal(checkReleaseVersion(correct.root).stage,'published');
});
test('package lock root and top-level versions both remain mandatory',t=>{
 const f=fixture(t);f.patch('package-lock.json',value=>({...value,version:'1.8.0'}));assert.throws(()=>checkReleaseVersion(f.root),/package-lock/);
 f.patch('package-lock.json',value=>({...value,version:'1.9.0',packages:{'':{version:'1.8.0'}}}));assert.throws(()=>checkReleaseVersion(f.root),/package-lock/);
});
test('unknown schema, stage, missing fields and mismatched source metadata fail closed',t=>{
 for(const patch of[{schemaVersion:2},{stage:'latest'},{version:'1.8.0'},{resourceBaseVersion:null},{installerVersion:'v1.8.0'},{publishedVersion:'not-a-version'}]){
  const f=fixture(t);f.patch('release.json',value=>({...value,...patch}));assert.throws(()=>checkReleaseVersion(f.root),/Invalid release.json/);
 }
});
test('metadata cannot silently authorize a future published, resource or installer version',t=>{
 for(const key of['publishedVersion','resourceBaseVersion','installerVersion']){const f=fixture(t);f.patch('release.json',value=>({...value,[key]:'2.0.0'}));assert.throws(()=>checkReleaseVersion(f.root),/future version/);}
});
test('both readmes need one current source marker; a stale or duplicate marker is rejected',t=>{
 for(const file of['README.md','README.en.md'])for(const mode of['missing','stale','duplicate']){const f=fixture(t);f.patch(file,text=>mode==='missing'?text.replace(/<!--[^\n]+-->\n/,''):mode==='stale'?text.replace('source-version: 1.9.0','source-version: 1.8.0'):text+'\n<!-- ai-buddy-source-version: 1.9.0 -->');assert.throws(()=>checkReleaseVersion(f.root),/source-version marker/);}
});
test('installer names and release-download URL tags both follow the actual published version',t=>{
 for(const patch of[text=>text.replaceAll('AI-Buddy-Setup-1.8.0','AI-Buddy-Setup-1.9.0'),text=>text.replace('/download/v1.8.0/','/download/v1.9.0/')]){const f=fixture(t);f.patch('README.md',patch);assert.throws(()=>checkReleaseVersion(f.root),/download (version|URL)/);}
});
test('approved source cannot link to a not-yet-published source release',t=>{
 const f=fixture(t);f.patch('README.en.md',text=>text+'\n[Not available](https://github.com/lXiaoSel1/AI-Buddy/releases/tag/v1.9.0)');assert.throws(()=>checkReleaseVersion(f.root),/unpublished source release/);
});
test('build guide tracks the source version rather than the published download version',t=>{
 const f=fixture(t);f.save('docs/BUILD.md','The formal 1.8.0 binary is available.');assert.throws(()=>checkReleaseVersion(f.root),/Build guide/);
});
test('legacy repositories without release.json retain original same-version release checks',t=>{
 const f=fixture(t,{version:'1.8.0',metadata:false});assert.deepEqual(checkReleaseVersion(f.root),{ok:true,version:'1.8.0'});
 f.patch('README.md',text=>text.replace('AI-Buddy-1.8.0-Windows','AI-Buddy-1.7.10-Windows'));assert.throws(()=>checkReleaseVersion(f.root),/download version/);
});
test('resource reuse accepts only the current version or one explicitly declared compatible baseline',()=>{
 const state={version:'1.9.0',resourceBaseVersion:'1.8.0'};
 assert.deepEqual(checkResourceVersion('1.9.0','1.9.0',state),{sourceVersion:'1.9.0',resourceVersion:'1.9.0',reused:false});
 assert.equal(checkResourceVersion('1.9.0','1.8.0',state).reused,true);
 assert.throws(()=>checkResourceVersion('1.9.0','1.7.10',state),/declared resourceBaseVersion/);
 assert.throws(()=>checkResourceVersion('1.9.0','1.8.0',{version:'1.8.0',resourceBaseVersion:'1.8.0'}),/does not match source/);
 assert.throws(()=>checkResourceVersion('1.9.0','1.8.0',{version:'1.9.0'}),/declared resourceBaseVersion/);
});
