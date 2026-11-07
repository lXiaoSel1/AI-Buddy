import {spawn} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {lstat,mkdir,readFile} from 'node:fs/promises';
import {isAbsolute,join} from 'node:path';
import {StringDecoder} from 'node:string_decoder';
import {assertPluginTreeNoLinks} from '../plugin-archive.mjs';
import {writeAtomic} from '../atomic-write.mjs';
import {voicePythonEnvironment} from './python-environment.mjs';

const packages = {breeze:'ai-buddy.voice-breeze',gpt:'ai-buddy.voice-gpt-sovits'};
const providers = {minimax:'https://api.minimax.cn','minimax-global':'https://api.minimax.io'};
const models = ['speech-2.8-turbo','speech-2.8-hd'];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = (code,message) => Object.assign(new Error(message),{code});
const aborted = () => new DOMException('云配音已停止','AbortError');
const validId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value) && !['__proto__','constructor','prototype'].includes(value);
const validVoice = value => typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,256}$/.test(value);

function timeout(promise,ms) {
  let timer;
  return Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(fail('CLOUD_STOP_UNCONFIRMED','云配音进程退出尚未确认')),ms);})]).finally(()=>clearTimeout(timer));
}

// The guard is admitted before any request (including the credential) is sent.
// stdout is a private, bounded protocol; stderr is never copied to app logs.
function launchBridge(assets,request,{signal,supervisor}) {
  if (!supervisor?.registerRoot || !supervisor?.releaseRoot) throw fail('CLOUD_GUARD_REQUIRED','云配音进程监管尚未准备');
  for (const field of ['python','script','root']) if (!isAbsolute(assets[field]??'')) throw fail('CLOUD_RUNTIME_INVALID','云配音运行组件路径无效');
  const env = voicePythonEnvironment(assets);
  const runtimeId = 'voice:cloud:'+randomUUID();
  const child = spawn(assets.python,[assets.script],{cwd:assets.root,env,windowsHide:true,stdio:['pipe','pipe','ignore']});
  const queue=[];let queueBytes=0;
  let wake,ended=false,admitted=false,sent=false,error,retirement;
  const notify=()=>{wake?.();wake=undefined;};
  const spawned=new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});
  const exited=new Promise(resolve=>child.once('close',code=>resolve(code)));
  child.stdin.on('error',()=>{});
  let resolveClosed,rejectClosed;
  const closed=new Promise((resolve,reject)=>{resolveClosed=resolve;rejectClosed=reject;});
  closed.catch(()=>{});
  const pump=(async()=>{
    const decoder=new StringDecoder('utf8');let tail='';
    try {
      for await (const bytes of child.stdout) {
        tail+=decoder.write(bytes);
        let end;
        while ((end=tail.indexOf('\n'))>=0) {
          if (end>8*1024*1024) throw Error();
          const row=JSON.parse(tail.slice(0,end));tail=tail.slice(end+1);
          if (!row || typeof row!=='object' || Array.isArray(row)) throw Error();
          queueBytes+=end;
          if (queueBytes>32*1024*1024 || queue.length>=4096) throw Error();
          queue.push({row,bytes:end});notify();
        }
        if (tail.length>8*1024*1024) throw Error();
      }
      if (tail.trim() || decoder.end().trim()) throw Error();
    } catch { error=fail('CLOUD_PROTOCOL','云配音组件返回了无效数据');void cancel().catch(()=>{}); }
  })();
  const admission=(async()=>{
    try {
      await spawned;
      await supervisor.registerRoot({runtimeId,pid:child.pid});admitted=true;
      if (signal.aborted) return;
      child.stdin.write(JSON.stringify(request)+'\n');sent=true;
    } catch { error??=fail('CLOUD_PROCESS','云配音组件未能启动');void cancel().catch(()=>{}); }
  })();
  function cancel() {
    if (retirement) return retirement;
    retirement=(async()=>{
      await admission;
      if (!ended) {
        if (sent) {try {child.stdin.write('{"op":"cancel"}\n');} catch {}}
        child.stdin.end();
        await timeout(exited,3000).catch(()=>{});
      }
      if (admitted) {
        const proof=await supervisor.releaseRoot({runtimeId});
        if (proof?.stopped!==true) throw fail('CLOUD_STOP_UNCONFIRMED','云配音进程退出尚未确认');
      } else if (child.pid && child.exitCode===null) child.kill();
      await timeout(exited,8000);
      await pump;
    })().then(resolveClosed,cause=>{error=fail('CLOUD_STOP_UNCONFIRMED','云配音进程退出尚未确认');rejectClosed(error);throw error;}).finally(notify);
    retirement.catch(()=>{});
    return retirement;
  }
  const onAbort=()=>{void cancel().catch(()=>{});};
  signal.addEventListener('abort',onAbort,{once:true});
  if (signal.aborted) onAbort();
  void exited.then(async code=>{
    await pump;ended=true;signal.removeEventListener('abort',onAbort);
    if (code!==0 && !signal.aborted && !error && !queue.some(item=>item.row.type==='error')) error=fail('CLOUD_PROCESS','云配音组件意外退出');
    notify();void cancel().catch(()=>{});
  });
  const events=(async function*(){
    for (;;) {
      if (signal.aborted) throw aborted();
      if (queue.length) {const item=queue.shift();queueBytes-=item.bytes;yield item.row;continue;}
      if (ended) {if (error) throw error;return;}
      await new Promise(resolve=>wake=resolve);
    }
  })();
  return {events,closed,cancel};
}

function remoteError(row) {
  const code=/^CLOUD_[A-Z0-9_]{1,64}$/.test(row.code??'')?row.code:'CLOUD_REMOTE';
  return fail(code,code==='CLOUD_REMOTE_1002'?'MiniMax 请求频率受限，请稍后手动重试':'云配音服务返回错误，请检查连接与声音配置');
}

// The host supplies trusted resolvers; neither plugin code nor a renderer gets
// the raw credential. Bindings belong to this host's private data directory.
export function createVoiceCloud({dataRoot,resolveRuntime,resolveProfile,resolveConnection,resolveSecret,supervisor,transport}) {
  if (!isAbsolute(dataRoot??'')) throw fail('CLOUD_CONFIG','云配音资料目录无效');
  const root=join(dataRoot,'voice','cloud');
  const indexPath=join(root,'bindings.json');
  let active,stopping,closed=false,stopFailure;

  function assertOpen() {if (closed) throw fail('CLOUD_CLOSED','云配音已关闭');if (stopFailure) throw stopFailure;}
  function scope(params={}) {
    const candidate=params.engine??params.engineId??params.packageId;
    const engine=candidate==='gpt-sovits'?'gpt':Object.keys(packages).find(key=>packages[key]===candidate)??candidate;
    if (!Object.hasOwn(packages,engine) || (params.packageId!=null && params.packageId!==packages[engine]) ||
        (params.engineId!=null && ![engine,packages[engine],...(engine==='gpt'?['gpt-sovits']:[])].includes(params.engineId)) || !validId(params.characterId)) throw fail('CLOUD_SCOPE','云配音角色或插件身份无效');
    return {...params,engine,packageId:packages[engine]};
  }
  async function context(params,signal) {
    const request=scope(params);
    const connection=await resolveConnection({engine:request.engine,packageId:request.packageId,characterId:request.characterId});
    if (!Object.hasOwn(providers,connection?.provider) || !models.includes(connection?.model) || typeof connection.keyRef!=='string' || !connection.keyRef) throw fail('CLOUD_KEY_REQUIRED','请先设置 MiniMax 语音 API Key');
    const key=await resolveSecret(connection.keyRef);
    if (typeof key!=='string' || !key.trim() || key.length>2048) throw fail('CLOUD_KEY_REQUIRED','MiniMax 语音 API Key 不可用');
    signal?.throwIfAborted();
    const profile=await resolveProfile(request);
    const profileId=profile?.id??profile?.profileId;
    const profileVersion=profile?.version??profile?.profileVersion;
    if (!validId(profileId) || !Number.isSafeInteger(profileVersion) || profileVersion<1 || profile.characterId!==request.characterId ||
        (request.profileId!=null && request.profileId!==profileId) || (request.profileVersion!=null && request.profileVersion!==profileVersion)) throw fail('CLOUD_PROFILE_SCOPE','云配音声音档案身份或版本不匹配');
    signal?.throwIfAborted();
    const accountScope=hash(Buffer.from(connection.provider+'\0'+key.trim()));
    return {request:{...request,profileId,profileVersion},profile,connection:{...connection,key:key.trim(),accountScope},bindingKey:[request.engine,request.characterId,profileId,profileVersion].join(':')};
  }
  async function load() {
    await assertPluginTreeNoLinks(indexPath);
    try {
      const info=await lstat(indexPath);if (!info.isFile() || info.size>1024*1024) throw Error();
      const state=JSON.parse(await readFile(indexPath,'utf8'));
      if (state.schemaVersion!==1 || !state.scopes || typeof state.scopes!=='object' || Array.isArray(state.scopes)) throw Error();
      return state;
    } catch (error) {if (error.code==='ENOENT') return {schemaVersion:1,scopes:{}};throw fail('CLOUD_BINDINGS','云端声音绑定资料不可读取');}
  }
  async function persist(state,signal) {await assertPluginTreeNoLinks(root);await mkdir(root,{recursive:true});await assertPluginTreeNoLinks(indexPath);signal?.throwIfAborted();writeAtomic(indexPath,JSON.stringify(state));}
  function bindingFor(ctx,state) {
    const rows=state.scopes[ctx.connection.accountScope]??{};
    const saved=rows[ctx.bindingKey];
    const external=ctx.profile.cloudBinding;
    const binding=saved??(external?.accountScope===ctx.connection.accountScope && external.provider===ctx.connection.provider?{...external,characterId:ctx.request.characterId,profileId:ctx.request.profileId,profileVersion:ctx.request.profileVersion}:undefined);
    if (!binding || !validVoice(binding.voiceId) || binding.characterId!==ctx.request.characterId || binding.profileId!==ctx.request.profileId || binding.profileVersion!==ctx.request.profileVersion ||
        Object.values(rows).some(row=>row.characterId!==ctx.request.characterId && row.voiceId===binding.voiceId)) throw fail('CLOUD_VOICE_REQUIRED','请先为当前账号和角色声音档案绑定云端音色');
    return binding;
  }
  function reserve() {
    assertOpen();if (active || stopping) throw fail('CLOUD_BUSY','云配音正在处理上一条请求');
    let resolveReady;
    const token={controller:new AbortController(),job:null,ready:new Promise(resolve=>{resolveReady=resolve;}),resolveReady};
    active=token;return token;
  }
  async function start(token,ctx,op,payload) {
    const assets=await resolveRuntime({engine:ctx.request.engine,packageId:ctx.request.packageId});
    token.controller.signal.throwIfAborted();
    const request={op,base:providers[ctx.connection.provider],key:ctx.connection.key,model:ctx.connection.model,...payload};
    token.job=await (transport??((runtime,input,options)=>launchBridge(runtime,input,{...options,supervisor})))(assets,request,{signal:token.controller.signal});
    token.resolveReady(token.job);return token.job;
  }
  async function finish(token) {
    token.resolveReady(token.job);
    if (token.job) {
      try {await token.job.cancel();await token.job.closed;}
      catch {stopFailure=fail('CLOUD_STOP_UNCONFIRMED','云配音进程退出尚未确认');throw stopFailure;}
    }
    if (active===token) active=undefined;
  }
  async function result(token,ctx,op,payload,onEvent=()=>{}) {
    const job=await start(token,ctx,op,payload);let answer;
    for await (const row of job.events) {
      token.controller.signal.throwIfAborted();
      if (row.type==='error') throw remoteError(row);
      if (row.type==='cancelled') throw aborted();
      if (row.type==='result') {if (answer) throw fail('CLOUD_PROTOCOL','云配音返回重复结果');answer=row;}
      else if (row.type==='stage') await onEvent(row);
      else throw fail('CLOUD_PROTOCOL','云配音返回无效结果');
    }
    token.controller.signal.throwIfAborted();
    if (!answer) throw fail('CLOUD_INCOMPLETE','云配音没有确认完整结果');
    return answer;
  }
  function normalizeVoices(answer) {
    if (!Array.isArray(answer.voices) || answer.voices.length>5000) throw fail('CLOUD_PROTOCOL','MiniMax 音色列表无效');
    return answer.voices.filter(row=>validVoice(row?.voice_id)).map(row=>({voiceId:row.voice_id,name:typeof row.name==='string'?row.name.slice(0,200):row.voice_id,category:String(row.category??'').slice(0,40)}));
  }
  async function status(params) {
    assertOpen();
    try {
      const ctx=await context(params);const binding=bindingFor(ctx,await load());
      return {state:'ready',provider:ctx.connection.provider,model:ctx.connection.model,voiceId:binding.voiceId,characterId:ctx.request.characterId,profileId:ctx.request.profileId,profileVersion:ctx.request.profileVersion,busy:!!active||!!stopping};
    } catch (error) {return {state:error.code==='CLOUD_VOICE_REQUIRED'?'unbound':'unavailable',code:error.code??'CLOUD_CONFIG',busy:!!active||!!stopping};}
  }
  async function listVoices(params) {
    const token=reserve();try {const ctx=await context(params,token.controller.signal);return normalizeVoices(await result(token,ctx,'voices',{}));} finally {await finish(token);}
  }
  async function bindVoice(params={}) {
    if (!validVoice(params.voiceId)) throw fail('CLOUD_VOICE','请选择当前账号的有效云端音色');
    const token=reserve();
    try {
      const ctx=await context(params,token.controller.signal);
      const state=await load();const rows=state.scopes[ctx.connection.accountScope]??{};
      if (Object.values(rows).some(row=>row.characterId!==ctx.request.characterId && row.voiceId===params.voiceId)) throw fail('CLOUD_VOICE_SCOPE','这个云端音色已绑定其他角色，请选择独立音色');
      const voices=normalizeVoices(await result(token,ctx,'voices',{}));
      if (!voices.some(row=>row.voiceId===params.voiceId)) throw fail('CLOUD_VOICE','该音色不在当前账号的可用列表中');
      token.controller.signal.throwIfAborted();
      const binding={characterId:ctx.request.characterId,profileId:ctx.request.profileId,profileVersion:ctx.request.profileVersion,voiceId:params.voiceId,provider:ctx.connection.provider,provenance:'account-voice-pending-audition',boundAt:new Date().toISOString()};
      rows[ctx.bindingKey]=binding;state.scopes[ctx.connection.accountScope]=rows;await persist(state,token.controller.signal);
      return {...binding,state:'ready'};
    } finally {await finish(token);}
  }
  async function referencePlan(ctx) {
    const reference=ctx.profile.cloudReference;
    if (reference?.authorized!==true || !isAbsolute(reference.path??'') || !/^[a-f0-9]{64}$/.test(reference.sha256??'') ||
        !Number.isSafeInteger(reference.bytes) || reference.bytes<44 || reference.bytes>20*1024*1024 ||
        !Number.isFinite(reference.durationMs) || reference.durationMs<10000 || reference.durationMs>300000 ||
        typeof reference.text!=='string') throw fail('CLOUD_REFERENCE','当前角色没有已批准的完整云端克隆参考');
    await assertPluginTreeNoLinks(reference.path);
    const before=await lstat(reference.path,{bigint:true});
    if (!before.isFile() || before.nlink!==1n || before.size!==BigInt(reference.bytes)) throw fail('CLOUD_REFERENCE_CHANGED','云端克隆参考文件已变化');
    const bytes=await readFile(reference.path);
    const after=await lstat(reference.path,{bigint:true});
    if (before.ino!==after.ino || before.dev!==after.dev || before.size!==after.size || before.mtimeNs!==after.mtimeNs ||
        before.ctimeNs!==after.ctimeNs || bytes.length!==reference.bytes || hash(bytes)!==reference.sha256 ||
        bytes.toString('ascii',0,4)!=='RIFF' || bytes.toString('ascii',8,12)!=='WAVE') throw fail('CLOUD_REFERENCE_CHANGED','云端克隆参考摘要校验失败');
    return {bytes,reference,plan:{characterId:ctx.request.characterId,profileId:ctx.request.profileId,profileVersion:ctx.request.profileVersion,
      provider:ctx.connection.provider,sourceSHA:reference.sha256,durationMs:reference.durationMs,bytes:reference.bytes,
      action:'upload-and-clone',requiresConsent:true,remoteUpload:true,cloudListeningAcceptance:'pending'}};
  }
  async function previewPlan(params) {
    assertOpen();const ctx=await context(params);return (await referencePlan(ctx)).plan;
  }
  async function prepareVoice(params={}) {
    if (params.consentUpload!==true) throw fail('CLOUD_CONSENT','请先确认上传当前角色的完整参考音并创建 MiniMax 云端音色');
    const token=reserve();let receipt,receiptPath;
    const saveReceipt=()=>{if (receiptPath) writeAtomic(receiptPath,JSON.stringify(receipt));};
    try {
      const ctx=await context(params,token.controller.signal);
      const {plan,reference,bytes}=await referencePlan(ctx);
      token.controller.signal.throwIfAborted();
      const voiceId='buddy-'+randomUUID().replaceAll('-','');
      receipt={schemaVersion:1,receiptId:randomUUID(),...plan,voiceId,createdAt:new Date().toISOString(),stages:[],status:'preparing'};
      const receiptRoot=join(root,'receipts');await assertPluginTreeNoLinks(receiptRoot);await mkdir(receiptRoot,{recursive:true});
      token.controller.signal.throwIfAborted();
      receiptPath=join(receiptRoot,receipt.receiptId+'.json');saveReceipt();
      const answer=await result(token,ctx,'clone',{voiceId,audio:bytes.toString('base64'),...(reference.text.length>0 && reference.text.length<=200?{textValidation:reference.text}:{})},async row=>{
        if (!['uploaded','clone-request-submitted'].includes(row.stage)) throw fail('CLOUD_PROTOCOL','云端克隆阶段无效');
        receipt.stages.push({stage:row.stage,...(['string','number'].includes(typeof row.file_id)?{fileId:String(row.file_id).slice(0,200)}:{})});saveReceipt();
      });
      if (answer.voice_id!==voiceId) throw fail('CLOUD_PROTOCOL','MiniMax 克隆返回了不同的音色身份');
      token.controller.signal.throwIfAborted();
      const state=await load(),rows=state.scopes[ctx.connection.accountScope]??{};
      const binding={characterId:ctx.request.characterId,profileId:ctx.request.profileId,profileVersion:ctx.request.profileVersion,
        voiceId,provider:ctx.connection.provider,sourceSHA:reference.sha256,provenance:'approved-reference-clone-pending-audition',receiptId:receipt.receiptId,preparedAt:new Date().toISOString()};
      rows[ctx.bindingKey]=binding;state.scopes[ctx.connection.accountScope]=rows;await persist(state,token.controller.signal);
      receipt.status='prepared-awaiting-first-synthesis-and-listening';saveReceipt();
      return {...binding,state:'ready',cloudListeningAcceptance:'pending'};
    } catch (error) {
      if (receipt) {receipt.status='failed-or-unconfirmed';receipt.error={code:error.name==='AbortError'?'CLOUD_CANCELLED':/^CLOUD_[A-Z0-9_]{1,64}$/.test(error.code??'')?error.code:'CLOUD_PREPARE_FAILED'};saveReceipt();}
      throw error;
    } finally {await finish(token);}
  }
  async function* speak(params={}) {
    if (typeof params.text!=='string' || !params.text.trim() || Array.from(params.text).length>10000) throw fail('CLOUD_TEXT','云配音文字无效或过长');
    const token=reserve();const onAbort=()=>token.controller.abort();
    params.signal?.addEventListener('abort',onAbort,{once:true});if (params.signal?.aborted) onAbort();
    let done=false;
    try {
      const ctx=await context(params,token.controller.signal);const binding=bindingFor(ctx,await load());
      const job=await start(token,ctx,'speak',{voiceId:binding.voiceId,text:params.text,performance:params.performance,speechParts:params.speechParts});
      yield {type:'reference',style:'cloud',source:binding.provenance??'account-voice'};
      for await (const row of job.events) {
        token.controller.signal.throwIfAborted();
        if (row.type==='error') throw remoteError(row);
        if (row.type==='cancelled') throw aborted();
        if (done) throw fail('CLOUD_PROTOCOL','云配音完成后又返回了数据');
        if (row.type==='pcm') {
          if (!Number.isSafeInteger(row.sample_rate) || row.sample_rate<8000 || row.sample_rate>192000 || typeof row.pcm!=='string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(row.pcm)) throw fail('CLOUD_PCM','云配音 PCM 格式无效');
          const pcm=Buffer.from(row.pcm,'base64');if (!pcm.length || pcm.length%2) throw fail('CLOUD_PCM','云配音 PCM 字节不完整');
          yield {type:'pcm',pcm,sampleRate:row.sample_rate};
        } else if (row.type==='done') {
          if (row.metrics?.voice_id!==binding.voiceId) throw fail('CLOUD_VOICE','实际云配音音色与当前角色不匹配');
          done=true;
          const metrics={cloud:true,provider:ctx.connection.provider,model:ctx.connection.model,voice_id:binding.voiceId};
          for (const name of ['first_pcm_seconds','generation_seconds','audio_seconds','input_text_chunks']) if (Number.isFinite(row.metrics[name]) && row.metrics[name]>=0) metrics[name]=row.metrics[name];
          yield {type:'done',metrics};
        } else throw fail('CLOUD_PROTOCOL','云配音返回了无效数据');
      }
      if (!done) throw fail('CLOUD_INCOMPLETE','云配音没有确认完整尾音');
    } finally {params.signal?.removeEventListener('abort',onAbort);await finish(token);}
  }
  function stopEngine() {
    if (stopping) return stopping;
    const token=active;token?.controller.abort();
    stopping=(async()=>{if (token) {await token.ready;await finish(token);}})().finally(()=>{stopping=undefined;});
    return stopping;
  }
  async function close() {closed=true;await stopEngine();}
  return {status,state:status,listVoices,bindVoice,previewPlan,prepareVoice,speak,stopEngine,stop:stopEngine,close};
}
