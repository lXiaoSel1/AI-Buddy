import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, posix, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { prepareDshGitPackage } from './native-bridge-source.mjs';
import { verifyDshComponent } from './component-manager.mjs';
import { canonicalPluginJson } from '../plugin-manifest.mjs';
import { createDshStageDiagnostics, normalizeDshUiPolicy, dshModelError } from './native-bridge-host.mjs';
import {modelNotSubmittedCause} from '../buddy-plugin-services/social-runtime-journal.mjs';
import { verifyInstalledDshArtifact } from './installed-artifact.mjs';
import { dshUiBootstrap } from './ui-bootstrap.mjs';

const CHANNEL = 'ai-buddy-dsh-platform-v1';
const PIN = '22ddee3792402c3e70ec5f86a63c3e3e895a2f60';
const digest = value => createHash('sha256').update(value).digest('hex');
const OS_ENV = new Set(['SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'CommonProgramFiles', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'PROCESSOR_IDENTIFIER', 'PATH']);
export function dshRuntimeEnvironment(parent, overrides) {
  const env = Object.fromEntries(Object.entries(parent).filter(([key]) => [...OS_ENV].some(name => name.toLowerCase() === key.toLowerCase())));
  return { ...env, ...overrides };
}
function normalizeSpec(input, packageRef) {
  if (typeof input === 'string') return input;
  if (!input || typeof input.value !== 'string') throw failure('DSH_INVALID_INSTALL_SPEC', 'A canonical install spec is required');
  if (input.kind === 'git') {
    const commit = input.commit ?? input.value.split('#')[1];
    if (!/^[a-f0-9]{40}$/i.test(commit ?? '')) throw failure('DSH_GIT_COMMIT_REQUIRED', 'Git install requires an immutable full commit');
    return `${input.value.split('#')[0]}#${commit}`;
  }
  if (input.kind === 'registry') return `${packageRef.packageName}@${packageRef.exactVersion}`;
  if (input.kind === 'tarball') return input.value;
  throw failure('DSH_INVALID_INSTALL_SPEC', 'Unsupported DSH install source');
}
function tarballIdentity(bytes, files) {
  const tar = gunzipSync(bytes, { maxOutputLength: 512 * 1024 * 1024 });
  let identity; const members = new Set();
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(value => value === 0)) break;
    const str = (start, end) => header.subarray(start, end).toString('utf8').replace(/\0.*$/s, '');
    const name = `${str(345, 500) ? `${str(345, 500)}/` : ''}${str(0, 100)}`;
    const size = Number.parseInt(str(124, 136).trim() || '0', 8);
    const type = str(156, 157) || '0';
    let checksum = 0; for (let index = 0; index < 512; index++) checksum += index >= 148 && index < 156 ? 32 : header[index];
    if (checksum !== Number.parseInt(str(148, 156).trim() || '0', 8)) throw failure('DSH_PACKAGE_INVALID', 'Invalid package archive checksum');
    if (!Number.isSafeInteger(size) || size < 0 || offset + 512 + size > tar.length) throw failure('DSH_PACKAGE_INVALID', 'Truncated package archive');
    const normalized = posix.normalize(name);
    if (!name.startsWith('package/') || name.includes('\\') || normalized.startsWith('../') || /^[A-Za-z]:/.test(name) || !['0', '5'].includes(type) || members.has(normalized)) throw failure('DSH_PACKAGE_UNSAFE', 'Unsafe, extended, linked or duplicate package archive member');
    members.add(normalized);
    if(type==='0')files?.set(normalized.slice('package/'.length),digest(tar.subarray(offset+512,offset+512+size)));
    if (normalized === 'package/package.json' && type === '0') {
      if (identity) throw failure('DSH_PACKAGE_INVALID', 'Duplicate npm package manifest');
      identity = JSON.parse(tar.subarray(offset + 512, offset + 512 + size).toString('utf8'));
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  if (!identity) throw failure('DSH_PACKAGE_INVALID', 'Npm package manifest is missing');
  if (identity.main && (!/\.(?:mjs|cjs|js)$/.test(identity.main) || !members.has(posix.normalize(`package/${identity.main}`)))) throw failure('DSH_PACKAGE_BUILD_REQUIRED', 'The native package main entry is missing its built JavaScript output');
  const patch = identity.dsh?.bundle?.patch;
  if (patch && (typeof patch !== 'string' || !members.has(posix.normalize(`package/${patch}`)))) throw failure('DSH_PACKAGE_INVALID', 'The declared native bundle patch is missing');
  return identity;
}
function failure(code, message, extra = {}) { return Object.assign(new Error(message), { code, ...extra }); }
function inside(root, path) { const delta = relative(root, path); return delta === '' || (!delta.startsWith('..') && !isAbsolute(delta)); }
function redact(text) { return text.replace(/([?&][^=\s&]*(?:token|key|secret|signature|credential|auth|code)[^=\s&]*=)[^\s&]+/gi, '$1[REDACTED]').replace(/(https?:\/\/)[^/@\s]+@/gi, '$1[REDACTED]@'); }
function sanitized(value, key = '') {
  if(/^(?:inputTokens|outputTokens|totalTokens|cacheReadTokens|cacheWriteTokens|reasoningTokens)$/.test(key)&&(value===null||typeof value==='number'))return value;
  if (/token|secret|password|authorization|api[-_]?key|cookie/i.test(key)) return '[REDACTED]';
  if (typeof value === 'string') return redact(value).replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, '[REDACTED]');
  if (Array.isArray(value)) return value.map(item => sanitized(item));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, sanitized(item, name)]));
  return value;
}

/** Process-owning adapter over one pinned official DSH Web profile. */
export function createDshBackend({ runtimeLockPath, dshHome, profileId = 'buddy-community-v1', stateDir, buddyServices, socialServices, resolveToolScope, uiPolicy, hostBridgeSourcePath, workClientMode = false, purpose = 'ui', taskMode, taskBootstrapPath, onProcessStart, onProcessStop, authorizeNativeModel, onNativeModelUsage, stageDiagnostics = process.env.AI_BUDDY_DSH_TRACE_STAGES === '1', handshakeTimeoutMs = 120000, maxPackageBytes = 256 * 1024 * 1024, onEvent = () => {} } = {}) {
  if (!runtimeLockPath || !dshHome || !stateDir) throw failure('DSH_CONFIGURATION_REQUIRED', 'runtimeLockPath, dshHome and stateDir are required');
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(profileId) || profileId === 'desktop') throw failure('DSH_INVALID_PROFILE', 'A private non-desktop profile is required');
  const hostUiPolicy = normalizeDshUiPolicy(uiPolicy);
  const taskOnly=purpose==='job-tools';
  if(!['ui','job-tools'].includes(purpose))throw failure('DSH_PURPOSE_INVALID','Unknown native Host purpose');
  if(taskOnly&&(!taskMode?.jobId||!taskMode?.runId||profileId==='buddy-community-v1'||typeof onProcessStart!=='function'||typeof onProcessStop!=='function'))throw failure('DSH_TASK_SUPERVISOR_REQUIRED','Task tools require a private profile and host OS supervision');
  const capturedModel=taskOnly?taskMode.modelBinding:null;
  let modelEnvironment={};
  if(capturedModel){
    if(typeof onNativeModelUsage!=='function')throw failure('DSH_NATIVE_MODEL_USAGE_REQUIRED','Native AI tools require a host-owned usage receipt sink before any paid request');
    const selected=taskMode.modelEnvironment??{};let endpoint;try{endpoint=new URL(selected.DEEPSEEK_BASE_URL);}catch{}
    if(capturedModel.provider!=='deepseek-official'||!capturedModel.model||!capturedModel.connectionRef||!capturedModel.fingerprint||typeof authorizeNativeModel!=='function'||endpoint?.protocol!=='http:'||endpoint.hostname!=='127.0.0.1'||endpoint.username||endpoint.password||typeof selected.DEEPSEEK_API_KEY!=='string'||!selected.DEEPSEEK_API_KEY)throw failure('DSH_NATIVE_MODEL_CONFIGURATION_REQUIRED','Native AI tools need a captured DSH binding and its private single-connection proxy');
    modelEnvironment={DEEPSEEK_BASE_URL:selected.DEEPSEEK_BASE_URL,DEEPSEEK_API_KEY:selected.DEEPSEEK_API_KEY};
  }
  const events = new EventEmitter();
  const pending = new Map();
  const buddyCalls = new Map();
  const nativeModelAdmissions=new Map();
  let child, startPromise, lock, paths, authURL, webOrigin, bridgeReady = false, sequence = 0, toolOwners = {}, identities = {}, closed = false;
  let phase = 'not-started', lastError = null, jobStopPromise;
  const runtimeId = randomUUID();
  const emit = event => { events.emit('event', event); onEvent(event); };
  async function audit(type, data) {
    await mkdir(stateDir, { recursive: true });
    const file = resolve(stateDir, `event-${String(++sequence).padStart(7, '0')}-${randomUUID()}.json`);
    await writeFile(file, JSON.stringify(sanitized({ at: new Date().toISOString(), runtimeId, profileId, type, ...data }), null, 2));
  }
  const stage = createDshStageDiagnostics({enabled:stageDiagnostics===true,emit:row=>{
    // Optional observation must never block native RPC settlement. The helper
    // whitelists metadata before either the private audit or public event sink.
    void audit('rpc-stage',row).catch(()=>{});
    emit({...row,runtimeId,profileId,purpose});
  }});
  async function readRuntime(full = false) {
    let value;
    try { value = JSON.parse(await readFile(runtimeLockPath, 'utf8')); }
    catch (cause) { throw failure('DSH_RUNTIME_NOT_READY', 'The verified DSH runtime component is not prepared', { cause }); }
    if (value.schemaVersion !== 1 || value.stage !== 'ready' || value.sourceCommit !== PIN) throw failure('DSH_RUNTIME_NOT_READY', 'DSH runtime component is not ready or has the wrong pinned source');
    const root = dirname(resolve(runtimeLockPath));
    const resolved = {};
    for (const key of ['node', 'pnpm', 'cli', 'sdk', 'bridge']) {
      const item = value.paths?.[key];
      if (typeof item !== 'string' || isAbsolute(item)) throw failure('DSH_RUNTIME_INVALID_PATH', `Invalid ${key} component path`);
      const path = resolve(root, item);
      if (!inside(root, path)) throw failure('DSH_RUNTIME_INVALID_PATH', `Outside ${key} component path`);
      const expected = value.files?.find(row => row.path === item);
      if (!expected || digest(await readFile(path)) !== expected.sha256) throw failure('DSH_RUNTIME_HASH_MISMATCH', `Runtime entry ${key} differs from component receipt`);
      resolved[key] = path;
    }
    if (full) {
      try { await verifyDshComponent(root); }
      catch (cause) { throw failure('DSH_RUNTIME_HASH_MISMATCH', `Full runtime verification failed: ${cause.message}`, { cause }); }
    }
    return { lock: value, paths: resolved };
  }
  async function probe() {
    try { const checked = await readRuntime(); return { ready: true, backend: 'dsh', sourceCommit: checked.lock.sourceCommit, version: checked.lock.version, nodeVersion: checked.lock.nodeVersion, pnpmVersion: checked.lock.pnpmVersion, phase }; }
    catch (error) { return { ready: false, backend: 'dsh', phase: 'component-required', code: error.code ?? 'DSH_RUNTIME_INVALID', message: error.message }; }
  }
  async function rpc(method, params = {}, { signal } = {}) {
    await start();
    if (signal?.aborted) throw signal.reason ?? failure('ABORTED', 'Operation cancelled');
    const id = randomUUID();
    return new Promise((resolveReply, reject) => {
      const abort = () => {
        // Do not settle until the real tool has drained. Cancellation requests
        // bypass pending call settlement but stay on the managed channel.
        if (child?.connected) child.send({ channel: CHANNEL, kind: 'request', id: randomUUID(), method: method === 'management.install' ? 'management.cancelInstall' : 'tools.cancel', params: { requestId: id } });
      };
      signal?.addEventListener('abort', abort, { once: true });
      const diagnosticStart=performance.now();
      pending.set(id, { method, diagnosticStart, admission:params.admission, toolName:params.name, resolve: resolveReply, reject, cleanup: () => {signal?.removeEventListener('abort', abort);nativeModelAdmissions.delete('buddy-external:'+id);} });
      stage.record(method,id,'rpc.sent');
      child.send({ channel: CHANNEL, kind: 'request', id, method, params }, error => { if (error) { stage.record(method,id,'rpc.error',{elapsedMs:performance.now()-diagnosticStart});pending.delete(id); signal?.removeEventListener('abort', abort); reject(error); } });
    });
  }
  async function start() {
    if (closed) throw failure('DSH_BACKEND_CLOSED', 'This backend has been closed');
    if (phase === 'running' && child?.exitCode === null && bridgeReady && (taskOnly||authURL)) return;
    if (startPromise) return startPromise;
    if (child?.pid && child.exitCode === null) throw failure('DSH_RUNTIME_STILL_RUNNING', 'The previous runtime has not exited; refusing a duplicate process');
    startPromise = (async () => {
      await Promise.allSettled([...buddyCalls.values()].map(row=>row.operation));
      phase = 'verifying-component';
      emit({kind:'runtime-verification',phase});
      ({ lock, paths } = await readRuntime(true));
      await mkdir(dshHome, { recursive: true });
      await mkdir(stateDir, { recursive: true });
      for (const [filename, set] of [['tool-owners.json', value => { toolOwners = value; }], ['package-identities.json', value => { identities = value; }]]) {
        try { set(JSON.parse(await readFile(resolve(stateDir, filename), 'utf8'))); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      // The immutable upstream component is unchanged. The application owns a
      // separately hashed shim, materialized outside ASAR for component Node.
      const shimBytes = await readFile(hostBridgeSourcePath ?? new URL('./native-bridge-host.mjs', import.meta.url));
      const shimSha256 = digest(shimBytes), shimDir = resolve(stateDir, 'host-shims', shimSha256);
      const hostBridge = resolve(shimDir, 'native-bridge-host.mjs');
      await mkdir(shimDir, {recursive:true});
      try { await writeFile(hostBridge, shimBytes, {flag:'wx'}); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
      if (digest(await readFile(hostBridge)) !== shimSha256) throw failure('DSH_HOST_SHIM_CHANGED', 'The host shim differs from application source');
      const overlay = resolve(stateDir, 'buddy-platform.cordis.yml');
      const nativeModelSelection=capturedModel?{provider:capturedModel.provider,model:capturedModel.model,...(capturedModel.effort==null?{}:{reasoningEffort:capturedModel.effort})}:null;
      await writeFile(overlay, `- insert:\n    - id: ai-buddy-platform-bridge\n      name: ${JSON.stringify(hostBridge.replaceAll('\\', '/'))}\n${taskOnly?'':'      inject: [typertGateway]\n'}      config:\n        runtimeId: ${JSON.stringify(runtimeId)}\n        profileId: ${JSON.stringify(profileId)}\n        purpose: ${JSON.stringify(purpose)}\n        stageDiagnostics: ${stageDiagnostics===true}\n        uiPolicy: ${JSON.stringify(hostUiPolicy)}\n${taskOnly?`        task: ${JSON.stringify({jobId:taskMode.jobId,runId:taskMode.runId,modelSelection:nativeModelSelection,modelEndpoint:modelEnvironment.DEEPSEEK_BASE_URL})}\n- id: sdk-app-startup\n  disabled: true\n- id: sdk-jsonrpc-server\n  disabled: true\n- id: schedule\n  disabled: true\n- id: hmr\n  disabled: false\n  config:\n    root: []\n`:dshUiBootstrap({stateDir,workClientMode,profileId})}`);
      let bootstrapPath,bootstrapSha256;
      if(taskOnly){const bytes=await readFile(taskBootstrapPath??new URL('./inert-bootstrap.mjs',import.meta.url));bootstrapSha256=digest(bytes);const directory=resolve(stateDir,'host-shims',bootstrapSha256);await mkdir(directory,{recursive:true});bootstrapPath=resolve(directory,'inert-bootstrap.mjs');try{await writeFile(bootstrapPath,bytes,{flag:'wx'});}catch(error){if(error.code!=='EEXIST')throw error;}if(digest(await readFile(bootstrapPath))!==bootstrapSha256)throw failure('DSH_HOST_SHIM_CHANGED','The task bootstrap differs from application source');}
      const emptyNpmConfig = resolve(stateDir, 'npmrc');
      const emptyGlobalNpmConfig = resolve(stateDir, 'global-npmrc');
      await writeFile(emptyNpmConfig, '');
      await writeFile(emptyGlobalNpmConfig, '');
      let initialize = false;
      try { await readFile(resolve(dshHome, 'profiles', profileId, 'package.json')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; initialize = true; }
      const cliArgs = [paths.cli, '--profile', profileId, ...(initialize ? ['--from-default-profile',taskOnly?'sdk':'web'] : []), '--patch', overlay, ...(taskOnly?[]:['--no-open', '--host', '127.0.0.1', '--port', '0'])];
      const nonce=taskOnly?randomUUID():null,args=taskOnly?[bootstrapPath,nonce,...cliArgs]:cliArgs;
      const env = dshRuntimeEnvironment(process.env, { DSH_HOME: resolve(dshHome), DSH_AGENTS_HOME: resolve(dshHome, '.agents'), DSH_TELEMETRY_DISABLED: '1', PNPM_HOME: resolve(stateDir, 'pnpm-home'), npm_config_store_dir: resolve(stateDir, 'pnpm-store'), npm_config_cache: resolve(stateDir, 'npm-cache'), npm_config_userconfig: emptyNpmConfig, npm_config_globalconfig: emptyGlobalNpmConfig, ...modelEnvironment, PATH: `${resolve(dirname(runtimeLockPath), 'bin')};${dirname(paths.pnpm)};${dirname(paths.node)};${process.env.PATH ?? ''}` });
      if (closed) throw failure('DSH_BACKEND_CLOSED', 'The backend was closed during runtime verification; no process was launched');
      phase = 'starting';
      child = spawn(paths.node, args, { cwd: resolve(stateDir), env, windowsHide: true, stdio: [taskOnly?'pipe':'ignore', 'pipe', 'pipe', 'ipc'] });
      await audit('runtime-start', { pid: child.pid, sourceCommit: PIN, args: cliArgs.map(redact), initialize, hostBridge, shimSha256, uiPolicy:hostUiPolicy, purpose, ...(taskOnly?{jobId:taskMode.jobId,runId:taskMode.runId,bootstrapSha256}: {}) });
      await new Promise((resolveReady, rejectReady) => {
        let tail = '', settled = false;
        const finish = error => { if (settled) return; if (!error && (!bridgeReady || !taskOnly&&!authURL)) return; settled = true; clearTimeout(timer); error ? rejectReady(error) : resolveReady(); };
        const timer = setTimeout(() => { phase = 'failed'; finish(failure('DSH_START_TIMEOUT', `DSH did not become ready: ${redact(tail.slice(-6000))}`)); }, handshakeTimeoutMs);
        child.on('message', message => {
          if (message?.channel !== CHANNEL) return;
          if (message.kind === 'bridge-ready') {
            if (message.purpose!==purpose||!taskOnly&&(message.uiPolicy?.mode !== hostUiPolicy.mode || message.uiPolicy?.version !== hostUiPolicy.version)) { finish(failure('DSH_HOST_POLICY_NOT_READY', 'Native Host did not confirm application policy')); return; }
            bridgeReady = true; finish();
          }
          else if (message.kind === 'response') {
            const entry = pending.get(message.id);
            if (entry) { stage.record(entry.method,message.id,message.error?'rpc.error':'rpc.reply',{elapsedMs:performance.now()-entry.diagnosticStart});pending.delete(message.id); entry.cleanup(); message.error ? entry.reject(Object.assign(failure(message.error.code, message.error.message),dshModelError(message.error))) : entry.resolve(message.result); }
          } else if (message.kind === 'rpc-stage') {
            stage.record(message.method,message.requestId,message.phase,{elapsedMs:message.elapsedMs,parentRequestId:message.parentRequestId});
          } else if (message.kind === 'bootstrap-error') { finish(failure(message.error?.code??'DSH_BOOTSTRAP_FAILED',message.error?.message??'Task bootstrap failed')); }
          else if (['buddy-request','social-request','native-model-request','native-model-usage'].includes(message.kind)) {
            const requester = child, controller = new AbortController();
            const diagnosticStart=performance.now();stage.record('buddy.invoke',message.id,'buddy-main.begin');
            const operation = Promise.resolve().then(async () => {
              if (closed&&message.kind!=='native-model-usage'&&!(message.kind==='social-request'&&message.params?.method==='close')) throw failure('DSH_BACKEND_CLOSED', 'Buddy request arrived while the backend was closing');
              if(message.kind==='social-request'){
                if(taskOnly||!socialServices)throw failure('BUDDY_SOCIAL_UNAVAILABLE','Social runtime services are not connected');
                const {pluginId,contextToken,method,payload={}}=message.params??{},identity=identities[pluginId];
                if(!identity||identity.packageName!==pluginId)throw failure('SOCIAL_PACKAGE_IDENTITY_REQUIRED','Social bootstrap requires a verified installed package');
                const origin={runtimeId,profileId,pid:requester.pid};
                if(method==='open')return socialServices.open({identity,origin,contractHash:payload.contractHash});
                return socialServices.dispatch({sessionToken:contextToken,method,payload},origin,{signal:controller.signal});
              }
              if (!buddyServices) throw failure('BUDDY_SERVICES_UNAVAILABLE', 'Buddy services are not connected');
              if(message.kind==='native-model-usage'){
                const {pluginId,contextToken,payload={}}=message.params??{},admitted=nativeModelAdmissions.get(payload.callId),receipt=payload.receipt;
                if(!taskOnly||!capturedModel||!admitted||admitted.pluginId!==pluginId||admitted.contextToken!==contextToken||admitted.toolName!==payload.toolName||!receipt||receipt.nativeStreamId!==payload.nativeStreamId||!admitted.transports.has(payload.nativeStreamId+':'+receipt.transportRequestId)||receipt.provider!==capturedModel.provider||receipt.capturedModel!==capturedModel.model)throw failure('DSH_NATIVE_USAGE_SCOPE_DENIED','Native usage has no matching admitted tool/model call');
                const id=payload.nativeStreamId+':'+receipt.transportRequestId;
                if(admitted.receipts.has(id))return admitted.receipts.get(id);
                const operation=Promise.resolve().then(async()=>{
                  const record={...receipt,capturedBindingFingerprint:capturedModel.fingerprint};
                  await audit('native-model-usage',{pluginId,nativeToolCallId:payload.callId,nativeToolName:payload.toolName,nativeStreamId:payload.nativeStreamId,jobId:taskMode.jobId,runId:taskMode.runId,receipt:record});
                  const result=await onNativeModelUsage({runtimeId,profileId,jobId:taskMode.jobId,runId:taskMode.runId,pluginId,contextToken,nativeToolCallId:payload.callId,nativeToolName:payload.toolName,nativeStreamId:payload.nativeStreamId,receipt:record});
                  if(result?.recorded!==true)throw failure('DSH_NATIVE_USAGE_NOT_RECORDED','The host did not retain the actual native model usage receipt');return {recorded:true};
                });admitted.receipts.set(id,operation);return operation;
              }
              if(message.kind==='native-model-request'){
                if(!taskOnly||!capturedModel)throw failure('DSH_NATIVE_MODEL_CONFIGURATION_REQUIRED','Native AI tools need an explicitly captured DSH model binding');
                const {pluginId,contextToken,payload={}}=message.params;
                if(!/^[a-f0-9-]{36}$/.test(payload.nativeStreamId??'')||!/^[a-f0-9-]{36}$/.test(payload.nativeRequestId??''))throw failure('DSH_NATIVE_TRANSPORT_ADMISSION_REQUIRED','Native model transport requires exact stream/request identifiers');
                const nativeCall=typeof payload.callId==='string'&&payload.callId.startsWith('buddy-external:')?pending.get(payload.callId.slice('buddy-external:'.length)):null;
                if(nativeCall?.method!=='tools.call'||nativeCall.admission?.pluginId!==pluginId||nativeCall.admission?.contextToken!==contextToken)throw failure('DSH_NATIVE_MODEL_ADMISSION_DENIED','Model request is not inside the live host-owned native tool invocation');
                const selection={provider:capturedModel.provider,model:capturedModel.model,...(capturedModel.effort==null?{}:{reasoningEffort:capturedModel.effort})};
                if(canonicalPluginJson(payload.modelSelection)!==canonicalPluginJson(selection))throw failure('DSH_NATIVE_MODEL_BINDING_CHANGED','Native tool requested a different model binding');
                const checked=await buddyServices.authorize({pluginId,contextToken,capability:'models.request',payload:{connectionRef:capturedModel.connectionRef}});
                const decision=await authorizeNativeModel({runtimeId,profileId,jobId:taskMode.jobId,runId:taskMode.runId,pluginId,contextToken,callId:payload.callId,nativeToolName:nativeCall.toolName,nativeStreamId:payload.nativeStreamId,nativeRequestId:payload.nativeRequestId,modelSelection:selection,signal:controller.signal});
                if(decision?.allowed!==true)throw failure('DSH_NATIVE_MODEL_ADMISSION_DENIED','Host did not admit this native model request');
                await buddyServices.checkAuthorization({pluginId,contextToken,capability:'models.request',generation:checked.generation,payload:{connectionRef:capturedModel.connectionRef}});
                if(!nativeModelAdmissions.has(payload.callId))nativeModelAdmissions.set(payload.callId,{pluginId,contextToken,toolName:nativeCall.toolName,transports:new Set(),receipts:new Map()});
                nativeModelAdmissions.get(payload.callId).transports.add(payload.nativeStreamId+':'+payload.nativeRequestId);
                return {allowed:true};
              }
              return buddyServices.invoke(message.params, {signal:controller.signal,origin:{runtimeId,profileId,pid:requester.pid}});
            });
            buddyCalls.set(message.id,{controller,operation});
            operation.then(result => {stage.record('buddy.invoke',message.id,'buddy-main.end',{elapsedMs:performance.now()-diagnosticStart});return requester?.connected && requester.send({ channel: CHANNEL, kind: 'buddy-response', id: message.id, result });}, error => {stage.record('buddy.invoke',message.id,'buddy-main.error',{elapsedMs:performance.now()-diagnosticStart});return requester?.connected && requester.send({ channel: CHANNEL, kind: 'buddy-response', id: message.id, error: dshModelError(error,{causeCode:modelNotSubmittedCause(error)}) });}).finally(()=>buddyCalls.delete(message.id));
          } else if (message.kind === 'buddy-cancel') {
            buddyCalls.get(message.id)?.controller.abort(failure('ABORT_ERR','Native tool cancelled its Buddy service request'));
          } else emit({ ...message, channel: undefined });
        });
        const consume = (stream, data) => {
          const text = data.toString(); tail = (tail + text).slice(-20000);
          const match = tail.match(/dsh web:\s*(https?:\/\/[^\s]+\?token=[^\s]+)/);
          if (match) { authURL = match[1]; webOrigin = new URL(authURL).origin; finish(); }
          emit({ kind: 'runtime-log', stream, text: redact(text) });
        };
        child.stdout.on('data', data => consume('stdout', data));
        child.stderr.on('data', data => consume('stderr', data));
        child.on('error', error => finish(error));
        child.on('exit', (code, signal) => {
          for(const row of buddyCalls.values())row.controller.abort(failure('ABORT_ERR','Native runtime exited'));
          phase = closed ? 'closed' : 'exited'; bridgeReady = false; authURL = undefined;
          const error = failure('DSH_RUNTIME_EXITED', `DSH exited (${code ?? signal}): ${redact(tail.slice(-5000))}`);
          for (const entry of pending.values()) { entry.cleanup(); entry.reject(error); }
          pending.clear();
          if (!settled) finish(error);
          emit({ kind: 'runtime-exit', pid: child.pid, code, signal });
        });
        if(taskOnly)Promise.resolve().then(async()=>{const receipt=await onProcessStart({runtimeId,pid:child.pid,nodePath:paths.node,jobId:taskMode.jobId,runId:taskMode.runId,profileId});if(receipt?.registered!==true||receipt?.guardReady!==true)throw failure('DSH_TASK_GUARD_NOT_READY','The task-only native Host was not admitted by the OS guard');if(closed||child.exitCode!==null)throw failure('DSH_BACKEND_CLOSED','Task Host closed before admission');child.send({channel:CHANNEL,kind:'bootstrap-admit',nonce});}).catch(finish);
      });
      phase = 'running';
      const live = await rpc('management.snapshot');
      const names = new Set((await rpc('bridge.schemaSnapshot')).map(tool => tool.name));
      const enabled = new Set(live.bundles.filter(row => row.enabled && !row.error).map(row => row.name));
      toolOwners = Object.fromEntries(Object.entries(toolOwners).filter(([name, owner]) => names.has(name) && enabled.has(owner.packageName ?? owner)));
    })().catch(async error => {
      lastError = { code: error.code, message: redact(error.message) };
      if (!child || child.exitCode !== null) phase = closed ? 'closed' : 'failed';
      if (child?.pid && child.exitCode === null) {
        const failedChild = child;
        failedChild.kill('SIGTERM');
        await Promise.race([new Promise(done => failedChild.once('exit', done)), new Promise(done => setTimeout(done, 5000))]);
        if (failedChild.exitCode === null) phase = 'failed-live-process';
      }
      throw error;
    }).finally(() => { startPromise = undefined; });
    return startPromise;
  }
  async function snapshot(ref) {
    if (!child || phase !== 'running') return { runtimeId, profileId, purpose, phase, lastError, installed: [], ready: (await probe()).ready };
    const raw = await rpc('management.snapshot');
    return { runtimeId, profileId, purpose, pid:child.pid, phase, bundles: ref ? raw.bundles.filter(row => row.name === ref.packageName) : raw.bundles, plugins: raw.plugins, webOrigin, lastError };
  }
  /** Fresh private IPC identity. Core also checks its registered OS birth. */
  async function identity(){
    await start();const current=child;
    if(phase!=='running'||!bridgeReady||!current?.connected||current.exitCode!==null)throw failure('DSH_RUNTIME_NOT_LIVE','Native runtime is not currently connected');
    const actual=await rpc('runtime.identity');
    if(current!==child||phase!=='running'||!bridgeReady||!current.connected||current.exitCode!==null||actual?.pid!==current.pid||actual.runtimeId!==runtimeId||actual.profileId!==profileId||actual.purpose!==purpose||actual.protocolVersion!==1)throw failure('DSH_RUNTIME_IDENTITY_MISMATCH','Native IPC identity differs from the currently owned runtime');
    return {runtimeId,profileId,pid:current.pid,purpose,phase:'running',protocolVersion:1,sourceCommit:PIN};
  }
  async function planInstall(request) {
    const packageRef = request.packageRef ?? request;
    const spec = normalizeSpec(request.spec ?? packageRef.spec, packageRef);
    if (!spec || !packageRef.packageName || !packageRef.exactVersion || !packageRef.sourceDigest || !packageRef.sourceId) throw failure('DSH_PACKAGE_REF_REQUIRED', 'Exact source-bound package identity and install spec are required');
    let verified;
    if (packageRef.spec?.kind === 'git') {
      const runtime = await readRuntime(true);
      const emptyConfig = resolve(stateDir, 'source-npmrc'), globalConfig = resolve(stateDir, 'source-global-npmrc'); await mkdir(stateDir, { recursive: true }); await writeFile(emptyConfig, ''); await writeFile(globalConfig, '');
      verified = await prepareDshGitPackage({ spec: packageRef.spec, packageRef, stateDir, paths: runtime.paths, env: dshRuntimeEnvironment(process.env, { PATH: `${dirname(runtime.paths.node)};${process.env.PATH ?? ''}`, npm_config_userconfig: emptyConfig, npm_config_globalconfig: globalConfig, npm_config_cache: resolve(stateDir, 'npm-cache') }), signal: request.signal, maxBytes: maxPackageBytes });
      await verifyTarball(verified.spec, { ...packageRef, sourceDigest: verified.artifactSha256 });
    } else if (packageRef.spec?.kind === 'registry') {
      const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(packageRef.packageName)}/${encodeURIComponent(packageRef.exactVersion)}`, { signal: request.signal });
      if (!response.ok) throw failure('DSH_REGISTRY_METADATA_FAILED', `Registry metadata returned ${response.status}`);
      const metadata = await response.json();
      if (metadata.name !== packageRef.packageName || metadata.version !== packageRef.exactVersion || !/^https:\/\//.test(metadata.dist?.tarball ?? '') || !/^sha512-[A-Za-z0-9+/=]+$/.test(metadata.dist?.integrity ?? '')) throw failure('DSH_REGISTRY_IDENTITY_INVALID', 'Registry metadata lacks the exact identity and SHA512 integrity');
      verified = await verifyTarball(metadata.dist.tarball, packageRef, { signal: request.signal });
      const bytes = await readFile(verified.spec);
      if (`sha512-${createHash('sha512').update(bytes).digest('base64')}` !== metadata.dist.integrity) throw failure('DSH_REGISTRY_INTEGRITY_MISMATCH', 'Registry integrity differs from the signed-digest-verified archive');
      verified.receipt = { ...verified.receipt, registry: 'https://registry.npmjs.org', integrity: metadata.dist.integrity };
    } else verified = await verifyTarball(spec, packageRef, { signal: request.signal });
    const inspection = await rpc('management.inspect', { spec: verified.spec });
    const artifactSha256 = verified.artifactSha256 ?? verified.receipt.sha256, artifact = verified.spec, sourceVerification = verified.receipt;
    return { schemaVersion: 1, backend: 'dsh', packageRef, profileId, spec, artifact, artifactSha256, sourceVerification, grantedCapabilities: request.grantedCapabilities ?? [], inspection, planDigest: digest(canonicalPluginJson({ packageRef, profileId, spec, artifactSha256, sourceVerification })) };
  }
  async function install(plan, options = {}) {
    let expectedPlanDigest;
    try { expectedPlanDigest = digest(canonicalPluginJson({ packageRef: plan.packageRef, profileId, spec: plan.spec, artifactSha256: plan.artifactSha256, sourceVerification: plan.sourceVerification })); }
    catch (cause) { throw failure('DSH_INSTALL_PLAN_CHANGED', 'Install plan is incomplete or contains non-JSON data', { cause }); }
    if (plan.profileId !== profileId || plan.planDigest !== expectedPlanDigest) throw failure('DSH_INSTALL_PLAN_CHANGED', 'Install plan identity changed');
    const expectedArtifact = resolve(stateDir, 'verified-packages', `${plan.artifactSha256}.tgz`);
    if (resolve(plan.artifact ?? '') !== expectedArtifact || !/^[a-f0-9]{64}$/.test(plan.artifactSha256 ?? '')) throw failure('DSH_INSTALL_PLAN_CHANGED', 'Install artifact differs from the approved exact cache');
    const verified = await verifyTarball(expectedArtifact, { ...plan.packageRef, sourceDigest: plan.artifactSha256 }, options);
    const installSpec = verified.spec;
    // Dispose the old live plugin before the package manager replaces its
    // files. Otherwise its loader may reopen a social session while the host
    // still has the previous exact package identity, leaving the new UI bound
    // to a permanently stale session. Do not relax the facade identity check.
    const previousIdentity = identities[plan.packageRef.packageName];
    if (previousIdentity && (previousIdentity.exactVersion !== plan.packageRef.exactVersion || previousIdentity.sourceDigest !== plan.packageRef.sourceDigest)) {
      const currentBundle = (await rpc('management.snapshot')).bundles.find(row => row.name === plan.packageRef.packageName);
      // Rollback has already removed its bundle before calling install. A
      // retained identity receipt alone does not imply live package code.
      if (currentBundle?.installed) {
        if (currentBundle.version !== previousIdentity.exactVersion) throw failure('DSH_INSTALLED_IDENTITY_MISMATCH', 'Live bundle changed before upgrade disposal');
        const disabled = await rpc('management.disable', { packageName: plan.packageRef.packageName }, options);
        await requireManagementOutcome(disabled, previousIdentity, false);
        await audit('upgrade-previous-disabled', { packageName: plan.packageRef.packageName, previousIdentity, nextVersion: plan.packageRef.exactVersion });
      }
    }
    const before = await rpc('bridge.schemaSnapshot');
    let result = await rpc('management.install', { spec: installSpec, options: { enabled: options.enabled ?? true, ...(options.approvedBuilds ? { approvedBuilds: options.approvedBuilds } : {}) } }, options);
    if(result?.error?.code==='already-installed'){
      const originalInstallResult=result,ref=plan.packageRef,known=identities[ref.packageName];
      await audit('install-already-present',{packageRef:ref,result:originalInstallResult});
      if(!known||known.packageName!==ref.packageName||known.exactVersion!==ref.exactVersion||known.sourceDigest!==ref.sourceDigest||known.pluginId!==(ref.hostPluginId??ref.pluginId??ref.packageName))throw failure('DSH_INSTALLED_IDENTITY_MISMATCH','The installed package has no matching previous exact artifact identity');
      const files=new Map();tarballIdentity(await readFile(expectedArtifact),files);
      const existingArtifactVerification=await verifyInstalledDshArtifact({profileRoot:resolve(dshHome,'profiles',profileId),packageName:ref.packageName,exactVersion:ref.exactVersion,files});
      const observed=await rpc('management.snapshot'),bundle=observed.bundles.find(row=>row.name===ref.packageName);
      if(!bundle?.installed||bundle.version!==ref.exactVersion)throw failure('DSH_INSTALLED_IDENTITY_MISMATCH','Native inventory differs from the verified existing package');
      const selected=await rpc(options.enabled===false?'management.disable':'management.enable',{packageName:ref.packageName});
      result={...selected,bundle:ref.packageName,version:ref.exactVersion,reusedExisting:true,existingArtifactVerification,originalInstallResult};
      await audit('install-existing-artifact-verified',{packageRef:ref,existingArtifactVerification,selectionResult:selected});
    }
    await requireManagementOutcome(result, plan.packageRef, options.enabled ?? true);
    if (result.bundle !== plan.packageRef.packageName || result.version !== plan.packageRef.exactVersion) throw failure('DSH_INSTALLED_IDENTITY_MISMATCH', 'The actual package manager result differs from the verified archive');
    const after = await rpc('bridge.schemaSnapshot');
    const previousNames = new Set(before.map(tool => tool.name));
    identities[plan.packageRef.packageName] = { packageName: plan.packageRef.packageName, pluginId: plan.packageRef.hostPluginId ?? plan.packageRef.pluginId ?? plan.packageRef.packageName, exactVersion: plan.packageRef.exactVersion, sourceDigest: plan.packageRef.sourceDigest };
    for (const tool of after) if (!previousNames.has(tool.name)) toolOwners[tool.name] = identities[plan.packageRef.packageName];
    await writeFile(resolve(stateDir, 'tool-owners.json'), JSON.stringify(toolOwners, null, 2));
    await writeFile(resolve(stateDir, 'package-identities.json'), JSON.stringify(identities, null, 2));
    await audit('install-result', { packageRef: plan.packageRef, verified: plan.sourceVerification, artifact: verified.receipt, result });
    return { ...result, packageRef: plan.packageRef, profileId, verification: plan.sourceVerification, artifactVerification: verified.receipt };
  }
  async function requireManagementOutcome(result, ref, enabled) {
    if (result?.application !== 'applied' || result?.error || result?.enabled !== enabled) {
      const code = result?.application === 'cancelled' ? 'DSH_INSTALL_CANCELLED' : result?.application === 'restart-required' ? 'DSH_RESTART_REQUIRED' : result?.stage === 'enable' ? 'DSH_ACTIVATION_FAILED' : 'DSH_PACKAGE_INSTALL_FAILED';
      await audit('management-not-applied', {packageName:ref.packageName,result});
      throw failure(code, `Native package operation was not applied: ${result?.error?.diagnostic ?? result?.error?.code ?? result?.application ?? 'missing-result'}`, {nativeResult:sanitized(result)});
    }
    if (!enabled) return;
    const actual = await rpc('management.snapshot'), bundle = actual.bundles.find(row=>row.name===ref.packageName);
    const rows = (bundle?.rows ?? []).map(row=>({rowId:row.rowId,moduleName:row.moduleName,entry:actual.plugins.find(plugin=>plugin.entryId===row.entryId)}));
    const failed = rows.filter(row=>!row.entry || row.entry.enabled && (row.entry.fiberPhase!=='active' || row.entry.error));
    if (!bundle?.enabled || bundle.error || failed.length) {
      const evidence={bundle,rows,failed};await audit('activation-not-ready', {packageName:ref.packageName,result,evidence});
      throw failure('DSH_ACTIVATION_FAILED','The native bundle is selected but its required Host entries are not active',{nativeResult:sanitized(result),activation:sanitized(evidence)});
    }
    result.activation={observed:true,packageName:bundle.name,version:bundle.version,entries:rows.map(row=>({entryId:row.entry.entryId,moduleName:row.moduleName,enabled:row.entry.enabled,fiberPhase:row.entry.fiberPhase}))};
  }
  async function verifyTarball(spec, packageRef, options = {}) {
    if (/\.(?:tgz|tar\.gz)(?:[?#].*)?$/i.test(spec)) {
      let bytes;
      if (/^https?:/i.test(spec)) {
        const response = await fetch(spec, { signal: options.signal });
        if (!response.ok) throw failure('DSH_PACKAGE_DOWNLOAD_FAILED', `Package download returned ${response.status}`);
        if (Number(response.headers.get('content-length')) > maxPackageBytes) throw failure('DSH_PACKAGE_TOO_LARGE', 'Package exceeds the configured download limit');
        const chunks = []; let size = 0;
        for await (const chunk of response.body) { size += chunk.length; if (size > maxPackageBytes) throw failure('DSH_PACKAGE_TOO_LARGE', 'Package exceeds the configured download limit'); chunks.push(chunk); }
        bytes = Buffer.concat(chunks, size);
      } else {
        const path = spec.startsWith('file://') ? fileURLToPath(spec) : spec.replace(/^file:/, '');
        if ((await stat(path)).size > maxPackageBytes) throw failure('DSH_PACKAGE_TOO_LARGE', 'Package exceeds the configured download limit');
        bytes = await readFile(path);
      }
      const expected = packageRef.sourceDigest.replace(/^sha256:/, '');
      if (!/^[a-f0-9]{64}$/i.test(expected) || digest(bytes) !== expected.toLowerCase()) throw failure('DSH_PACKAGE_DIGEST_MISMATCH', 'Package bytes differ from the signed source digest');
      const identity = tarballIdentity(bytes);
      if (identity.name !== packageRef.packageName || identity.version !== packageRef.exactVersion) throw failure('DSH_PACKAGE_IDENTITY_MISMATCH', 'Package name/version differs from its exact install plan');
      const cache = resolve(stateDir, 'verified-packages');
      await mkdir(cache, { recursive: true });
      const installSpec = resolve(cache, `${expected.toLowerCase()}.tgz`);
      await writeFile(installSpec, bytes);
      return { spec: installSpec, receipt: { digestType: 'sha256-archive', sha256: expected.toLowerCase(), bytes: bytes.length, name: identity.name, version: identity.version } };
    }
    throw failure('DSH_SOURCE_BINDING_REQUIRED', 'This source requires a verified immutable content binding before installation');
  }
  async function authorize(context, capability, payload) {
    if (!buddyServices?.authorize || !context?.pluginId || !context?.contextToken) throw failure('BUDDY_CONTEXT_REQUIRED', 'A host-issued plugin context is required');
    return buddyServices.authorize({ pluginId: context.pluginId, contextToken: context.contextToken, capability, payload });
  }
  async function nativeToolScope(checked) {
    // Social tools use their own package namespace. They never receive a
    // project Agent/cwd or planning/execution authority from the work host.
    if(checked.context.contextKind==='social')return undefined;
    if (typeof resolveToolScope !== 'function') return undefined;
    const selected = await resolveToolScope(structuredClone(checked.context));
    if (selected == null) return undefined;
    const input = selected.modelSelection;
    if (!input || typeof input.provider !== 'string' || !input.provider || typeof input.model !== 'string' || !input.model || input.provider.length > 300 || input.model.length > 300 || (input.reasoningEffort != null && (typeof input.reasoningEffort !== 'string' || input.reasoningEffort.length > 100))) throw failure('DSH_TOOL_MODEL_SELECTION_REQUIRED', 'The host must attest an exact native provider/model selection');
    if (!checked.context.workspace?.path) throw failure('DSH_TOOL_WORKSPACE_REQUIRED', 'A native tool Agent scope requires a trusted workspace');
    const modelSelection = { provider: input.provider, model: input.model, ...(input.reasoningEffort == null ? {} : { reasoningEffort: input.reasoningEffort }) };
    const identity = Object.fromEntries(['pluginId','characterId','personaId','lifeId','sessionId','taskId','contextRevision'].filter(key => checked.context[key] != null).map(key => [key, checked.context[key]]));
    const body = { identity, generation: checked.generation, cwd: checked.context.workspace.path, modelSelection };
    return { ...body, key: digest(canonicalPluginJson(body)) };
  }
  async function listTools(context) {
    const checked = await authorize(context, 'tools.list', {});
    const names = Object.keys(toolOwners).filter(name => (toolOwners[name].pluginId ?? toolOwners[name]) === context.pluginId || checked.context.permissionScope?.includes('tools.all'));
    const nativeScope = await nativeToolScope(checked);
    await buddyServices.checkAuthorization({ pluginId: context.pluginId, contextToken: context.contextToken, capability: 'tools.list', generation: checked.generation, payload: {} });
    const result = await rpc('tools.list', { admission: { allowedNames: names }, nativeScope });
    await buddyServices.checkAuthorization({ pluginId: context.pluginId, contextToken: context.contextToken, capability: 'tools.list', generation: checked.generation, payload: {} });
    return result;
  }
  async function callTool(request, context) {
    const checked = await authorize(context, 'tools.invoke', request);
    const names = Object.keys(toolOwners).filter(name => (toolOwners[name].pluginId ?? toolOwners[name]) === context.pluginId || checked.context.permissionScope?.includes('tools.all'));
    const nativeScope = await nativeToolScope(checked);
    await buddyServices.checkAuthorization({ pluginId: context.pluginId, contextToken: context.contextToken, capability: 'tools.invoke', generation: checked.generation, payload: request });
    const result = await rpc('tools.call', { name: request.name, arguments: request.arguments, nativeScope, admission: { allowedNames: names, readOnlyToolNames: checked.context.readOnlyToolNames ?? [], planState: checked.context.planState ?? 'planning', contextKind:checked.context.contextKind??'work', pluginId: checked.context.pluginId, contextToken:context.contextToken, taskId: checked.context.taskId } }, { signal: request.signal });
    await buddyServices.checkAuthorization({ pluginId: context.pluginId, contextToken: context.contextToken, capability: 'tools.invoke', generation: checked.generation, payload: request });
    await audit('tool-result', { pluginId: context.pluginId, name: request.name, result });
    return result;
  }
  async function openClient() { if(taskOnly)throw failure('DSH_TASK_UI_FORBIDDEN','Task-only native Hosts have no Web UI');await start(); return { runtimeId, profileId, webOrigin, authURL, url: `${webOrigin}/`, uiPolicy:hostUiPolicy, clientState: 'host-ready-client-not-yet-observed' }; }
  async function enable(ref) {
    const before = new Set((await rpc('bridge.schemaSnapshot')).map(tool => tool.name));
    const result = await rpc('management.enable', { packageName: ref.packageName });
    await requireManagementOutcome(result, ref, true);
    const identity = identities[ref.packageName];
    if (identity) for (const tool of await rpc('bridge.schemaSnapshot')) if (!before.has(tool.name)) toolOwners[tool.name] = identity;
    await writeFile(resolve(stateDir, 'tool-owners.json'), JSON.stringify(toolOwners, null, 2));
    return result;
  }
  async function verifySocialUI({identity,origin,request}){
    if(closed||!child||origin.pid!==child.pid||origin.runtimeId!==runtimeId||origin.profileId!==profileId||!webOrigin||request?.method!=='POST')return false;
    let url;try{url=new URL(request.url);}catch{return false;}
    const expected='/api/'+identity.packageName.replace('@ai-buddy/','ai-buddy/');
    // The pinned DSH fetch carrier rewrites Request.url to dsh.internal.
    // Its original HTTP Host must still match this exact loopback listener;
    // the signed cookie is revalidated by that listener below.
    if(!socialUIRequestAdmissible(request,webOrigin,expected))return false;
    // Native's own signed-cookie middleware authenticates this second GET.
    // Do not add a launch token, use an alternate address, or log the cookie.
    const response=await fetch(webOrigin+expected+'?action=readiness',{headers:{cookie:request.headers.cookie},redirect:'error',signal:AbortSignal.timeout(5000)});
    return response.status===200;
  }
  async function close() {
    closed = true;
    for(const row of buddyCalls.values())row.controller.abort(failure('ABORT_ERR','Native backend is closing'));
    if (!child || child.exitCode !== null) { await Promise.allSettled([...buddyCalls.values()].map(row=>row.operation)); phase = 'closed'; return taskStopProof({stopped:true,...(child?{pid:child.pid,code:child.exitCode}: {})}); }
    const processToClose = child;
    const exited = new Promise(resolveExit => processToClose.once('exit', (code, signal) => resolveExit({ code, signal })));
    if (processToClose.connected && bridgeReady) processToClose.send({ channel: CHANNEL, kind: 'request', id: randomUUID(), method: 'runtime.shutdown', params: {} });
    else processToClose.kill('SIGTERM');
    let forced = false;
    const timer = setTimeout(() => {
      if (processToClose.exitCode !== null) return;
      forced = true;
      if (process.platform === 'win32') {
        const killer = spawn(resolve(process.env.SystemRoot ?? 'C:\\Windows', 'System32/taskkill.exe'), ['/PID', String(processToClose.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', env: dshRuntimeEnvironment(process.env, {}) });
        killer.once('error', () => processToClose.kill('SIGKILL'));
      } else processToClose.kill('SIGKILL');
    }, 30000);
    const result = await exited; clearTimeout(timer); phase = 'closed';
    await Promise.allSettled([...buddyCalls.values()].map(row=>row.operation));
    await audit('runtime-closed', { pid: processToClose.pid, forced, ...result });
    return taskStopProof({ stopped: true, pid: processToClose.pid, forced, ...result });
  }
  async function taskStopProof(result){
    if(!taskOnly||!child)return result;
    if(!jobStopPromise)jobStopPromise=Promise.resolve().then(()=>onProcessStop({runtimeId,pid:child.pid,jobId:taskMode.jobId,runId:taskMode.runId,...result})).then(proof=>{if(proof?.stopped!==true||proof.osActiveProcesses!==0)throw failure('DSH_TASK_STOP_UNCONFIRMED','The OS guard did not confirm zero owned task descendants');return {...result,osStopProof:proof};});
    try{return await jobStopPromise;}catch(error){jobStopPromise=null;throw error;}
  }
  return Object.freeze({ probe, snapshot, identity, status: snapshot, planInstall, install, enable, disable: ref => rpc('management.disable', { packageName: ref.packageName }), uninstall: ref => rpc('management.uninstall', { packageName: ref.packageName }), async rollback(ref, options = {}) { if (!options.plan) throw failure('DSH_ROLLBACK_PLAN_REQUIRED', 'Rollback requires an exact verified prior install plan'); await rpc('management.uninstall', { packageName: ref.packageName }); return install(options.plan, options); }, openClient, listTools, callTool, verifySocialUI, close, on: (name, listener) => { events.on(name, listener); return () => events.off(name, listener); } });
}

export function socialUIRequestAdmissible(request,webOrigin,expectedPath){
 let url,listener;try{url=new URL(request.url);listener=new URL(webOrigin);}catch{return false;}
 const headers=request.headers??{};
 return request.method==='POST'&&['127.0.0.1','localhost','[::1]'].includes(listener.hostname)&&
  (url.origin===webOrigin||url.origin==='http://dsh.internal'&&headers.host===listener.host)&&url.pathname===expectedPath&&
  (!headers.origin||headers.origin===webOrigin)&&headers['sec-fetch-site']!=='cross-site'&&!!headers.cookie&&
  String(headers['content-type']).split(';')[0].trim().toLowerCase()==='application/json';
}
