import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {verifyInstalledDshArtifact} from '../src/dsh-platform/installed-artifact.mjs';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
async function fixture(t){const profileRoot=await mkdtemp(join(tmpdir(),'buddy-native-existing-'));t.after(()=>rm(profileRoot,{recursive:true,force:true}));const root=join(profileRoot,'node_modules','controlled-native');await mkdir(join(root,'lib'),{recursive:true});const entries={'package.json':JSON.stringify({name:'controlled-native',version:'1.0.0'}),'lib/index.js':'export const actual=true;'},files=new Map();for(const [name,body]of Object.entries(entries)){await writeFile(join(root,name),body);files.set(name,hash(body));}return{root,profileRoot,packageName:'controlled-native',exactVersion:'1.0.0',files};}
test('existing native package must match all approved archive bytes and the exact entry closure',async t=>{const f=await fixture(t),result=await verifyInstalledDshArtifact(f);assert.equal(result.verified,true);assert.equal(result.files,2);assert.equal(result.closure,'exact-archive-files-and-directories');});
test('extra executable, missing file, altered byte and wrong manifest version are denied',async t=>{
 for(const change of ['extra','missing','byte','version']){const f=await fixture(t);if(change==='extra')await writeFile(join(f.root,'lib/extra.js'),'unapproved');if(change==='missing')await rm(join(f.root,'lib/index.js'));if(change==='byte')await writeFile(join(f.root,'lib/index.js'),'altered');if(change==='version')f.exactVersion='2.0.0';await assert.rejects(verifyInstalledDshArtifact(f),{code:'DSH_INSTALLED_ARTIFACT_MISMATCH'});}
});
test('nested symbolic links and package root redirected outside the private profile are denied',async t=>{
 const f=await fixture(t),linkedDir=await mkdtemp(join(tmpdir(),'buddy-native-linked-dir-'));t.after(()=>rm(linkedDir,{recursive:true,force:true}));await writeFile(join(linkedDir,'index.js'),'export const actual=true;');await rm(join(f.root,'lib'),{recursive:true});await symlink(linkedDir,join(f.root,'lib'),'junction');await assert.rejects(verifyInstalledDshArtifact(f),{code:'DSH_INSTALLED_ARTIFACT_MISMATCH'});
 const redirected=await fixture(t),outside=await mkdtemp(join(tmpdir(),'buddy-native-outside-'));t.after(()=>rm(outside,{recursive:true,force:true}));await rm(redirected.root,{recursive:true});await symlink(outside,redirected.root,'junction');await assert.rejects(verifyInstalledDshArtifact(redirected),{code:'DSH_INSTALLED_ARTIFACT_MISMATCH'});
});
