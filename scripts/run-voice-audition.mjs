import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { writeAtomic } from '../src/atomic-write.mjs';
import { createManagedProcessSupervisor } from '../src/managed-process-supervisor.mjs';
import { createVoiceRuntime } from '../src/voice/runtime.mjs';

const line = '你来啦，先坐一会儿吧。今天有件有趣的事，我想慢慢讲给你听。';
const names = ['gpt','breeze'];
const runFile = promisify(execFile);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const {values: args} = parseArgs({options:{
  engine:{type:'string'}, samples:{type:'string'}, out:{type:'string'}, references:{type:'string'}, 'guard':{type:'string'},
  'engine-root':{type:'string'}, 'asset-root':{type:'string'}, python:{type:'string'}, ffmpeg:{type:'string'},
}});
const engine = args.engine;
if (!names.includes(engine) || !args.samples || !args.out || !args.guard || !args['engine-root'] || !args.python) {
  throw Error('Provide --engine=gpt|breeze, --samples, --out, --guard, --engine-root and --python');
}
const out = resolve(args.out), samples = resolve(args.samples);
await mkdir(out,{recursive:true});
const path = join(out,'manifest.json');
const samplesData = await readFile(join(samples,'VOICE-SAMPLES.json'));
const source = JSON.parse(samplesData);
const sourceManifestSHA = sha256(samplesData);
const perEngineReferences = Boolean(args.references);
const refs = JSON.parse(await readFile(join(out,args.references ?? 'REFERENCES.json')));
if (refs.sourceManifestSHA !== sourceManifestSHA) throw Error('The alignment proof does not match the original references');
const existing = await readFile(path,'utf8').then(JSON.parse).catch(error => {
  if (error.code === 'ENOENT') return null;
  throw error;
});
if (existing && (existing.sourceManifestSHA !== sourceManifestSHA || existing.text !== line)) {
  throw Error('Existing audition uses a different source or test line');
}
const index = existing ?? {
  schemaVersion:1, sourceManifestSHA, text:line, ...(perEngineReferences ? {referencePolicy:'per-engine'} : {}), engines:{}, roles:source.roles.map(role=>{
    const raw = source.entries[role.id+':calm'];
    const ref = refs.entries[role.id];
    return {id:role.id, label:role.name, color:role.color, sample:{file:raw.file, bytes:raw.bytes, sha256:raw.sha256, durationMs:raw.durationMs},
      ...(ref?.sha256 ? perEngineReferences ? {engineReferences:{[engine]:{file:ref.file, bytes:ref.bytes, sha256:ref.sha256, durationMs:ref.durationMs, method:ref.method, sourceSHA:ref.sourceSHA}}} : {comparisonReference:{file:ref.file, bytes:ref.bytes, sha256:ref.sha256, durationMs:ref.durationMs, method:ref.method, sourceSHA:ref.sourceSHA}} : {}),
      gpt:{state:'pending'}, breeze:{state:'pending'}};
  }),
};
for (const role of index.roles) {
  const ref = refs.entries[role.id];
  if (ref?.sha256) {
    const publicReference = {file:ref.file, bytes:ref.bytes, sha256:ref.sha256,
      durationMs:ref.durationMs, method:ref.method, sourceSHA:ref.sourceSHA};
    if (perEngineReferences) {
      role.engineReferences ??= {};
      role.engineReferences[engine] = publicReference;
    } else {
      role.comparisonReference = publicReference;
    }
    if (role[engine].state === 'ready' && role[engine].referenceSHA !== ref.sha256) {
      throw Error('A ready result belongs to a different engine reference; use a fresh audition round');
    }
  }
}
const persist = () => writeAtomic(path,JSON.stringify(index,null,2)+'\n');

function wav(sampleRate, pcm) {
  const header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(pcm.length+36,4); header.write('WAVEfmt ',8);
  header.writeUInt32LE(16,16); header.writeUInt16LE(1,20); header.writeUInt16LE(1,22);
  header.writeUInt32LE(sampleRate,24); header.writeUInt32LE(sampleRate*2,28);
  header.writeUInt16LE(2,32); header.writeUInt16LE(16,34); header.write('data',36); header.writeUInt32LE(pcm.length,40);
  return Buffer.concat([header,pcm]);
}

async function publish(role, reference, audio, rate, metrics) {
  const bytes = wav(rate,audio);
  const sha = sha256(bytes);
  const file = 'audio/'+engine+'/'+role.id+'-'+sha.slice(0,16)+'.wav';
  const fullPath = join(out,file);
  await mkdir(dirname(fullPath),{recursive:true});
  try { await writeFile(fullPath,bytes,{flag:'wx'}); }
  catch (error) {
    if (error.code !== 'EEXIST' || sha256(await readFile(fullPath)) !== sha) throw error;
  }
  role[engine] = {state:'ready',file,bytes:bytes.length,sha256:sha,sourceSHA:role.sample.sha256,
    referenceSHA:reference.sha256,sampleRate:rate,durationMs:Math.round(audio.length/2/rate*1000),metrics};
  persist();
}

const {stdout} = await runFile('nvidia-smi',['--query-gpu=memory.free','--format=csv,noheader,nounits'],{windowsHide:true,timeout:5000});
const freeMiB = Number(stdout.trim().split(/\r?\n/)[0]);
const minimumMiB = engine === 'breeze' ? 9728 : 4096;
const now = new Date().toISOString();
const launch = {state:'running',startedAt:now,freeMiB,minimumMiB};
index.engines[engine] = launch;
if (!Number.isFinite(freeMiB) || freeMiB < minimumMiB) {
  const message = '空闲显存 '+freeMiB+' MiB，固定引擎配置需要至少 '+minimumMiB+' MiB';
  Object.assign(launch,{state:'blocked',code:'VOICE_GPU_MEMORY',error:message,finishedAt:now});
  for (const role of index.roles) if (role[engine].state !== 'ready') role[engine] = {state:'failed',code:'VOICE_GPU_MEMORY',error:message};
  persist();
  console.log(message);
  process.exitCode = 2;
} else {
  persist();
  const guards = [];
  const guard = createManagedProcessSupervisor({guardPath:resolve(args.guard),statePath:join(out,engine+'-supervisor.json'),
    onState:event=>{if (event.type === 'guard-ready' || event.type === 'guard-retired') guards.push({type:event.type,pid:event.rootPid??null,activeProcesses:event.activeProcesses??null});},
  });
  const base = resolve('sdk/plugins');
  const cacheRoot = join(out,'scratch',engine);
  await mkdir(cacheRoot,{recursive:true});
  const runtime = createVoiceRuntime({supervisor:guard,
    resolveAssets:async()=>({python:resolve(args.python),root:resolve(args['engine-root']),assetRoot:resolve(args['asset-root']??args['engine-root']),
      script:join(base,engine==='gpt'?'voice-gpt-sovits/gpt_worker.py':'voice-breeze/breeze_worker.py'),cacheRoot,sharedDirectory:join(base,'voice-shared-runtime'),
      proof:engine,...(args.ffmpeg?{ffmpegDirectory:resolve(args.ffmpeg)}:{})}),
    resolveProfile:async({characterId})=>{
      const reference = refs.entries[characterId];
      const target = join(out,reference.file);
      const bytes = await readFile(target);
      if (bytes.length !== reference.bytes || sha256(bytes) !== reference.sha256) throw Error('Comparison reference hash differs');
      return {path:target,text:reference.text,language:reference.language,referenceStyle:'calm',referenceSource:'manual'};
    },
  });
  let failure;
  try {
    for (const role of index.roles) {
      if (role[engine].state === 'ready') continue;
      const reference = refs.entries[role.id];
      if (!reference?.sha256 || reference.sourceSHA !== role.sample.sha256) {
        role[engine] = {state:'failed',code:'VOICE_REFERENCE_ALIGNMENT',error:'未确认音频与文本相符的短参考'};
        persist();
        continue;
      }
      role[engine] = {state:'running',sourceSHA:role.sample.sha256};
      persist();
      const start = performance.now(), chunks = [];
      let rate, metrics, firstWallSeconds;
      try {
        for await (const event of runtime.speak({engine,characterId:role.id,profileId:'calm',text:line,
          instruction:'自然平静、语速适中，句间自然换气，保持参考音色。'})) {
          if (event.type === 'pcm') {
            if (rate && rate !== event.sampleRate) throw Error('Inconsistent synthesis sample rate');
            rate = event.sampleRate;
            chunks.push(event.pcm);
            if (firstWallSeconds == null && event.pcm.some(value=>value!==0)) firstWallSeconds = (performance.now()-start)/1000;
          } else if (event.type === 'done') metrics = event.metrics;
        }
        const audio = Buffer.concat(chunks);
        if (!metrics || firstWallSeconds == null || !rate || audio.length / 2 / rate < 1) throw Error('No usable synthesis');
        if (metrics.reference_sha256 !== reference.sha256 ||
            metrics.reference_text_sha256 !== sha256(Buffer.from(reference.text, 'utf8'))) {
          throw Error('Worker reference audio or transcript differs from the reviewed sample');
        }
        await publish(role,reference,audio,rate,{...metrics,firstWallSeconds});
        console.log(engine,role.id,'ready',role[engine].durationMs,firstWallSeconds.toFixed(2));
      } catch (error) {
        role[engine] = {state:'failed',code:error.code??'VOICE_WORKER_ERROR',error:error.message};
        persist();
        // A failed trial is actionable. Avoid repeating the same startup error across all roles.
        throw error;
      }
    }
  } catch (error) {
    failure = error;
    console.error(engine,error.code??'VOICE_WORKER_ERROR',error.message);
  } finally {
    try { await runtime.close(); await guard.close(); }
    catch(error) { failure ??= error; }
    const ready = index.roles.filter(role=>role[engine].state==='ready').length;
    Object.assign(launch,{state:failure?'failed':ready===index.roles.length?'ready':'partial',finishedAt:new Date().toISOString(),
      ready,...(failure?{code:failure.code??'VOICE_WORKER_ERROR',error:failure.message}:{}),guards});
    persist();
  }
  if (failure) process.exitCode = 1;
}



