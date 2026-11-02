import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {gunzipSync} from 'node:zlib';
import {resolve} from 'node:path';
import {verifyInstalledDshArtifact} from '../dsh-platform/installed-artifact.mjs';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const fail=message=>Object.assign(Error(message),{code:'BUDDY_NATIVE_SOCIAL_DENIED'});
function archiveFiles(bytes,expected){
 if(hash(bytes)!==expected)throw fail('Native social sourceDigest differs from the fixed package');
 const tar=gunzipSync(bytes,{maxOutputLength:64*1024*1024}),files=new Map();
 for(let offset=0;offset+512<=tar.length;){const header=tar.subarray(offset,offset+512);if(header.every(v=>v===0))break;const str=(a,b)=>header.subarray(a,b).toString().replace(/\0.*$/s,''),name=(str(345,500)?str(345,500)+'/':'')+str(0,100),size=parseInt(str(124,136).trim()||'0',8),type=str(156,157)||'0';let checksum=0;for(let i=0;i<512;i++)checksum+=i>=148&&i<156?32:header[i];
  if(checksum!==parseInt(str(148,156).trim()||'0',8)||!Number.isSafeInteger(size)||size<0||offset+512+size>tar.length||!name.startsWith('package/')||name.includes('\\')||name.split('/').some(p=>p==='..'||p==='.')||!['0','5'].includes(type))throw fail('Invalid or linked native social archive');
  const key=name.slice(8);if(type==='0'){if(!key||files.has(key))throw fail('Duplicate native social source entry');files.set(key,hash(tar.subarray(offset+512,offset+512+size)));}offset+=512+Math.ceil(size/512)*512;
 }
 if(!files.has('package.json'))throw fail('Native social package manifest is absent');return files;
}
const sameIdentity=(a,b)=>['runtimeId','profileId','pid','purpose','sourceCommit'].every(key=>a?.[key]===b?.[key]);

/** Core-only Native observation. Never export this factory as a plugin RPC.
 * A real QQ/Bilibili adapter must supply a host-owned Native normalizer; this
 * utility does not implement either network client or trust plugin JSON flags.
 */
export function createNativeSocialAdapter({host,backend,packageRef,artifactPath,profileRoot,channel,accountBindingId,generation,toolName,toolArguments={},getAdmission,checkAdmission,normalizeEvent,now=Date.now,maxReceipts=1024}={}){
 if(!host?.registerTransport||!backend?.identity||!backend?.callTool||!packageRef?.packageName||!packageRef.exactVersion||!packageRef.hostPluginId||!artifactPath||!profileRoot||typeof getAdmission!=='function'||typeof checkAdmission!=='function'||typeof normalizeEvent!=='function'||typeof toolName!=='string'||!toolName)throw fail('Core Native social constructor requires exact host-only admission functions');
 if(!Number.isSafeInteger(maxReceipts)||maxReceipts<1||maxReceipts>100000)throw fail('Native social receipt limit is invalid');
 packageRef=structuredClone(packageRef);toolArguments=structuredClone(toolArguments);artifactPath=resolve(artifactPath);profileRoot=resolve(profileRoot);
 const expectedDigest=packageRef.sourceDigest?.replace(/^sha256:/,'');if(!/^[a-f0-9]{64}$/.test(expectedDigest??''))throw fail('Native social sourceDigest must be fixed SHA256');
 const pluginId=packageRef.hostPluginId,tickets=new WeakMap(),receipts=new Map();let closed=false,inFlight=null;
 async function verifyIdentity(expected){if(closed)throw fail('Native social adapter is revoked');const identity=await backend.identity();if(!Number.isSafeInteger(identity.pid)||identity.pid<=0||identity.phase!=='running'||expected&&!sameIdentity(expected,identity))throw fail('Native backend process identity changed');const files=archiveFiles(await readFile(artifactPath),expectedDigest),installed=await verifyInstalledDshArtifact({profileRoot,packageName:packageRef.packageName,exactVersion:packageRef.exactVersion,files});return {identity,installed};}
 const transport=host.registerTransport({pluginId,channel,accountBindingId,generation,verify:async ticket=>{
  const captured=tickets.get(ticket);if(!captured||captured.used)throw fail('No private host-observed Native transport receipt');
  await checkAdmission(captured.admission);await verifyIdentity(captured.identity);if(closed)throw fail('Native social adapter was revoked');captured.used=true;return structuredClone(captured.event);
 }});
 return Object.freeze({
  async capture({signal}={}){
   if(inFlight)return inFlight;
   const task=(async()=>{if(signal?.aborted)throw fail('Native social observation cancelled');const admission=await getAdmission();if(admission?.pluginId!==pluginId||!admission.contextToken)throw fail('Native tool admission belongs to another plugin');await checkAdmission(admission);const before=await verifyIdentity();
    const output=await backend.callTool({name:toolName,arguments:structuredClone(toolArguments),signal},admission);await checkAdmission(admission);await verifyIdentity(before.identity);if(signal?.aborted||closed)throw fail('Native social observation cancelled or revoked');
    const event=await normalizeEvent(structuredClone(output),{identity:structuredClone(before.identity),admission:structuredClone(admission.context),sourceDigest:expectedDigest});
    if(!event||typeof event!=='object')throw fail('Native source did not yield a verified platform event');
    // A caller has no serializable equivalent of this ticket. registerTransport
    // accepts only the receipt created immediately after our own callTool.
    const ticket=Object.freeze({}),captured={admission,identity:before.identity,event:structuredClone(event),used:false};tickets.set(ticket,captured);
    const result=await transport.observe(ticket);receipts.set(result.eventRef,{eventRef:result.eventRef,observedAt:now(),runtime:structuredClone(before.identity),packageName:packageRef.packageName,exactVersion:packageRef.exactVersion,sourceDigest:expectedDigest,toolName,admissionPluginId:admission.pluginId,contextTokenSha256:hash(admission.contextToken)});while(receipts.size>maxReceipts)receipts.delete(receipts.keys().next().value);return {...result,receipt:structuredClone(receipts.get(result.eventRef))};
   })();inFlight=task;try{return await task;}finally{if(inFlight===task)inFlight=null;}
  },
  receipt:eventRef=>structuredClone(receipts.get(eventRef)??null),
  revoke(){if(closed)return;closed=true;transport.revoke();},
 });
}
