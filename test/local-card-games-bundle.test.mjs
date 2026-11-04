import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {gzipSync} from 'node:zlib';
import {createLocalCardGamesBundle,LOCAL_CARD_GAMES} from '../src/local-card-games-bundle.mjs';
import {pluginPageEntries} from '../src/plugin-embed-targets.mjs';

const {packageName,exactVersion,capabilities}=LOCAL_CARD_GAMES;
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
function makeArchive(manifest){
  const body=Buffer.from(JSON.stringify(manifest)),header=Buffer.alloc(512);
  header.write('package/package.json');header.write(body.length.toString(8).padStart(11,'0')+'\0',124);
  header.fill(32,148,156);header.write('0',156);
  header.write(header.reduce((sum,byte)=>sum+byte,0).toString(8).padStart(6,'0')+'\0 ',148);
  return gzipSync(Buffer.concat([header,body,Buffer.alloc((512-body.length%512)%512+1024)]));
}
async function write(path,bytes){await mkdir(dirname(path),{recursive:true});await writeFile(path,bytes);}
const manifest={name:packageName,version:exactVersion,aiBuddy:{capabilities,voiceGamesContractVersion:'voice-games-v1'}};
async function fixture(t,selectedManifest=manifest){
  const root=await mkdtemp(join(tmpdir(),'lcg-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const build=join(root,'build'),dataRoot=join(root,'data'),archive=join(build,'bundled-plugins','card-games.tgz'),lock=join(root,'runtime-lock.json');
  const bytes=makeArchive(selectedManifest),digest=sha(bytes),calls=[];
  await write(archive,bytes);await write(lock,JSON.stringify({paths:{bridge:'bridge.mjs'}}));
  await write(join(build,'dsh-platform','native-bridge-host.mjs'),'export {};');
  let foreign=false,failActivation=false,nativeEvent;
  const options={build,dataRoot,digest,selectedRuntimeLock:()=>lock,foreignInstalled:()=>foreign,
    voiceGamesServices:{revoke:async id=>{calls.push(['revoke',id]);}},
    clientHost:{open:async(descriptor,{panel,surface})=>({runtimeId:descriptor.runtimeId,panel,surface}),closeRuntime:async id=>{calls.push(['close-page',id]);}},
    backendFactory({dshHome,stateDir,profileId,onEvent}){
      nativeEvent=onEvent;const runtimeId='test-runtime-'+calls.length;
      const profile=join(dshHome,'profiles',profileId),installed=join(profile,'node_modules','@ai-buddy','card-games','package.json');
      let bundle=null;
      return {
        async openClient(){calls.push(['start',runtimeId]);if(await readFile(installed).catch(()=>null))bundle={name:packageName,version:exactVersion,enabled:false,installed:true};return {runtimeId,profileId,authURL:'http://private.example/?secret=unused'};},
        async snapshot(){return {bundles:bundle?[bundle]:[],plugins:[]};},
        async planInstall({packageRef,grantedCapabilities}){calls.push(['plan',grantedCapabilities]);return {packageRef,artifactSha256:digest};},
        async install(plan,{enabled}){
          assert.equal(enabled,false);calls.push(['install']);
          const cache=join(stateDir,'verified-packages',digest+'.tgz');
          await write(cache,bytes);await write(installed,JSON.stringify(selectedManifest));
          await write(join(profile,'package.json'),JSON.stringify({name:'dsh-profile-'+profileId,private:true,dependencies:{[packageName]:'file:'+cache.replaceAll('\\','/')},dsh:{profile:{bundles:['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app',packageName]}}}));
          const {hostPluginId:pluginId}=plan.packageRef;
          await write(join(stateDir,'package-identities.json'),JSON.stringify({[packageName]:{packageName,pluginId,exactVersion,sourceDigest:digest}}));
          bundle={name:packageName,version:exactVersion,enabled,installed:true};
        },
        async enable(){calls.push(['enable']);bundle.enabled=true;return {enabled:true,activation:{observed:!failActivation,packageName,version:exactVersion,entries:[{enabled:true,fiberPhase:'active'}]}};},
        async disable(){calls.push(['disable']);bundle.enabled=false;return {enabled:false,application:'applied'};},
        verifySocialUI:()=>true,
        async close(){calls.push(['stop',runtimeId]);return {stopped:true,code:0};},
      };
    }};
  const create=()=>createLocalCardGamesBundle(options);
  return {archive,bytes,calls,options,create,setForeign:value=>{foreign=value;},failEnable:()=>{failActivation=true;},exit:()=>nativeEvent({kind:'runtime-exit',code:1})};
}

test('bundled cards require a compiled pin and exact archive digest, identity and four capabilities before any spawn',async t=>{
  const a=await fixture(t);
  assert.equal(await createLocalCardGamesBundle({...a.options,digest:null}),null);
  await writeFile(a.archive,Buffer.concat([a.bytes,Buffer.from('tampered')]));
  const one=await a.create();
  await assert.rejects(one.install(),{code:'LOCAL_CARD_GAMES_INTEGRITY'});assert.deepEqual(a.calls,[]);
  await one.close();
  const b=await fixture(t,{...manifest,aiBuddy:{...manifest.aiBuddy,capabilities:[...capabilities,'social.send']}});
  const two=await b.create();
  await assert.rejects(two.install(),{code:'LOCAL_CARD_GAMES_INTEGRITY'});assert.deepEqual(b.calls,[]);
  await two.close();
});

test('same pinned package installs once, restores privately on reopen, then revokes on disable or runtime loss',async t=>{
  const f=await fixture(t);
  let cards=await f.create();
  assert.equal(cards.status().phase,'not-installed');
  const [first,second]=await Promise.all([cards.install(),cards.install()]);
  assert.deepEqual(first,second);assert.equal(first.phase,'loaded');
  assert.equal(f.calls.filter(([event])=>event==='install').length,1);
  const record=cards.publicRecord();
  assert.deepEqual(cards.grant(record).granted,capabilities);
  assert.equal(cards.grant({...record,sourceDigest:'0'.repeat(64)}),null);
  assert.equal(cards.grant({...record,pluginId:'dsh.other'}),null);
  assert.deepEqual(pluginPageEntries([record]).map(([page])=>page),['plugin-card-games']);
  const surface=()=>{};
  const opened=await cards.open(surface);
  assert.equal(opened.surface,surface);assert.equal(opened.panel,packageName);assert.equal(Object.hasOwn(opened,'authURL'),false);
  await cards.close();
  cards=await f.create();
  assert.equal(cards.status().phase,'pending-load');
  assert.equal(cards.grant(record),null);
  assert.equal((await cards.activate()).phase,'loaded');
  f.exit();
  assert.equal(cards.grant(record),null);
  await cards.activate();
  const disabled=await cards.disable();
  assert.equal(disabled.phase,'disabled');assert.equal(cards.grant(record),null);
  assert.deepEqual(pluginPageEntries([cards.publicRecord()]),[]);
  assert.ok(f.calls.some(([event,id])=>event==='revoke'&&id===record.pluginId));
  await assert.rejects(cards.open(null),{code:'PLUGIN_DISABLED'});
  await cards.close();
  cards=await f.create();
  assert.equal((await cards.install()).phase,'disabled');
  assert.equal((await cards.enable()).runtimeVerified,true);
  assert.equal(f.calls.filter(([event])=>event==='install').length,1);
  await cards.close();
});

test('preflight refuses modified installed bytes, modified DSH config or another installed owner before starting',async t=>{
  for(const tamper of ['archive-member','configuration','foreign']){
    const f=await fixture(t);let cards=await f.create();
    await cards.install();await cards.close();
    const profile=join(f.options.dataRoot,'plugin-runtimes','dsh-card-games','profiles','buddy-card-games-v1');
    if(tamper==='archive-member')await write(join(profile,'node_modules','@ai-buddy','card-games','extra.mjs'),'extra');
    if(tamper==='configuration')await write(join(profile,'cordis.patch.yml'),'- insert: [{name: unverified}]\n');
    if(tamper==='foreign')f.setForeign(true);
    const starts=f.calls.filter(([event])=>event==='start').length;
    cards=await f.create();
    await assert.rejects(cards.activate(),{code:{'archive-member':'DSH_INSTALLED_ARTIFACT_MISMATCH',configuration:'LOCAL_CARD_GAMES_INTEGRITY',foreign:'LOCAL_CARD_GAMES_IDENTITY_CONFLICT'}[tamper]});
    assert.equal(f.calls.filter(([event])=>event==='start').length,starts);
    assert.equal(cards.status().runtimeVerified,false);
    await cards.close();
  }
});

test('failed native enable never grants authority and can retry the already verified archive',async t=>{
  const f=await fixture(t);f.failEnable();
  const cards=await f.create();
  await assert.rejects(cards.install(),{code:'DSH_ACTIVATION_FAILED'});
  assert.equal(cards.status().phase,'failed');
  assert.equal(cards.status().installed,false);
  assert.equal(cards.publicRecord(),null);
  assert.ok(f.calls.some(([event])=>event==='stop'));
  await cards.close();
});
