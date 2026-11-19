import test from 'node:test';
import assert from 'node:assert/strict';
import fsPromises from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {link,mkdir,mkdtemp,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createVoiceHost} from '../src/voice/host.mjs';
import {createBuiltinCloudVoice} from '../src/voice/builtin-cloud.mjs';
import {defaultVoiceSettings} from '../src/voice/settings.mjs';

const breeze='ai-buddy.voice-breeze',gpt='ai-buddy.voice-gpt-sovits';
const scope={characterId:'deepseek',lifeId:'life',operationId:'op',personaId:'p',channel:'app-private',conversationId:'chat'};

function interceptFs(t,module,method,intercept){
  const original=module[method];
  const mock=t.mock.method(module,method,(...args)=>intercept(original,args));
  syncBuiltinESMExports();
  t.after(()=>{mock.mock.restore();syncBuiltinESMExports();});
}

async function fixture(t){
  const root=await mkdtemp(join(tmpdir(),'builtin-recovery-'));
  const dir=join(root,'voice','cloud'),settingsFile=join(root,'voice','settings.json');
  await mkdir(dir,{recursive:true});
  const settings=defaultVoiceSettings();
  settings.enabled=true;
  settings.packages[gpt].ttsProvider='minimax';
  const original=JSON.stringify(settings);
  await writeFile(settingsFile,original);
  const instances=new Set(),prepared=[],legacy=[],fetched=[],cardAudio=Promise.withResolvers();
  const rows=['breeze','gpt'].map((engine,i)=>({engine,id:[breeze,gpt][i],installed:true,enabled:true,trusted:true,usable:true}));
  const open=()=>{
    const host=createVoiceHost({build:root,dataRoot:root,getGame:()=>({voiceScope:()=>scope,voiceCharacters:()=>[scope.characterId],voiceCancel(){}}),
      getPlatform:()=>({voicePackageStatus:()=>rows,cardGames:{voiceScopeValid:s=>s.channel==='card-table'},resolveVoicePackage:async(id,{provider})=>{prepared.push({packageId:id,speechProvider:provider});return {assertCurrent(){}};}}),
      send:event=>{if(event.envelope?.channel==='card-table'&&(event.phase==='end'||event.state==='failed'))cardAudio.resolve(event);},
      network:{fetch:async()=>{fetched.push(true);throw Error('Unexpected network request');}},components:{
        credentials:{async save(){throw Error('Unexpected secret write');},async resolve(){throw Error('Unexpected secret read');}},
        cloud:{async status(){legacy.push('status');return {state:'ready'};},async stopEngine(){},async close(){}},
        profiles:{current:async({engine})=>({id:'fixture',version:1,characterId:scope.characterId,engine}),selectedProfiles:async()=>[]},
        builtinAsr:{async status(){return {state:'missing'};},async close(){}},
        builtinReferences:{async info(){return null;}},
        assets:{async status(){return {state:'ready'};},async prepareSelected(){return {state:'ready'};},async resolve(){return {proof:'fixture-verified'};},async close(){}},
        runtime:{async prepare(request){prepared.push(request);return {ready:true};},async ready(){return {ready:true};},
          async *speak(request){prepared.push(request);yield {type:'pcm',pcm:Buffer.from([1,0]),sampleRate:24000};yield {type:'done'};},
          async stopEngine(){},async cancelCapture(){},async close(){}},
        supervisor:{async close(){}},
      }});
    instances.add(host);
    return host;
  };
  const close=async host=>{await host.close();instances.delete(host);};
  t.after(async()=>{for(const host of instances)await host.close();await rm(root,{recursive:true,force:true});});
  return {dir,root,open,close,prepared,legacy,fetched,settingsFile,original,cardAudio};
}

for(const bad of ['broken legacy JSON','hardlinked legacy','oversize legacy','broken current JSON','newer schema'])test('local speech survives '+bad+' and the original remains intact',async t=>{
  const f=await fixture(t),isLegacy=bad.includes('legacy'),future=bad==='newer schema';
  const damaged=join(f.dir,isLegacy?'bindings.json':'builtin-v1.json');
  const data=bad.startsWith('oversize')?' '.repeat(1024*1024+1):future?'{"version":2,"future":"retained"}':'{"broken":';
  if(bad.startsWith('hardlinked')){
    const other=join(f.root,'fixture-original');await writeFile(other,data);await link(other,damaged);
  }else await writeFile(damaged,data);
  const host=f.open(),view=await host.action('state');
  const issue=view.builtinCloud.storageIssue;
  assert.equal(issue.code,future?'CLOUD_STORAGE_NEWER':'CLOUD_STORAGE_INVALID');
  assert.equal(issue.canReset,!future);
  assert.equal(view.speechProvider,'local');
  await host.action('prepare',{target:'speech'});
  assert.ok(f.prepared.some(row=>row.speechProvider==='local'&&row.packageId===breeze));
  assert.ok(await host.controller.admit({...scope,requestId:'fixture-turn'}));
  assert.equal((await host.cardPresentation({})).available,true);
  if(bad==='broken legacy JSON'){
    const request={scope:{...scope,channel:'card-table',tableId:'table',handId:'hand'},eventId:'local-card',kind:'triple'};
    assert.equal((await host.cardEvent(request)).accepted,true);
    const event=await f.cardAudio.promise;
    assert.equal(event.phase,'end');
    assert.ok(f.prepared.some(row=>row.speechProvider==='local'&&row.text));
    assert.equal((await host.action('receipt',{envelope:event.envelope,status:'audioCompleted'})).accepted,true);
  }
  await assert.rejects(host.action('builtin-cloud-probe',{providerId:'minimax-cn',key:'synthetic-test-key'}),{code:issue.code});
  await assert.rejects(host.action('builtin-cloud-reset',{confirm:false}));
  if(future){
    await assert.rejects(host.action('builtin-cloud-reset',{confirm:true}),{code:'CLOUD_STORAGE_NEWER'});
    assert.deepEqual(await readdir(f.dir),['builtin-v1.json']);
  }else{
    const reset=await host.action('builtin-cloud-reset',{confirm:true});
    assert.equal(reset.storageIssue,undefined);
    await f.close(host);
    const recovered=await f.open().action('state');
    assert.equal(recovered.builtinCloud.storageIssue,undefined);
    assert.equal(recovered.speechProvider,'local');
  }
  assert.equal(await readFile(damaged,'utf8'),data);
  assert.equal(await readFile(f.settingsFile,'utf8'),f.original);
  assert.deepEqual(f.fetched,[]);
});

test('local routing wins over a legacy MiniMax flag after switching plugin and restarting',async t=>{
  const f=await fixture(t);
  const host=f.open();
  await host.action('state');
  await host.action('configure',{selectedPackageId:gpt});
  const after=await host.action('state');
  assert.deepEqual([after.builtinCloud.route,after.selectedPackageId,after.speechProvider,after.settings.packages[gpt].ttsProvider],['local:gpt',gpt,'local','local']);
  await host.action('prepare',{target:'speech'});
  assert.ok(f.prepared.some(row=>row.speechProvider==='local'&&row.packageId===gpt));
  assert.ok(await host.controller.admit({...scope,requestId:'switched-turn'}));
  assert.equal((await host.cardPresentation({})).available,true);
  const card={scope:{...scope,channel:'card-table',tableId:'table',handId:'hand'},eventId:'switched-card',kind:'triple'};
  assert.equal((await host.cardEvent(card)).accepted,true);
  const event=await f.cardAudio.promise;
  assert.equal(event.phase,'end');
  assert.ok(f.prepared.some(row=>row.text&&row.speechProvider==='local'&&row.packageId===gpt));
  await host.action('receipt',{envelope:event.envelope,status:'audioCompleted'});
  await f.close(host);
  const reopened=await f.open().action('state');
  assert.deepEqual([reopened.builtinCloud.route,reopened.selectedPackageId,reopened.speechProvider],['local:gpt',gpt,'local']);
  assert.equal(await readFile(f.settingsFile,'utf8'),f.original);
  assert.deepEqual([f.legacy,f.fetched],[[],[]]);
});

test('one busy read preserves paid records and the next cloud snapshot reads the original',async t=>{
  const f=await fixture(t),target=join(f.dir,'builtin-v1.json');
  const bytes=JSON.stringify({version:1,route:'cloud:minimax-cn',enabled:true,accounts:{},savedAccounts:{},choices:{},bindings:{},
    paidOperations:{fixture:{state:'activation-unknown'}},retentionAttempts:{}});
  await writeFile(target,bytes);
  let busy=true;
  interceptFs(t,fsPromises,'readFile',(original,args)=>{
    if(args[0]===target&&busy){busy=false;throw Object.assign(Error('synthetic busy read'),{code:'EBUSY'});}
    return original(...args);
  });
  const cloud=createBuiltinCloudVoice({dataRoot:f.root,characters:()=>[],settings:{get:async()=>defaultVoiceSettings()},asr:{status:async()=>({}),close:async()=>{}}});
  t.after(()=>cloud.close());
  const first=await cloud.snapshot();
  assert.equal(first.status,'unavailable');
  assert.equal(first.storageIssue.canReset,false);
  assert.equal(first.storageIssue.code,'CLOUD_STORAGE_UNAVAILABLE');
  const next=await cloud.snapshot();
  assert.deepEqual([next.storageIssue,next.route,next.enabled],[undefined,'cloud:minimax-cn',true]);
  await assert.rejects(cloud.action('builtin-cloud-reset',{confirm:true}),{code:'VOICE_ACTION_INVALID'});
  assert.equal(await readFile(target,'utf8'),bytes);
  assert.deepEqual(await readdir(f.dir),['builtin-v1.json']);
});

for(const {filename,code} of [
  {filename:'builtin-v1.json',code:'EPERM'},
  {filename:'builtin-local-fallback-v1.json',code:'EBUSY'},
])test(`local selection persists through a transient ${code} rename of ${filename}`,{skip:process.platform!=='win32'},async t=>{
  const f=await fixture(t),host=f.open();
  const main=join(f.dir,'builtin-v1.json'),voice=join(f.root,'voice');
  const sidecar=code==='EBUSY',target=sidecar?join(voice,filename):main;
  if(sidecar)await writeFile(main,'{"damaged":');
  await host.action('state');
  const original=await readFile(main,'utf8');
  const attempts=[];
  interceptFs(t,fsPromises,'rename',(rename,args)=>{
    if(args[1]===target){
      attempts.push(args[0]);
      if(attempts.length===1)throw Object.assign(Error('synthetic sharing violation'),{code});
    }
    return rename(...args);
  });
  await host.action('configure',{selectedPackageId:gpt,enabled:false});
  assert.equal(attempts.length,2);
  assert.equal(attempts[0],attempts[1]);
  const updated=JSON.parse(await readFile(target,'utf8'));
  assert.deepEqual(updated,sidecar?{version:1,route:'local:gpt',localEnabled:false}:
    {...JSON.parse(original),route:'local:gpt',enabled:false,localEnabled:false});
  if(sidecar)assert.equal(await readFile(main,'utf8'),original);
  assert.deepEqual((await readdir(sidecar?voice:f.dir)).filter(name=>name.endsWith('.partial')),[]);
  await f.close(host);
  const reopened=await f.open().action('state');
  assert.deepEqual([reopened.builtinCloud.route,reopened.selectedPackageId,reopened.settings.enabled],['local:gpt',gpt,false]);
});

test('a failed migration write still permits local state and prepare, then retries successfully',async t=>{
  const f=await fixture(t),target=join(f.dir,'builtin-v1.json');
  let blocked=true;const failedCandidates=[];
  interceptFs(t,fsPromises,'rename',(original,args)=>{
    if(args[1]===target&&blocked){failedCandidates.push(args[0]);throw Object.assign(Error('synthetic migration write failure'),{code:'EIO'});}
    return original(...args);
  });
  const host=f.open(),view=await host.action('state');
  assert.deepEqual([view.speechProvider,view.builtinCloud.storageIssue?.canReset],['local',false]);
  await host.action('prepare',{target:'speech'});
  assert.ok(f.prepared.some(row=>row.packageId===breeze&&row.speechProvider==='local'));
  assert.ok(failedCandidates.length>=1);
  await assert.rejects(readFile(target,'utf8'),{code:'ENOENT'});
  blocked=false;
  const recovered=await host.action('state');
  assert.equal(recovered.builtinCloud.storageIssue,undefined);
  assert.equal(JSON.parse(await readFile(target,'utf8')).version,1);
  for(const candidate of failedCandidates)assert.equal(JSON.parse(await readFile(candidate,'utf8')).version,1);
  assert.deepEqual(f.fetched,[]);
});

for(const originalCloud of ['{"broken":','{"version":2,"opaque":"future"}'])test('local selection and switch survive restart with '+(originalCloud.includes('version')?'future':'damaged')+' cloud settings',async t=>{
  const f=await fixture(t),target=join(f.dir,'builtin-v1.json');
  await writeFile(target,originalCloud);
  const host=f.open();
  await host.action('configure',{selectedPackageId:gpt,enabled:false});
  await f.close(host);
  const reopened=f.open(),view=await reopened.action('state');
  assert.deepEqual([view.builtinCloud.route,view.selectedPackageId,view.settings.enabled,view.speechProvider],['local:gpt',gpt,false,'local']);
  assert.equal(await readFile(target,'utf8'),originalCloud);
  assert.deepEqual(await readdir(f.dir),['builtin-v1.json']);
  assert.equal(await readFile(f.settingsFile,'utf8'),f.original);
  assert.deepEqual(f.fetched,[]);
  if(originalCloud.includes('broken')){
    await f.close(reopened);
    const original=JSON.stringify({version:1,route:'cloud:minimax-cn',enabled:true,accounts:{},savedAccounts:{},choices:{},bindings:{},paidOperations:{fixture:{state:'submitted'}}});
    await writeFile(target,original);
    const restored=f.open(),local=await restored.action('state');
    assert.deepEqual([local.builtinCloud.storageIssue,local.selectedPackageId,local.settings.enabled],[undefined,gpt,false]);
    const restoredSettings=JSON.parse(await readFile(target,'utf8'));
    assert.deepEqual([restoredSettings.route,restoredSettings.enabled,restoredSettings.localEnabled],['local:gpt',false,false]);
    const sidecar=join(f.root,'voice','builtin-local-fallback-v1.json');
    await assert.rejects(readFile(sidecar),{code:'ENOENT'});
    await writeFile(sidecar,'{"damaged":');
    await f.close(restored);
    const verified=f.open(),verifiedState=await verified.action('state');
    assert.deepEqual([verifiedState.builtinCloud.route,verifiedState.selectedPackageId,verifiedState.settings.enabled],['local:gpt',gpt,false]);
    await verified.action('configure',{selectedPackageId:breeze,enabled:true});
    await f.close(verified);
    const updated=await f.open().action('state');
    assert.deepEqual([updated.selectedPackageId,updated.settings.enabled],[breeze,true]);
    assert.equal(JSON.parse(await readFile(target,'utf8')).paidOperations.fixture.state,'submitted');
  }
});

test('reset confirmation rechecks a damaged file and a busy read preserves the originals',async t=>{
  const f=await fixture(t),target=join(f.dir,'builtin-v1.json');
  await writeFile(target,'{"broken":');
  const host=f.open();
  assert.equal((await host.action('state')).builtinCloud.storageIssue.canReset,true);
  let busy=true;
  interceptFs(t,fsPromises,'readFile',(original,args)=>{
    if(args[0]===target&&busy){busy=false;throw Object.assign(Error('synthetic busy read'),{code:'EBUSY'});}
    return original(...args);
  });
  await assert.rejects(host.action('builtin-cloud-reset',{confirm:true}),{code:'CLOUD_STORAGE_UNAVAILABLE'});
  assert.equal(await readFile(target,'utf8'),'{"broken":');
  assert.deepEqual(await readdir(f.dir),['builtin-v1.json']);
  assert.equal((await host.action('state')).builtinCloud.storageIssue.code,'CLOUD_STORAGE_INVALID');
});

test('R6 a permanently blocked clock correction keeps voice state readable and a later read retries',async t=>{
  const f=await fixture(t),target=join(f.dir,'builtin-v1.json');
  const future=new Date(Date.now()+7*86400000).toISOString();
  const account={id:'synthetic-clock-account',providerId:'minimax-cn',fingerprint:'f'.repeat(16),model:'speech-2.8-turbo'};
  const roleKey=account.providerId+':'+account.fingerprint+':'+scope.characterId;
  const bindingKey='cloud:'+roleKey+':fixture:1';
  const original={version:1,route:'cloud:minimax-cn',enabled:true,accounts:{'minimax-cn':account},
    savedAccounts:{[account.id]:account},choices:{[roleKey]:bindingKey},bindings:{[bindingKey]:{
      kind:'clone',state:'ready',voiceId:'SyntheticClockVoice',lastUsedAt:future,activatedAt:future,createdAt:future,
    }}};
  await writeFile(target,JSON.stringify(original));
  let blocked=true,attempts=0;
  interceptFs(t,fsPromises,'rename',(rename,args)=>{
    if(args[1]===target){
      attempts++;
      if(blocked)throw Object.assign(Error('synthetic persistent sharing violation'),{code:'EPERM'});
    }
    return rename(...args);
  });
  const host=f.open(),t0=Date.now();
  for(let pass=1;pass<=2;pass++){
    const view=await host.action('state');
    const row=view.builtinCloud.characters.find(row=>row.characterId===scope.characterId);
    assert.equal(view.builtinCloud.route,'cloud:minimax-cn');
    assert.equal(view.builtinCloud.storageIssue,undefined);
    assert.equal(row.voiceId,'SyntheticClockVoice');
    assert.equal(row.due,false);
    assert.ok(Date.parse(row.lastUsedAt)>=t0&&Date.parse(row.lastUsedAt)<=Date.now());
    assert.equal(attempts,pass,'a read can try correction once without waiting for rename backoff');
  }
  assert.deepEqual(JSON.parse(await readFile(target,'utf8')),original);
  blocked=false;
  const retry=await host.action('state');
  assert.equal(retry.builtinCloud.storageIssue,undefined);
  assert.equal(attempts,3);
  const corrected=JSON.parse(await readFile(target,'utf8')).bindings[bindingKey];
  for(const field of ['lastUsedAt','activatedAt','createdAt']){
    assert.ok(Date.parse(corrected[field])>=t0&&Date.parse(corrected[field])<=Date.now());
  }
  assert.deepEqual(f.fetched,[]);
});

test('R6 a closing service cancels an in-flight optional clock correction',async t=>{
  const f=await fixture(t),target=join(f.dir,'builtin-v1.json');
  await writeFile(target,JSON.stringify({version:1,route:'local:breeze',enabled:false,accounts:{},choices:{},
    savedAccounts:{},bindings:{fixture:{lastUsedAt:new Date(Date.now()+86400000).toISOString()}}}));
  const entered=Promise.withResolvers(),release=Promise.withResolvers();
  interceptFs(t,fsPromises,'open',async(open,args)=>{
    if(args[0].startsWith(target+'.')&&args[0].endsWith('.partial')){
      entered.resolve();
      await release.promise;
    }
    return open(...args);
  });
  let closed=false,statusAfterClose=false;
  const cloud=createBuiltinCloudVoice({dataRoot:f.root,characters:()=>[],settings:{get:async()=>defaultVoiceSettings()},
    asr:{status:async()=>{statusAfterClose ||= closed;return {};},close:async()=>{closed=true;}}});
  const reading=cloud.snapshot();
  let shutdown;
  try{
    await Promise.race([entered.promise,reading.then(()=>assert.fail('The correction must reach staging'))]);
    shutdown=cloud.close();
    release.resolve();
    await assert.rejects(reading,{code:'CLOUD_CLOSED'});
    assert.equal(statusAfterClose,false);
  }finally{
    release.resolve();
    await Promise.allSettled([reading,shutdown??cloud.close()]);
  }
});
