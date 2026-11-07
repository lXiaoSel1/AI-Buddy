import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {createVoiceCloud} from '../src/voice/cloud.mjs';

const params = {engine:'breeze',packageId:'ai-buddy.voice-breeze',characterId:'whale',profileId:'voice1',profileVersion:1};

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(),'buddy-formal-cloud-'));
  const script = join(root,'worker.mjs');
  const reference=Buffer.alloc(44+320000);reference.write('RIFF');reference.write('WAVE',8);
  const referencePath=join(root,'approved.wav');await writeFile(referencePath,reference);
  await writeFile(script, `
import {createInterface} from 'node:readline';
const input = createInterface({input:process.stdin});
for await (const line of input) {
  const request = JSON.parse(line);
  const send = row => process.stdout.write(JSON.stringify(row)+'\\n');
  if (request.op === 'voices') send({type:'result',voices:[{voice_id:'private-whale',name:'whale'}]});
  else if (request.op === 'clone') {send({type:'stage',stage:'uploaded',file_id:123});send({type:'stage',stage:'clone-request-submitted',file_id:123});send({type:'result',voice_id:request.voiceId});}
  else if (request.op === 'speak') {
    if (request.text === 'pending') continue;
    if (request.text === 'rate-limit') {send({type:'error',code:'CLOUD_REMOTE_1002',message:request.key});process.exitCode=1;break;}
    send({type:'pcm',sample_rate:32000,pcm:'AQACAA=='});
    send({type:'done',metrics:{voice_id:request.voiceId,first_pcm_seconds:0.01,audio_seconds:0.1}});
  }
  break;
}
input.close();
process.stdin.destroy();
`);
  let key = 'private-test-key';
  const admitted = new Map();
  const cloud = createVoiceCloud({dataRoot:root,
    resolveRuntime: async () => ({python:process.execPath,script,root,cacheRoot:root,proof:'fixture-v1'}),
    resolveConnection: async () => ({provider:'minimax',model:'speech-2.8-turbo',keyRef:'host-vault-ref'}),
    resolveSecret: async ref => {assert.equal(ref,'host-vault-ref');return key;},
    resolveProfile: async request => ({id:request.profileId,version:request.profileVersion,characterId:request.characterId,
      cloudReference:{path:referencePath,authorized:true,bytes:reference.length,sha256:createHash('sha256').update(reference).digest('hex'),durationMs:10000,text:'已批准完整参考'}}),
    supervisor:{
      async registerRoot({runtimeId,pid}) { admitted.set(runtimeId,pid); },
      async releaseRoot({runtimeId}) {const pid=admitted.get(runtimeId);try {process.kill(pid);} catch {} admitted.delete(runtimeId);return {stopped:true};},
    },
  });
  t.after(async () => {await cloud.close();await rm(root,{recursive:true,force:true});});
  return {cloud,admitted,changeKey:()=>key='a-different-private-key'};
}

test('cloud requires explicit per-account per-character binding and preserves real PCM rate', async t => {
  const {cloud,admitted,changeKey} = await fixture(t);
  await assert.rejects(Array.fromAsync(cloud.speak({...params,text:'你好'})),{code:'CLOUD_VOICE_REQUIRED'});
  assert.equal(admitted.size,0,'unbound voice must not start a paid synthesis');
  await cloud.bindVoice({...params,voiceId:'private-whale'});
  const events = await Array.fromAsync(cloud.speak({...params,text:'你好'}));
  assert.equal(events.find(row=>row.type==='pcm').sampleRate,32000);
  assert.deepEqual(events.find(row=>row.type==='pcm').pcm,Buffer.from([1,0,2,0]));
  assert.equal(events.at(-1).type,'done');
  await assert.rejects(cloud.bindVoice({...params,characterId:'another',voiceId:'private-whale'}),{code:'CLOUD_VOICE_SCOPE'});
  changeKey();
  await assert.rejects(Array.fromAsync(cloud.speak({...params,text:'你好'})),{code:'CLOUD_VOICE_REQUIRED'});
  assert.equal(admitted.size,0);
});

test('upload requires explicit consent, cloned binding persists, and stale profile versions cannot use it', async t => {
  const {cloud,admitted} = await fixture(t);
  const preview=await cloud.previewPlan(params);
  assert.equal(preview.remoteUpload,true);
  assert.equal(admitted.size,0);
  await assert.rejects(cloud.prepareVoice(params),{code:'CLOUD_CONSENT'});
  const prepared=await cloud.prepareVoice({...params,consentUpload:true});
  assert.equal(prepared.state,'ready');
  assert.equal(prepared.cloudListeningAcceptance,'pending');
  assert.equal((await cloud.status(params)).voiceId,prepared.voiceId);
  assert.equal((await cloud.status({...params,profileVersion:2})).state,'unbound');
  assert.equal(JSON.stringify(prepared).includes('private-test-key'),false);
});

test('rate-limited paid segments are not replayed and upstream text cannot leak credentials', async t => {
  const {cloud,admitted} = await fixture(t);
  await cloud.bindVoice({...params,voiceId:'private-whale'});
  await assert.rejects(Array.fromAsync(cloud.speak({...params,text:'rate-limit'})),error=>{
    assert.equal(error.code,'CLOUD_REMOTE_1002');
    assert.equal(error.message.includes('private-test-key'),false);
    return true;
  });
  assert.equal(admitted.size,0);
  assert.equal((await cloud.status(params)).state,'ready');
});

test('cancellation confirms the owned worker exits before another cloud segment can start', async t => {
  const {cloud,admitted} = await fixture(t);
  await cloud.bindVoice({...params,voiceId:'private-whale'});
  const pending=cloud.speak({...params,text:'pending'});
  await pending.next();
  const next=pending.next();
  const rejection=assert.rejects(next,{name:'AbortError'});
  await cloud.stopEngine();
  await rejection;
  assert.equal(admitted.size,0);
  const completed=await Array.fromAsync(cloud.speak({...params,text:'恢复'}));
  assert.equal(completed.at(-1).type,'done');
});

test('shared Python worker preserves odd PCM packet tails and waits for flush acknowledgement', async () => {
  const script=String.raw`
import asyncio,base64,json,sys
from websockets.asyncio.server import serve

async def main():
    received=[]
    async def connection(ws):
        assert ws.request.headers['Authorization']=='Bearer controlled-test-key'
        await ws.send(json.dumps({'event':'connected_success'}))
        started=json.loads(await ws.recv());received.append(started['event'])
        assert started['audio_setting']['sample_rate']==32000
        await ws.send(json.dumps({'event':'task_started'}))
        received.append(json.loads(await ws.recv())['event'])
        received.append(json.loads(await ws.recv())['event'])
        await ws.send(json.dumps({'event':'task_continued','data':{'audio':'010002'}}))
        await ws.send(json.dumps({'event':'task_continued','data':{'audio':'00'}}))
        await ws.send(json.dumps({'event':'task_flushed'}))
        received.append(json.loads(await ws.recv())['event'])
        await ws.send(json.dumps({'event':'task_finished'}))
    async with serve(connection,'127.0.0.1',0) as server:
        port=server.sockets[0].getsockname()[1]
        process=await asyncio.create_subprocess_exec(sys.executable,'-B',sys.argv[1],stdin=asyncio.subprocess.PIPE,stdout=asyncio.subprocess.PIPE,stderr=asyncio.subprocess.PIPE)
        request={'op':'speak','base':f'http://127.0.0.1:{port}','key':'controlled-test-key','model':'speech-2.8-turbo','voiceId':'whale','text':'controlled'}
        try:
            process.stdin.write((json.dumps(request)+'\n').encode());await process.stdin.drain()
            stdout,stderr=await asyncio.wait_for(process.communicate(),10)
            assert process.returncode==0,(process.returncode,stderr)
            rows=[json.loads(line) for line in stdout.splitlines()]
            assert b''.join(base64.b64decode(row['pcm']) for row in rows if row['type']=='pcm')==bytes([1,0,2,0])
            assert rows[-1]['type']=='done'
            assert received==['task_start','task_continue','task_flush','task_finish'],received
            print('controlled-worker-flush-and-pcm-tail PASS')
        finally:
            if process.returncode is None:process.kill();await process.wait()
asyncio.run(main())
`;
  const {stdout}=await promisify(execFile)('py',['-3','-c',script,fileURLToPath(new URL('../sdk/plugins/voice-shared-runtime/cloud_speech.py',import.meta.url))],{windowsHide:true,timeout:15000});
  assert.match(stdout,/controlled-worker-flush-and-pcm-tail PASS/);
});
