import {spawn} from 'node:child_process';
import {renameSync} from 'node:fs';
import {mkdir,mkdtemp,writeFile,readFile,lstat,readdir,unlink,rmdir} from 'node:fs/promises';
import {join} from 'node:path';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import net from 'node:net';
import {setTimeout as delay} from 'node:timers/promises';
import {DatabaseSync} from 'node:sqlite';
import qrCode from './social-login-assets/qrcode.cjs';
import descriptor from './social-login-assets/napcat-v4.18.41.json' with {type:'json'};
import {createQqComponent,componentChild} from './qq-component.mjs';
import {assertOwnedListener} from './qq-owned-listener.mjs';
import {manualQqSession} from './qq-manual-connection.mjs';
import {inspectQqCache} from './qq-owned-cache.mjs';
import {createManagedProcessSupervisor} from './managed-process-supervisor.mjs';

const fail=code=>Object.assign(Error(code),{code});
const atStage=(error,qqStage,fallback)=>Object.assign(Error(fallback,{cause:error}),{code:error?.code??fallback,qqStage});
const privateKeys={USERPROFILE:'h',HOME:'h',APPDATA:'h/a',LOCALAPPDATA:'h/l',TEMP:'t',TMP:'t'};
const port=()=>new Promise((resolve,reject)=>{const server=net.createServer();server.once('error',reject);server.listen(0,'127.0.0.1',()=>{const value=server.address().port;server.close(()=>resolve(value));});});
async function bounded(promise,ms,code){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(fail(code)),ms);})]);}finally{clearTimeout(timer);}}
export function qrImage(url){let parsed;try{parsed=new URL(url);}catch{throw fail('QQ_QR_INVALID');}if(parsed.protocol!=='https:'||parsed.username||parsed.password||!(parsed.hostname==='qq.com'||parsed.hostname.endsWith('.qq.com'))||url.length>4096)throw fail('QQ_QR_INVALID');const code=qrCode(0,'M');code.addData(url);code.make();return 'data:image/svg+xml;base64,'+Buffer.from(code.createSvgTag({cellSize:5,margin:20,scalable:true})).toString('base64');}
// NapCat shares a name-keyed adapter registry across transport types.
// Reusing one name would let WebSocket replace HTTP before either is opened.
export function qqNetworkConfig(httpPort,wsPort,token){return {network:{httpServers:[{name:'ai-buddy-http',enable:true,host:'127.0.0.1',port:httpPort,token,enableCors:false,enableWebsocket:false,messagePostFormat:'array',debug:false}],websocketServers:[{name:'ai-buddy-websocket',enable:true,host:'127.0.0.1',port:wsPort,token,messagePostFormat:'array',debug:false,reportSelfMessage:false,enableForcePushEvent:false}],httpClients:[],websocketClients:[],plugins:[]},enableLocalFile2Url:false};}
export function createQqLoginRuntime({dataRoot,build,accounts,component=null,onState=()=>{},supervisor=null,network,fetchImpl=network?.fetch??globalThis.fetch,childEnvironment=()=>({}),spawnImpl=spawn,listenerInspector=assertOwnedListener,stopTimeoutMs=8000}={}){
 const root=join(dataRoot,'social-login'),profiles=join(root,'qq'),runs=new Map(),profileClaims=new Map(),restores=new Map(),pending=new Set(),resumeGenerations=new Map(),lifetime=new AbortController(),exits=[];let closed=false,db=null,opening=null,closing=null,shutdownComplete=false;
 component??=createQqComponent({directory:join(dataRoot,'plugin-runtimes','qq-components'),descriptor,network,fetchImpl});
 supervisor??=createManagedProcessSupervisor({guardPath:join(build,'managed-process-guard.exe'),statePath:join(root,'processes.json'),onState});
 async function database(){if(closed)throw fail('SOCIAL_LOGIN_CLOSED');if(db)return db;if(!opening)opening=(async()=>{await mkdir(root,{recursive:true});const next=new DatabaseSync(join(root,'onboarding-v1.sqlite'));try{next.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS bindings(ref TEXT PRIMARY KEY,body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL)");db=next;return db;}catch(cause){next.close();throw cause;}})().catch(cause=>{opening=null;throw cause;});return opening;}
 async function binding(ref){const saved=JSON.parse((await database()).prepare('SELECT body FROM bindings WHERE ref=?').get(ref)?.body??'null'),account=accounts.get(ref);return account?.managedProfileId?{...saved,ref,accountId:account.accountId,resourceId:account.managedProfileId}:saved;}
 async function saveBinding(value){(await database()).prepare('INSERT INTO bindings VALUES(?,?) ON CONFLICT(ref) DO UPDATE SET body=excluded.body').run(value.ref,JSON.stringify(value));}
 async function api(row,path,body={},authenticate=true){
  if(row.exit)throw fail('QQ_COMPONENT_EXITED');
  const response=await fetchImpl(`http://127.0.0.1:${row.webPort}/api/${path}`,{method:'POST',redirect:'error',headers:{'content-type':'application/json',...(authenticate?{authorization:'Bearer '+row.credential}:{})},body:JSON.stringify(body),signal:AbortSignal.timeout(5000)});
  const text=await response.text();if(text.length>2*1024*1024)throw fail('QQ_COMPONENT_RESPONSE_TOO_LARGE');let result;try{result=JSON.parse(text);}catch{throw fail('QQ_COMPONENT_RESPONSE_INVALID');}
  if(!response.ok||result.code!==0)throw fail('QQ_COMPONENT_API_FAILED');return result.data;
 }
 async function onebot(row,action){
  const response=await fetchImpl(`http://127.0.0.1:${row.httpPort}/${action}`,{method:'POST',redirect:'error',headers:{'content-type':'application/json',authorization:'Bearer '+row.accessToken},body:'{}',signal:AbortSignal.timeout(6000)});
  const text=await response.text();if(text.length>4*1024*1024)throw fail('QQ_COMPONENT_RESPONSE_TOO_LARGE');const value=JSON.parse(text);if(!response.ok||value.status!=='ok'||value.retcode!==0)throw fail('QQ_ONEBOT_NOT_READY');return value.data;
 }
 async function socketReady(row){
  // This native connection observes readiness only. It never dispatches a message.
  const socket=new WebSocket(`ws://127.0.0.1:${row.wsPort}/?access_token=${row.accessToken}`);
  try{await bounded(new Promise((yes,no)=>{socket.addEventListener('open',yes,{once:true});socket.addEventListener('error',()=>no(fail('QQ_ONEBOT_NOT_READY')),{once:true});}),6000,'QQ_ONEBOT_NOT_READY');}finally{socket.close();}
 }
 function releaseProfile(resourceId,attemptId){
  if(profileClaims.get(resourceId)===attemptId)profileClaims.delete(resourceId);
 }
 async function removeLaunchGate(gate){
  for(const path of [gate.path,gate.pending])await unlink(path).catch(()=>{});
  await rmdir(gate.directory).catch(()=>{});
 }
 async function stopRow(row){
  if(!row)return;if(row.stopping)return row.stopping;
  row.stopping=Promise.resolve().then(async()=>{
   row.abort.abort();
   clearInterval(row.cacheTimer);
   await row.admission?.catch(()=>{});
   const allowUnassigned=!row.grantAttempted;
   if(!row.exit&&allowUnassigned){
    // Only this ChildProcess can be stopped here. No NapCat code was released.
    if(Number.isInteger(row.child.pid))row.child.kill();
   }else if(!row.exit&&row.child.connected){
    try{
     await bounded(new Promise((yes,no)=>row.child.send({type:'shutdown'},error=>error?no(error):yes())),stopTimeoutMs,'QQ_COMPONENT_STOP_PENDING');
     await bounded(row.exited,stopTimeoutMs,'QQ_COMPONENT_STOP_PENDING');
    }catch{ /* The Job still owns shutdown if graceful IPC failed. */ }
   }
   let proof;
   try{proof=await supervisor.releaseRoot({runtimeId:row.runtimeId,allowUnassigned});}
   catch(error){
    if(error?.guardStage==='receipt-persist')throw Object.assign(fail('QQ_COMPONENT_STOP_RECEIPT_WRITE_FAILED'),{cause:error,qqStage:'receipt-write'});
    throw atStage(error,'guard-stop','QQ_COMPONENT_STOP_UNCONFIRMED');
   }
   if(proof?.stopped!==true||(proof.osActiveProcesses!==0&&!(allowUnassigned&&proof.unassigned===true)))throw fail('QQ_COMPONENT_STOP_UNCONFIRMED');
   try{await bounded(row.exited,stopTimeoutMs,'QQ_COMPONENT_STOP_PENDING');}
   catch(error){throw atStage(error,'process-exit','QQ_COMPONENT_STOP_PENDING');}
   await removeLaunchGate(row.gate);
   await inspectQqCache(row.profile,{prune:true}).catch(()=>{row.cacheWarning=true;});
   runs.delete(row.attemptId);
   releaseProfile(row.resourceId,row.attemptId);
   if(row.grantAttempted&&row.exit.code>0&&row.exit.code!==137)onState({type:'qq-runtime-exit',code:'QQ_COMPONENT_EXIT_FAILED'});
   onState();
  });
  try{await row.stopping;}catch(cause){row.stopping=null;throw cause;}
 }
 async function launch({attemptId,signal,update=()=>{},saved=null,official=false}){
  if(closed)throw fail('SOCIAL_LOGIN_CLOSED');
  signal=AbortSignal.any([signal,lifetime.signal]);
  const runtime=await component.ensure({signal,onProgress:update,official:official===true});signal.throwIfAborted();
  const store=await database();let resourceId=saved?.resourceId;
  if(!resourceId){resourceId=store.prepare("SELECT value FROM metadata WHERE key='pendingProfile'").get()?.value??randomUUID();if(accounts.list().some(account=>account.managedProfileId===resourceId))resourceId=randomUUID();if(!/^[a-f0-9-]{36}$/.test(resourceId))throw fail('QQ_PRIVATE_PROFILE_REQUIRED');store.prepare("INSERT INTO metadata VALUES('pendingProfile',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(resourceId);}
  if(profileClaims.has(resourceId))throw fail('SOCIAL_LOGIN_BUSY');
  profileClaims.set(resourceId,attemptId);
  try{return await launchProfile({attemptId,signal,runtime,resourceId,saved});}
  finally{if(!runs.has(attemptId))releaseProfile(resourceId,attemptId);}
 }
 async function launchProfile({attemptId,signal,runtime,resourceId,saved}){
  const profile=componentChild(profiles,resourceId);await mkdir(profile,{recursive:true});
  if((await lstat(profile)).isSymbolicLink())throw fail('QQ_COMPONENT_LINK_DENIED');
  await inspectQqCache(profile,{prune:true});
  const env=Object.fromEntries(['SystemRoot','WINDIR','ComSpec','NUMBER_OF_PROCESSORS','PROCESSOR_ARCHITECTURE'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]));
  for(const [key,sub]of Object.entries(privateKeys)){env[key]=join(profile,sub);await mkdir(env[key],{recursive:true});}
  const webPort=await port(),httpPort=await port(),wsPort=await port();if(new Set([webPort,httpPort,wsPort]).size!==3)throw fail('QQ_COMPONENT_PORT_CONFLICT');
  const token=randomBytes(32).toString('hex'),accessToken=randomBytes(32).toString('hex'),work=join(profile,'w'),config=join(work,'config');await mkdir(config,{recursive:true});
  await writeFile(join(config,'webui.json'),JSON.stringify({host:'127.0.0.1',port:webPort,token,autoLoginAccount:saved?.accountId??'',disableWebUI:false,loginRate:5,accessControlMode:'whitelist',ipWhitelist:['127.0.0.1','::1']}));
  await writeFile(join(config,'napcat.json'),JSON.stringify({fileLog:false,consoleLog:false,fileLogLevel:'error',consoleLogLevel:'error',autoTimeSync:false}));
  const network=JSON.stringify(qqNetworkConfig(httpPort,wsPort,accessToken));await writeFile(join(config,'onebot11.json'),network);
  for(const name of await readdir(config)){
   if(/^onebot11_\d{1,20}\.json$/.test(name))await writeFile(join(config,name),network);
   if(/^napcat_\d{1,20}\.json$/.test(name))await writeFile(join(config,name),JSON.stringify({fileLog:false,consoleLog:false,fileLogLevel:'error',consoleLogLevel:'error',autoTimeSync:false}));
  }
  if(saved?.accountId)await writeFile(join(config,'onebot11_'+saved.accountId+'.json'),network);
  Object.assign(env,{AI_BUDDY_QQ_PRIVATE_HOME:env.HOME,NAPCAT_WORKDIR:work,NAPCAT_WORKER_PROCESS:'1',NAPCAT_DISABLE_PIPE:'1',NAPCAT_DISABLE_TIME_SYNC:'1',NAPCAT_WRAPPER_PATH:join(runtime,'wrapper.node'),NAPCAT_QQ_PACKAGE_INFO_PATH:join(runtime,'package.json'),NAPCAT_QQ_VERSION_CONFIG_PATH:join(runtime,'config.json')});
  Object.assign(env,await childEnvironment({env:{...env},purpose:'qq-runtime',signal}));
  signal.throwIfAborted();
  const gateDirectory=await mkdtemp(join(root,'qq-launch-'));
  const gate={directory:gateDirectory,path:join(gateDirectory,'permit'),pending:join(gateDirectory,'permit.pending')};
  const permit=randomBytes(32).toString('hex');
  Object.assign(env,{AI_BUDDY_QQ_LAUNCH_FILE:gate.path,AI_BUDDY_QQ_LAUNCH_TOKEN:permit});
  let child;
  try{
   signal.throwIfAborted();
   child=spawnImpl(join(runtime,'node.exe'),['--require',join(build,'social-login-assets/qq-launch-gate.cjs'),join(runtime,'index.js')],{cwd:runtime,env,windowsHide:true,stdio:['ignore','ignore','ignore','ipc']});
  }catch(error){await removeLaunchGate(gate);throw error;}
  const row={attemptId,runtimeId:'qq:'+attemptId,grantAttempted:false,resourceId,profile,child,webPort,httpPort,wsPort,accessToken,abort:new AbortController(),exit:null,gate};runs.set(attemptId,row);
  row.cacheTimer=setInterval(()=>{if(row.cacheChecking||row.stopping||row.exit)return;row.cacheChecking=true;void inspectQqCache(profile).then(value=>{if(value.overLimit){row.cacheLimit=true;return stopRow(row);}}).catch(()=>{row.cacheLimit=true;return stopRow(row).catch(()=>{});}).finally(()=>{row.cacheChecking=false;});},30000);row.cacheTimer.unref?.();
  row.exited=new Promise(resolve=>{
   child.on('error',()=>{if(!Number.isInteger(child.pid)){row.exit={code:-1};resolve(row.exit);}});
   child.once('exit',(code,signal)=>{row.exit={code,signal};exits.push({pid:child.pid,code,signal,at:Date.now()});if(exits.length>20)exits.shift();resolve(row.exit);onState();});
  });
  child.on('message',message=>{if(message?.type==='restart'){row.restartRequested=true;onState();}});
  const combined=AbortSignal.any([signal,row.abort.signal]);row.signal=combined;
  row.admission=(async()=>{
   if(!Number.isInteger(child.pid)){await row.exited;throw fail('QQ_COMPONENT_EXITED');}
   let admission;
   try{admission=await supervisor.registerRoot({runtimeId:row.runtimeId,pid:child.pid});}
   catch(error){throw atStage(error,'guard-admission','WORK_PROCESS_GUARD_FAILED');}
   combined.throwIfAborted();
   if(row.exit)throw fail('QQ_COMPONENT_EXITED');
   await writeFile(gate.pending,permit,{flag:'wx'});
   combined.throwIfAborted();
   try{supervisor.rootCustody?.({runtimeId:row.runtimeId,pid:child.pid,creationTime:admission?.creationTime});}
   catch(error){throw atStage(error,'guard-admission','WORK_PROCESS_GUARD_FAILED');}
   // A rename error can race publication. Once attempted, require the real Job proof.
   row.grantAttempted=true;
   try{renameSync(gate.pending,gate.path);}
   catch{throw fail('QQ_COMPONENT_LAUNCH_GATE_FAILED');}
  })();
  await row.admission;
  for(let n=0;n<40;n++){
   combined.throwIfAborted();if(row.exit)throw fail(row.exit.code===78?'QQ_PRIVATE_PROFILE_REQUIRED':row.exit.code===71?'QQ_COMPONENT_LAUNCH_GATE_EXPIRED':row.exit.code===72?'QQ_COMPONENT_LAUNCH_GATE_FAILED':'QQ_COMPONENT_EXITED');
   try{await listenerInspector(child.pid,[webPort]);row.credential=(await api(row,'auth/login',{hash:createHash('sha256').update(token+'.napcat').digest('hex')},false)).Credential;if(row.credential)return row;}catch(cause){if(cause.code==='QQ_LISTENER_OWNER_MISMATCH')throw cause;}
   await delay(1000,undefined,{signal:combined});
  }
  throw fail('QQ_COMPONENT_START_TIMEOUT');
 }
 async function awaitOnline(row,{signal,update=()=>{},expectedAccountId=null,restore=false}={}){
  const deadline=Date.now()+(restore?30000:10*60*1000);let lastQr='';
  while(Date.now()<deadline){
   signal.throwIfAborted();if(row.cacheLimit)throw fail('QQ_CACHE_LIMIT_REACHED');if(row.restartRequested)throw fail('QQ_COMPONENT_RESTART_REQUIRED');
   const state=await api(row,'QQLogin/CheckLoginStatus');
   if(state.isLogin===true&&state.coreReady===true){
    update({phase:'verifying',clearQr:true});const login=await api(row,'QQLogin/GetQQLoginInfo'),accountId=String(login.uin??'');
    if(!/^\d{1,20}$/.test(accountId)||login.online!==true||expectedAccountId&&expectedAccountId!==accountId)throw fail('SOCIAL_LOGIN_IDENTITY_MISMATCH');
    let identity,socketVerified=false;for(let n=0;n<15;n++){signal.throwIfAborted();try{await listenerInspector(row.child.pid,[row.httpPort,row.wsPort]);identity=await onebot(row,'get_login_info');await socketReady(row);socketVerified=true;break;}catch(cause){if(cause.code==='QQ_LISTENER_OWNER_MISMATCH')throw cause;await delay(1000,undefined,{signal});}}
    if(!identity||!socketVerified)throw fail('QQ_ONEBOT_NOT_READY');if(String(identity.user_id)!==accountId)throw fail('SOCIAL_LOGIN_IDENTITY_MISMATCH');
    const confirmed=await api(row,'QQLogin/CheckLoginStatus');if(confirmed.isLogin!==true||confirmed.coreReady!==true)throw fail('QQ_ONEBOT_NOT_READY');
    signal.throwIfAborted();row.accountId=accountId;return {accountId,label:String(identity.nickname||accountId).slice(0,180),httpUrl:`http://127.0.0.1:${row.httpPort}`,webSocketUrl:`ws://127.0.0.1:${row.wsPort}`,secret:{accessToken:row.accessToken},resourceId:row.resourceId,attemptId:row.attemptId};
   }
   update({phase:state.qrLoginAccepted||state.loginPhase==='qrcode_scanned'?'waiting-confirmation':'waiting-qr'});
   if(state.qrcodeurl&&state.qrcodeurl!==lastQr){if(restore)throw fail('SOCIAL_LOGIN_EXPIRED');lastQr=state.qrcodeurl;update({qr:qrImage(lastQr)});}
   if(state.isOffline)throw fail('SOCIAL_LOGIN_EXPIRED');
   await delay(1500,undefined,{signal});
  }
  throw fail('SOCIAL_LOGIN_EXPIRED');
 }
 async function start(options){
  let row;
  const operation=(async()=>{
   try{row=await launch(options);return await awaitOnline(row,{...options,signal:row.signal});}
   catch(cause){
    try{await stopRow(row??runs.get(options.attemptId));}
    catch(cleanup){throw Object.assign(Error('QQ connection cleanup failed',{cause:cleanup}),{code:cleanup?.code,loginCause:cause});}
    throw cause;
   }
  })();
  pending.add(operation);try{return await operation;}finally{pending.delete(operation);}
 }
 async function committed(result,account){
  let warningCode;
  // Profile binding already committed atomically with the account. These are
  // cleanup operations; their failure must not erase a successful login.
  try{await saveBinding({ref:account.ref,accountId:account.accountId,resourceId:result.resourceId,autoResume:false});(await database()).prepare("DELETE FROM metadata WHERE key='pendingProfile' AND value=?").run(result.resourceId);}catch{warningCode='QQ_PROFILE_CLEANUP_PENDING';}
  for(const row of [...runs.values()])if(row.attemptId!==result.attemptId)try{await stopRow(row);}catch{warningCode='SOCIAL_LOGIN_STOP_PENDING';}
  return {warningCode};
 }
 async function ensureAccount(ref){
  if(closed)throw fail('SOCIAL_LOGIN_CLOSED');const account=accounts.get(ref),saved=await binding(ref);if(!account?.enabled||!saved||saved.accountId!==account.accountId)throw fail('QQ_MANAGED_ACCOUNT_REQUIRED');
  const existing=[...runs.values()].find(row=>row.resourceId===saved.resourceId);
  if(existing?.accountId===saved.accountId&&!existing.exit&&!existing.abort.signal.aborted)return existing;
  if(restores.has(ref))return restores.get(ref);
  const restoring=(async()=>{
   if(existing?.exit||existing?.abort.signal.aborted)await stopRow(existing);
   unchanged(account);
   const controller=new AbortController(),attemptId=randomUUID();
   const result=await start({attemptId,signal:controller.signal,saved,expectedAccountId:account.accountId,restore:true});
   if(closed||accounts.get(ref)?.generation!==account.generation){
    await stopRow(runs.get(attemptId));
    throw fail('SOCIAL_ACCOUNT_CHANGED');
   }
   accounts.commitLogin({...result,pluginId:account.pluginId},{requireConfirmation:account.activityApprovalRequired===true});
   return runs.get(attemptId);
  })();
  restores.set(ref,restoring);
  try{return await restoring;}finally{restores.delete(ref);}
 }
 async function connection(ref){const saved=await binding(ref);if(saved?.resourceId)await ensureAccount(ref);const account=accounts.get(ref);if(!account?.enabled||account.platform!=='qq')throw fail('SOCIAL_ACCOUNT_REQUIRED');return {account,session:manualQqSession(account,accounts.secret(ref))};}
 function unchanged(account){if(closed||accounts.get(account.ref)?.generation!==account.generation)throw fail('SOCIAL_ACCOUNT_CHANGED');}
 async function contacts(ref){const {account,session}=await connection(ref);await session.verify();const friends=await session.request('get_friend_list'),groups=await session.request('get_group_list');unchanged(account);if(!Array.isArray(friends)||!Array.isArray(groups)||friends.length>10000||groups.length>10000||[...friends.map(v=>v.user_id),...groups.map(v=>v.group_id)].some(id=>!/^\d{1,20}$/.test(String(id))))throw fail('QQ_CONTACTS_INVALID');return {accountRef:ref,accountId:account.accountId,contacts:friends.map(v=>({id:String(v.user_id),label:String(v.remark||v.nickname||v.user_id).slice(0,200)})),groups:groups.map(v=>({id:String(v.group_id),label:String(v.group_name||v.group_id).slice(0,200)}))};}
 return {start,committed,contacts,ensureAccount,ensureIfManaged:async(ref,{restore=false,scope}={})=>{const saved=await binding(ref);if(restore&&(!saved?.autoResume||['characterId','lifeId','operationId'].some(key=>!scope?.[key]||scope[key]!==saved.scope?.[key])))throw fail('QQ_RESTORE_NOT_AUTHORIZED');return saved?.resourceId?ensureAccount(ref):null;},componentInfo:component.info,
  async check(input){const {account,session}=await connection(input.ref);await session.verify();await session.socket();unchanged(account);return {connected:true,generation:account.generation};},
  diagnostics:()=>({active:[...runs.values()].map(row=>({pid:row.child.pid,resourceId:row.resourceId,exited:!!row.exit})),exits:structuredClone(exits)}),
  refresh:async({attemptId})=>{const row=runs.get(attemptId);if(!row)throw fail('SOCIAL_LOGIN_NOT_PENDING');await api(row,'QQLogin/RefreshQRcode');},
  stop:async({attemptId}={})=>{for(const row of [...runs.values()])if(!attemptId||row.attemptId===attemptId)await stopRow(row);},
  discard:async result=>stopRow(runs.get(result?.attemptId)),
  async setAutoResume(ref,enabled,scope,{signal,check=async()=>{}}={}){const account=accounts.get(ref);if(closed||!account?.enabled||account.platform!=='qq'||typeof enabled!=='boolean'||!scope||['characterId','lifeId','operationId'].some(key=>typeof scope[key]!=='string'||!scope[key]))throw fail('QQ_AUTOSTART_INVALID');const generation=(resumeGenerations.get(ref)??0)+1;resumeGenerations.set(ref,generation);const valid=()=>{signal?.throwIfAborted();if(closed||resumeGenerations.get(ref)!==generation||accounts.get(ref)?.generation!==account.generation)throw fail('SOCIAL_ACCOUNT_CHANGED');};await check();valid();const value=await binding(ref)??{ref,accountId:account.accountId,resourceId:null},databaseHandle=await database();await check();valid();databaseHandle.prepare('INSERT INTO bindings VALUES(?,?) ON CONFLICT(ref) DO UPDATE SET body=excluded.body').run(ref,JSON.stringify({...value,autoResume:enabled,scope:Object.fromEntries(['characterId','lifeId','operationId'].map(key=>[key,scope[key]]))}));},
  async close(){
   if(shutdownComplete)return;
   if(closing)return closing;
   closed=true;lifetime.abort();
   closing=Promise.resolve().then(async()=>{
    await Promise.allSettled([...restores.values(),...pending]);
    const stopped=await Promise.allSettled([...runs.values()].map(stopRow));
    const guarded=await Promise.allSettled([supervisor.close()]);
    await opening?.catch(()=>{});
    db?.close();db=null;
    const errors=[...stopped,...guarded].filter(row=>row.status==='rejected').map(row=>row.reason);
    if(errors.length)throw new AggregateError(errors,'QQ component shutdown failed');
    shutdownComplete=true;
   }).finally(()=>{closing=null;});
   return closing;
  },
 };
}
