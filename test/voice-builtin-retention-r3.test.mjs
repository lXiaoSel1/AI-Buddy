import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import io,{mkdtemp,rm} from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createBuiltinCloudVoice} from '../src/voice/builtin-cloud.mjs';
import {defaultVoiceSettings} from '../src/voice/settings.mjs';

const minute=60000,hour=60*minute,day=24*hour;
const providerId='minimax-cn', key='synthetic-retention-key', baseModel='speech-2.8-turbo';
const roles=['deepseek','qwen'];
const bytes=Uint8Array.of(82,73,70,70),sha256=createHash('sha256').update(bytes).digest('hex');
const reference={version:1,bytes,format:'wav',text:'Synthetic reference.',language:'zh',sha256};
const json=(data={})=>Response.json({base_resp:{status_code:0},...data});
const audio=()=>new Response('data: {"data":{"status":1,"audio":"0100"}}\n\ndata: {"data":{"status":2}}\n\n');
const reject=code=>json({base_resp:{status_code:code,status_msg:'Synthetic private diagnostic'}});
const op=(cloud,name,input={})=>cloud.action('builtin-cloud-'+name,input);
const retentionTest=(name,run)=>test(name,{timeout:10000},run);

async function fixture(t,respond,{lookup=voiceId=>[{voice_id:voiceId}],releaseHeldRequest}={}){
  let runMaintenance;
  t.mock.method(globalThis,'setInterval',callback=>{
    runMaintenance=callback;
    return {unref(){}};
  });
  const dataRoot=await mkdtemp(join(tmpdir(),'builtin-retention-r3-'));
  const secrets=new Map(),attempts=[],voiceLookups=[];
  let time=Date.parse('2026-01-15T00:00:00Z'),voiceId;
  const createCloud=()=>createBuiltinCloudVoice({
    dataRoot,now:()=>time,characters:()=>roles,readReference:async()=>reference,
    referenceInfo:async()=>({version:1,source:'breeze',format:'wav',durationMs:12000,language:'zh',sha256}),
    settings:{get:async()=>defaultVoiceSettings()},
    credentials:{save:async value=>{const ref='slot-'+secrets.size;secrets.set(ref,value);return {ref};},resolve:async ref=>secrets.get(ref)},
    asr:{status:async()=>({state:'missing'}),auto:async()=>{},close:async()=>{}},
    fetchImpl:async(url,{body})=>{
      const path=new URL(url).pathname;
      if(path==='/v1/files/upload')return json({file:{file_id:1234}});
      if(path==='/v1/voice_clone'){voiceId=JSON.parse(body).voice_id;return json();}
      if(path==='/v1/get_voice'){
        voiceLookups.push(true);
        return json({voice_cloning:lookup(voiceId)});
      }
      if(path==='/v1/t2a_v2'){
        const request=JSON.parse(body);
        if(!request.stream)return json({data:{status:2,audio:'0100'}});
        attempts.push({time,voiceId:request.voice_setting.voice_id,model:request.model});
        return (await respond?.(attempts.length))??audio();
      }
      throw Error('Unrecognized fixture endpoint');
    },
  });
  let cloud=createCloud();
  t.after(async()=>{
    releaseHeldRequest?.();
    try{await cloud.close();}
    finally{await rm(dataRoot,{recursive:true,force:true});}
  });
  async function save(model=baseModel,name){
    const proof=await op(cloud,'probe',{providerId,model,key});
    assert.equal(proof.ok,true);
    return op(cloud,'save',{providerId,model,key,proof:proof.proof,...(name===undefined?{}:{name})});
  }
  await save();
  await op(cloud,'route',{route:'cloud:'+providerId});
  await op(cloud,'clone',{targetCharacterId:roles[0],consentUpload:true,consentActivation:true});
  await cloud.activate();
  function tick(elapsed){
    time+=elapsed;
    const completion=runMaintenance();
    assert.ok(completion instanceof Promise,'Maintenance must expose completion for each fixture tick');
    return completion;
  }
  async function view(characterId=roles[0]){
    return (await cloud.snapshot()).characters.find(row=>row.characterId===characterId);
  }
  return {get cloud(){return cloud;},dataRoot,save,attempts,tick,view,voiceId,voiceLookups,advance:elapsed=>{time+=elapsed;},
    async reopen(){await cloud.close();cloud=createCloud();await cloud.activate();}};
}

retentionTest('automatic uncertain keepalive tries at most four times inside the due day and reports an issue',async t=>{
  const f=await fixture(t,()=>{throw Error('Synthetic disconnect after send');});
  await f.tick(6*day);
  await f.tick(15*minute);
  assert.equal(f.attempts.length,1);
  await f.tick(45*minute);
  await f.tick(hour);
  await f.tick(hour);
  await f.tick(hour);
  await f.tick(19*hour);
  assert.equal(f.attempts.length,4);
  assert.ok(f.attempts.at(-1).time-f.attempts[0].time<day);
  const row=await f.view();
  assert.deepEqual(row.retentionIssue,{reasonCode:'CLOUD_NETWORK',daysRemaining:0});
  assert.equal(row.retentionInFlight,false);
});

retentionTest('three explicit account refusals wait six hours, then a successful probe admits a fresh uncertain cycle',async t=>{
  const f=await fixture(t,index=>{
    if(index<=3)return reject([1008,2056,1004][index-1]);
    if(index===4)throw Error('Synthetic disconnect after send');
  });
  await f.tick(6*day);
  await f.tick(15*minute);
  assert.equal(f.attempts.length,1);
  assert.deepEqual((await f.view()).retentionIssue,{reasonCode:'CLOUD_MINIMAX_BALANCE',daysRemaining:0});
  await f.tick(6*hour-15*minute);
  assert.equal(f.attempts.length,2);
  await f.tick(6*hour);
  assert.equal(f.attempts.length,3);
  assert.deepEqual(await op(f.cloud,'probe',{providerId}),{ok:true,status:'ready'});
  await f.tick(15*minute);
  assert.equal(f.attempts.length,4);
  assert.deepEqual((await f.view()).retentionIssue,{reasonCode:'CLOUD_NETWORK',daysRemaining:0});
  await f.tick(15*minute);
  assert.equal(f.attempts.length,4);
  await f.tick(45*minute);
  assert.equal(f.attempts.length,5);
  assert.equal((await f.view()).retentionIssue,undefined);
});

retentionTest('an actual model change resets an uncertain budget while a new account label does not',async t=>{
  const f=await fixture(t,index=>{if(index===1)throw Error('Synthetic disconnect');});
  await f.tick(6*day);
  await f.save(baseModel,'Other label');
  await f.tick(15*minute);
  assert.equal(f.attempts.length,1);
  await f.save('speech-2.8-hd');
  await f.tick(15*minute);
  assert.equal(f.attempts.length,2);
  assert.equal(f.attempts.at(-1).model,'speech-2.8-hd');
  assert.equal((await f.view()).retentionIssue,undefined);
});

retentionTest('a held manual keepalive makes every alias busy and blocks a concurrent duplicate',async t=>{
  const entered=Promise.withResolvers(),release=Promise.withResolvers();
  const f=await fixture(t,async()=>{
    entered.resolve();
    await release.promise;
    return reject(1008);
  },{releaseHeldRequest:release.resolve});
  await op(f.cloud,'bind',{targetCharacterId:roles[1],voiceId:f.voiceId});
  await op(f.cloud,'retention',{enabled:false});
  const first=op(f.cloud,'retain',{targetCharacterId:roles[0]});
  try{
    await Promise.race([entered.promise,first.then(()=>assert.fail('Manual keepalive never entered the fixture stream'))]);
    assert.equal((await f.view(roles[0])).retentionInFlight,true);
    assert.equal((await f.view(roles[1])).retentionInFlight,true);
    assert.deepEqual(await op(f.cloud,'retain',{targetCharacterId:roles[1]}),{ok:false});
  }finally{
    release.resolve();
    await first.catch(()=>{});
  }
  assert.equal(f.attempts.length,1);
  assert.equal((await f.view()).retentionInFlight,false);
  await f.tick(8*day);
  assert.deepEqual((await f.view()).retentionIssue,{reasonCode:'CLOUD_MINIMAX_BALANCE',daysRemaining:0,expired:true});
});

retentionTest('confirmed account refusals do not consume the four-outcome uncertain budget in the same due day',async t=>{
  const f=await fixture(t,index=>{
    if(index<=3)return reject(1008);
    throw Error('Synthetic connect failure');
  });
  await f.tick(6*day);
  for(let count=0;count<3;count++)await f.tick(6*hour);
  for(let count=0;count<4;count++)await f.tick(hour);
  const origin=f.attempts[0].time;
  assert.deepEqual(f.attempts.map(row=>(row.time-origin)/hour),[0,6,12,18,19,20,21]);
});

retentionTest('distinct due clones share a durable six-hour confirmed account cooldown',async t=>{
  const f=await fixture(t,()=>reject(1008));
  const other=await op(f.cloud,'clone',{targetCharacterId:roles[1],consentUpload:true,consentActivation:true});
  assert.notEqual(other.voiceId,f.voiceId);
  await f.tick(6*day);
  assert.equal(f.attempts.length,1);
  await f.reopen();
  await f.tick(15*minute);
  assert.equal(f.attempts.length,1);
  assert.deepEqual((await f.view(roles[1])).retentionIssue,{reasonCode:'CLOUD_MINIMAX_BALANCE',daysRemaining:0});
  await f.tick(6*hour-15*minute);
  await f.tick(6*hour);
  await f.tick(6*hour);
  await f.tick(5*hour);
  const origin=f.attempts[0].time;
  assert.deepEqual(f.attempts.map(row=>(row.time-origin)/hour),[0,6,12,18]);
  await assert.rejects(op(f.cloud,'retain',{targetCharacterId:roles[1]}),{code:'CLOUD_MINIMAX_BALANCE'});
  assert.equal(f.attempts.length,5,'The fifth submission was explicitly requested');
});

for(const [result,reasonCode,delay] of [
  ['unknown','CLOUD_NETWORK',hour],['rejected','CLOUD_MINIMAX_QUOTA',6*hour],
])retentionTest('a successful recheck preserves a later '+result+' keepalive outcome',async t=>{
  const entered=Promise.withResolvers(),release=Promise.withResolvers();
  const f=await fixture(t,async index=>{
    if(index===1)return reject(1008);
    if(index!==2)return;
    entered.resolve();
    await release.promise;
    if(result==='rejected')return reject(2056);
    throw Error('Synthetic delayed response loss');
  },{releaseHeldRequest:release.resolve});
  await f.tick(6*day);
  const maintenance=f.tick(6*hour);
  try{
    await Promise.race([entered.promise,maintenance.then(()=>assert.fail('Automatic keepalive never entered the fixture stream'))]);
    assert.equal((await f.view()).retentionInFlight,true);
    assert.deepEqual(await op(f.cloud,'probe',{providerId}),{ok:true,status:'ready'});
  }finally{
    release.resolve();
    await maintenance;
  }
  assert.deepEqual((await f.view()).retentionIssue,{reasonCode,daysRemaining:0});
  await f.tick(15*minute);
  assert.equal(f.attempts.length,2);
  await f.tick(delay-15*minute);
  assert.equal(f.attempts.length,3);
  assert.equal((await f.view()).retentionIssue,undefined);
});

retentionTest('retention notices stop when the provider confirms a clone is already missing',async t=>{
  const f=await fixture(t,()=>reject(2042));
  await f.tick(6*day);
  const row=await f.view();
  assert.equal(row.state,'voice_missing');
  assert.equal(row.retentionInFlight,false);
  assert.equal(row.retentionIssue,undefined);
});


retentionTest('R4 maintenance retries a busy startup read without a voice page or playback',async t=>{
  const f=await fixture(t);
  const config=join(f.dataRoot,'voice','cloud','builtin-v1.json');
  const read=io.readFile;
  let busy=0;
  const mock=t.mock.method(io,'readFile',async (path,...args)=>{
    if(path===config&&busy===0){busy++;throw Object.assign(Error('Synthetic busy file'),{code:'EBUSY'});}
    return read(path,...args);
  });
  syncBuiltinESMExports();
  try{
    await f.reopen();
    assert.equal(busy,1);
  }finally{mock.mock.restore();syncBuiltinESMExports();}
  await f.tick(6*day);
  assert.equal(f.attempts.length,1);
});

for(const [status,respond] of [
  [401,()=>new Response(null,{status:401})],
  [403,()=>new Response(null,{status:403})],
  ...[401,403].map(status=>[status+' with JSON',()=>Response.json({base_resp:{status_code:9731}},{status})]),
])retentionTest('R4 HTTP '+status+' shares a six-hour account cooldown across two due voices',async t=>{
  const f=await fixture(t,respond);
  const other=await op(f.cloud,'clone',{targetCharacterId:roles[1],consentUpload:true,consentActivation:true});
  assert.notEqual(other.voiceId,f.voiceId);
  await f.tick(6*day);
  assert.equal((await f.cloud.snapshot()).account.status,'key_invalid');
  await f.reopen();
  for(let elapsed=1;elapsed<24;elapsed++)await f.tick(hour);
  const origin=f.attempts[0].time;
  assert.deepEqual(f.attempts.map(row=>(row.time-origin)/hour),[0,6,12,18]);
  assert.deepEqual((await f.view(roles[1])).retentionIssue,{reasonCode:'CLOUD_MINIMAX_AUTH',daysRemaining:0});
});

for(const [status,respond] of [
  [400,()=>new Response(null,{status:400})],
  [422,()=>new Response(null,{status:422})],
  ['422 with JSON',()=>Response.json({base_resp:{status_code:2013}},{status:422})],
])retentionTest('R4 HTTP '+status+' stops only the refused voice until a successful check',async t=>{
  const f=await fixture(t,index=>index===1?respond():audio());
  const other=await op(f.cloud,'clone',{targetCharacterId:roles[1],consentUpload:true,consentActivation:true});
  await f.tick(6*day);
  assert.deepEqual(f.attempts.map(row=>row.voiceId),[f.voiceId,other.voiceId]);
  if(status!=='422 with JSON')await f.reopen();
  await f.tick(hour);
  assert.deepEqual(f.attempts.map(row=>row.voiceId),[f.voiceId,other.voiceId]);
  assert.deepEqual((await f.view()).retentionIssue,{reasonCode:'CLOUD_MINIMAX_PARAMETERS',daysRemaining:0});
  assert.equal((await op(f.cloud,'probe',{providerId})).ok,true);
  await f.tick(15*minute);
  assert.deepEqual(f.attempts.map(row=>row.voiceId),[f.voiceId,other.voiceId,f.voiceId]);
  assert.equal((await f.view()).retentionIssue,undefined);
});

retentionTest('R4 HTTP 429 retains the one-hour cooldown',async t=>{
  const f=await fixture(t,index=>index===1?new Response(null,{status:429}):audio());
  await f.tick(6*day);
  await f.tick(45*minute);
  assert.equal(f.attempts.length,1);
  await f.tick(15*minute);
  assert.equal(f.attempts.length,2);
});

for(const [label,reply,delay] of [
  ['account',()=>reject(1008),6*hour],
  ['voice',()=>new Response(null,{status:429}),hour],
])retentionTest('R4 '+label+' cooldown starts once at the time a rollback is observed',async t=>{
  const f=await fixture(t,index=>index===1?reply():audio());
  await f.tick(6*day+10*hour);
  assert.equal(f.attempts.length,1);
  await f.tick(-10*hour);
  assert.equal(f.attempts.length,1);
  if(label==='voice')await f.reopen();
  await f.tick(delay-15*minute);
  assert.equal(f.attempts.length,1);
  await f.tick(15*minute);
  assert.equal(f.attempts.length,2);
});

retentionTest('R4 retention notice distinguishes the deadline from an expired voice',async t=>{
  const f=await fixture(t,()=>reject(1008));
  await f.tick(6*day);
  await f.tick(day);
  assert.deepEqual((await f.view()).retentionIssue,{reasonCode:'CLOUD_MINIMAX_BALANCE',daysRemaining:0});
  await f.tick(1);
  assert.deepEqual((await f.view()).retentionIssue,{reasonCode:'CLOUD_MINIMAX_BALANCE',daysRemaining:0,expired:true});
});


retentionTest('R4 Recheck verifies an expired clone in the account list before clearing its notice',async t=>{
  const f=await fixture(t,()=>reject(1008),{lookup:()=>[]});
  await f.tick(6*day);
  await f.tick(day+1);
  assert.equal((await f.view()).retentionIssue.expired,true);
  assert.equal((await op(f.cloud,'probe',{providerId})).ok,true);
  assert.equal(f.voiceLookups.length,1);
  assert.equal((await f.view()).state,'voice_missing');
  assert.equal(f.attempts.length,1,'checking the list cannot resubmit retention');
});

for(const [status,providerCode,reason] of [
  [429,1004,'CLOUD_MINIMAX_AUTH'],
  [429,2053,'CLOUD_MINIMAX_BALANCE'],
  [400,1004,'CLOUD_MINIMAX_AUTH'],
])retentionTest('R5 keepalive business code overrides HTTP status '+status+' for '+providerCode,async t=>{
  const f=await fixture(t,()=>Response.json({base_resp:{status_code:providerCode}},{status}));
  const other=await op(f.cloud,'clone',{targetCharacterId:roles[1],consentUpload:true,consentActivation:true});
  assert.notEqual(other.voiceId,f.voiceId);
  await f.tick(6*day);
  for(let elapsed=1;elapsed<24;elapsed++)await f.tick(hour);
  assert.equal(f.attempts.length,4,'both voices share the six-hour account gate');
  const expected={reasonCode:reason,daysRemaining:0};
  assert.deepEqual((await f.view()).retentionIssue,expected);
  assert.deepEqual((await f.view(roles[1])).retentionIssue,expected);
});

retentionTest('R5 moderation refusal spends one voice attempt until a successful recheck',async t=>{
  const f=await fixture(t,index=>index===1?reject(1026):audio());
  const other=await op(f.cloud,'clone',{targetCharacterId:roles[1],consentUpload:true,consentActivation:true});
  await f.tick(6*day);
  assert.deepEqual(f.attempts.map(row=>row.voiceId),[f.voiceId,other.voiceId]);
  await f.reopen();
  await f.tick(hour);
  assert.deepEqual(f.attempts.map(row=>row.voiceId),[f.voiceId,other.voiceId]);
  assert.deepEqual((await f.view()).retentionIssue,{reasonCode:'CLOUD_MINIMAX_PARAMETERS',daysRemaining:0});
  assert.equal((await op(f.cloud,'probe',{providerId})).ok,true);
  await f.tick(15*minute);
  assert.deepEqual(f.attempts.map(row=>row.voiceId),[f.voiceId,other.voiceId,f.voiceId]);
});

retentionTest('R5 a keepalive notice shows the last 24 hours as today',async t=>{
  const f=await fixture(t,()=>reject(1008));
  await f.tick(6*day);
  assert.equal((await f.view()).retentionIssue.daysRemaining,1);
  await f.tick(1);
  assert.deepEqual((await f.view()).retentionIssue,{reasonCode:'CLOUD_MINIMAX_BALANCE',daysRemaining:0});
});

retentionTest('R5 rolled-back playback receives an automatic keepalive six real days later',async t=>{
  const f=await fixture(t);
  await f.tick(30*day);
  await Array.fromAsync(f.cloud.speak({characterId:roles[0],text:'Clock was fast.'}));
  await f.tick(-30*day);
  await f.reopen();
  await f.tick(6*day);
  assert.equal(f.attempts.length,2,'one playback and one automatic keepalive');
  assert.equal((await f.view()).lastUsedAt,'2026-01-21T00:00:00.000Z');
});

for(const timestamp of ['activatedAt','createdAt'])retentionTest('R5 rolled-back '+timestamp+' receives an automatic keepalive six real days later',async t=>{
  const f=await fixture(t);
  const config=join(f.dataRoot,'voice','cloud','builtin-v1.json');
  const value=JSON.parse(await io.readFile(config,'utf8'));
  const row=Object.values(value.bindings).find(row=>row.voiceId===f.voiceId);
  row.lastUsedAt=null;
  if(timestamp==='createdAt')row.activatedAt=null;
  row[timestamp]='2026-02-14T00:00:00.000Z';
  await io.writeFile(config,JSON.stringify(value));
  await f.reopen();
  await f.tick(0);
  await f.reopen();
  await f.tick(6*day);
  assert.equal(f.attempts.length,1);
});

retentionTest('R5 playback after a clock rollback rewrites a future last-used timestamp immediately',async t=>{
  const f=await fixture(t);
  await f.tick(30*day);
  await Array.fromAsync(f.cloud.speak({characterId:roles[0],text:'Clock was fast.'}));
  await op(f.cloud,'retention',{enabled:false});
  await f.tick(-30*day);
  await Array.fromAsync(f.cloud.speak({characterId:roles[0],text:'Clock corrected.'}));
  await f.tick(1);
  await f.reopen();
  assert.equal((await f.view()).lastUsedAt,'2026-01-15T00:00:00.000Z');
});

retentionTest('R5 a brief snapshot after clock correction anchors the next keepalive across restart',async t=>{
  const f=await fixture(t);
  f.advance(30*day);
  await Array.fromAsync(f.cloud.speak({characterId:roles[0],text:'Clock was fast.'}));
  f.advance(-30*day);
  const corrected=(await f.view()).lastUsedAt;
  assert.equal(corrected,'2026-01-15T00:00:00.000Z');
  f.advance(6*day);
  await f.reopen();
  const before=f.attempts.length;
  await f.tick(0);
  assert.equal(f.attempts.length,before+1,'a read before the first tick must anchor the deadline durably');
});
