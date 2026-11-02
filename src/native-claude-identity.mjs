import {lstat,realpath} from 'node:fs/promises';
import {join,resolve,isAbsolute} from 'node:path';
import {homedir} from 'node:os';
import {createHash} from 'node:crypto';
import {request,Agent} from 'node:https';
import {readPrivateCredentialFile,nativeClaudeCredentialMetadata} from './native-credential-vault.mjs';

export const NATIVE_CLAUDE_PROFILE_ENDPOINT='https://api.anthropic.com/api/oauth/profile';
const canonical=v=>v===null||typeof v!=='object'?JSON.stringify(v):Array.isArray(v)?'['+v.map(canonical).join(',')+']':'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}';
const hash=v=>createHash('sha256').update(Buffer.isBuffer(v)||typeof v==='string'?v:canonical(v)).digest('hex');
const fail=(code,message)=>Object.assign(Error(message),{code});
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(v);
const samePath=(a,b)=>process.platform==='win32'?resolve(a).toLowerCase()===resolve(b).toLowerCase():resolve(a)===resolve(b);
function json(bytes){try{return JSON.parse(bytes.toString('utf8'));}catch{throw fail('WORK_NATIVE_IDENTITY_FORMAT','Native account metadata JSON is invalid');}}
export function nativeClaudeAccountIdentity(value){
  if(!uuid(value?.accountUuid)||!uuid(value?.organizationUuid))throw fail('WORK_NATIVE_ACCOUNT_IDENTITY_REQUIRED','Native account metadata requires both account and organization UUIDs');
  const account=value.accountUuid.toLowerCase(),organization=value.organizationUuid.toLowerCase();
  return {accountHash:hash(account),organizationHash:hash(organization),identityHash:hash(JSON.stringify(['claude','native:claude-default',account,organization]))};
}
export function nativeClaudeConfigIdentity(bytes){return nativeClaudeAccountIdentity(json(bytes).oauthAccount);}
export async function nativeClaudeConfigPath({env=process.env,home=homedir()}={}){
  if(env.CLAUDE_CODE_CUSTOM_OAUTH_URL||env.CUSTOM_OAUTH_URL)throw fail('WORK_NATIVE_IDENTITY_ENDPOINT_UNSUPPORTED','Native default identity requires the official production OAuth source');
  const explicit=env.CLAUDE_CONFIG_DIR!==undefined;
  if(explicit&&(!isAbsolute(env.CLAUDE_CONFIG_DIR)||!env.CLAUDE_CONFIG_DIR.trim()))throw fail('WORK_NATIVE_IDENTITY_PATH','The selected native configuration directory must be absolute');
  const directory=resolve(explicit?env.CLAUDE_CONFIG_DIR:join(home,'.claude')),preferred=join(directory,'.config.json');
  try{await lstat(preferred);return {directory,path:preferred,mode:'native-config-json-override'};}catch(error){if(error.code!=='ENOENT')throw error;}
  return {directory,path:join(explicit?directory:home,'.claude.json'),mode:explicit?'explicit-config-directory':'native-default-home'};
}
/** Official pinned CLI metadata request. No redirects/proxy/env endpoint, model or refresh. */
export function requestNativeClaudeProfileIdentity({accessToken},{requestImpl=request}={}){
  if(typeof accessToken!=='string'||!accessToken)throw fail('ENGINE_AUTH_PROFILE_REQUIRED','Native access credential is unavailable');
  return new Promise((ok,no)=>{
    const agent=new Agent({keepAlive:false,rejectUnauthorized:true,proxyEnv:{}});
    const req=requestImpl(NATIVE_CLAUDE_PROFILE_ENDPOINT,{method:'GET',agent,headers:{'User-Agent':'claude-code/2.1.296',Authorization:'Bearer '+accessToken,'Content-Type':'application/json','Cache-Control':'no-cache'},rejectUnauthorized:true},res=>{
      if(res.statusCode!==200){res.resume();no(fail(res.statusCode>=300&&res.statusCode<400?'WORK_NATIVE_IDENTITY_REDIRECT_DENIED':'WORK_NATIVE_IDENTITY_PROFILE_FAILED','Official native account identity could not be verified'));return;}
      let size=0;const chunks=[];res.on('data',chunk=>{size+=chunk.length;if(size>1024*1024){res.destroy();no(fail('WORK_NATIVE_IDENTITY_FORMAT','Native identity response exceeds the metadata bound'));}else chunks.push(chunk);});
      res.once('error',()=>no(fail('WORK_NATIVE_IDENTITY_NETWORK','Official native account identity transport failed')));
      res.once('end',()=>{try{const value=json(Buffer.concat(chunks));ok({...nativeClaudeAccountIdentity({accountUuid:value.account?.uuid,organizationUuid:value.organization?.uuid}),endpoint:NATIVE_CLAUDE_PROFILE_ENDPOINT,verified:true,responseSha256:hash(Buffer.concat(chunks)),httpStatus:200,tlsAuthorized:res.socket?.authorized===true,requestId:res.headers?.['request-id']??res.headers?.['x-request-id']??null,verifiedAt:Date.now()});}catch(error){no(error);}});
    });
    // This is a bounded authentication-metadata operation, never model thinking.
    req.setTimeout(10000,()=>req.destroy());req.once('error',()=>no(fail('WORK_NATIVE_IDENTITY_NETWORK','Official native account identity transport failed')));req.end();
  });
}
/** Core-only source reader. Raw capture bytes are evidence; epoch uses identity semantics. */
export function createNativeClaudeIdentityReader({env=process.env,home=homedir(),profileVerifier=requestNativeClaudeProfileIdentity,now=Date.now,allowLegacyTopLevelOrganization=false}={}){
  const profiles=new Map();
  async function local(){
    const selected=await nativeClaudeConfigPath({env,home}),credentialPath=join(selected.directory,'.credentials.json'),credentialBytes=await readPrivateCredentialFile(credentialPath),metadata=nativeClaudeCredentialMetadata(credentialBytes),credentialValue=json(credentialBytes);
    let configBytes,identity;
    try{configBytes=await readPrivateCredentialFile(selected.path);identity=nativeClaudeConfigIdentity(configBytes);}catch(error){
      if(error.code==='ENOENT'&&allowLegacyTopLevelOrganization&&metadata.organizationHash){const path=await realpath(credentialPath),identityHash=hash(JSON.stringify(['claude','native:claude-default',metadata.organizationHash]));return {legacy:true,bytes:credentialBytes,metadata,accountSource:{path,sha256:metadata.sha256,bytes:credentialBytes.length,accountIdentityHash:identityHash,identityEvidence:'legacy-top-level-organization-compatibility-only'},source:{engine:'claude',accountRef:'native:claude-default',path,sha256:metadata.sha256,identityHash}};}
      if(error.code==='ENOENT')throw fail('WORK_NATIVE_ACCOUNT_IDENTITY_REQUIRED','The selected native account configuration is missing');throw error;
    }
    if(metadata.organizationHash&&metadata.organizationHash!==identity.organizationHash)throw fail('WORK_NATIVE_ACCOUNT_CHANGED','Native credential and account metadata conflict');
    if(credentialValue.accountUuid&&hash(String(credentialValue.accountUuid).toLowerCase())!==identity.accountHash)throw fail('WORK_NATIVE_ACCOUNT_CHANGED','Native credential and account metadata conflict');
    const path=await realpath(credentialPath),configPath=await realpath(selected.path),projection={version:2,resolverMode:selected.mode,credentialPath:path,identityConfigPath:configPath,credentialSha256:metadata.sha256,...identity},sourceFingerprint=hash(projection),rawSourceFiles=[{role:'credentials',path,bytes:credentialBytes.length,sha256:metadata.sha256},{role:'identity-config',path:configPath,bytes:configBytes.length,sha256:hash(configBytes),semanticSha256:hash({path:configPath,resolverMode:selected.mode,...identity})}];
    const accountSource={version:2,path,sha256:metadata.sha256,bytes:credentialBytes.length,accountIdentityHash:identity.identityHash,identityEvidence:'official-native-account-and-organization-v2',identityProjection:projection,sourceFingerprint,rawSourceFiles};
    return {bytes:credentialBytes,metadata,identity,accountSource,source:{version:2,engine:'claude',accountRef:'native:claude-default',path,sha256:metadata.sha256,identityHash:identity.identityHash,accountHash:identity.accountHash,organizationHash:identity.organizationHash,sourceFingerprint,identityProjection:projection,rawSourceFiles}};
  }
  function compare(actual,captured){
    if(actual.legacy){return captured?.sha256===actual.source.sha256&&samePath(captured.path,actual.source.path)&&(!captured.accountIdentityHash||captured.accountIdentityHash===actual.source.identityHash);}
    return captured?.version===2&&captured.sourceFingerprint===actual.source.sourceFingerprint&&captured.sha256===actual.source.sha256&&samePath(captured.path,actual.source.path)&&captured.accountIdentityHash===actual.source.identityHash;
  }
  async function verifiedProfile(bytes,identity){
    const value=json(bytes),token=value.claudeAiOauth?.accessToken;if(!token)throw fail('ENGINE_AUTH_PROFILE_REQUIRED','Native access credential is unavailable');
    const key=hash([hash(token),NATIVE_CLAUDE_PROFILE_ENDPOINT,identity.identityHash]),previous=profiles.get(key);
    if(previous&&previous.expiresAt>now())return structuredClone({...previous.proof,initialVerifiedCredentialSha256:previous.proof.initialVerifiedCredentialSha256??previous.proof.credentialSha256,credentialSha256:hash(bytes)});
    const proof=await profileVerifier({accessToken:token,credentialSha256:hash(bytes),expectedIdentity:{...identity},endpoint:NATIVE_CLAUDE_PROFILE_ENDPOINT});
    if(proof?.verified!==true||proof.endpoint!==NATIVE_CLAUDE_PROFILE_ENDPOINT||['identityHash','accountHash','organizationHash'].some(k=>proof[k]!==identity[k]))throw fail('WORK_NATIVE_ACCOUNT_CHANGED','Authenticated native identity does not match the selected account metadata');
    const safe={version:1,endpoint:NATIVE_CLAUDE_PROFILE_ENDPOINT,credentialSha256:hash(bytes),accessTokenHash:hash(token),identityHash:identity.identityHash,verifiedAt:proof.verifiedAt??now(),responseSha256:proof.responseSha256??null,httpStatus:proof.httpStatus??null,tlsAuthorized:proof.tlsAuthorized??null,requestId:proof.requestId??null};
    profiles.set(key,{proof:safe,expiresAt:value.claudeAiOauth.expiresAt});return structuredClone(safe);
  }
  async function readSource({captured=null,strict=false,trustCapturedProof=false}={}){
    const first=await local();if(strict&&(!captured?.sha256||!captured.path))throw fail('WORK_NATIVE_ACCOUNT_PROVENANCE_REQUIRED','Native custody requires an explicitly captured account source');
    const changed=!!captured&&!compare(first,captured);if(strict&&changed)throw fail('WORK_NATIVE_ACCOUNT_CHANGED','The selected native account source changed; capture it again');
    if(!first.legacy){const prior=captured?.profileVerification,canReuse=strict&&trustCapturedProof&&!changed&&prior?.endpoint===NATIVE_CLAUDE_PROFILE_ENDPOINT&&prior.credentialSha256===first.source.sha256&&prior.identityHash===first.identity.identityHash;
      const proof=canReuse?prior:await verifiedProfile(first.bytes,first.identity),second=await local();
      if(!compare(second,first.accountSource))throw fail('WORK_NATIVE_ACCOUNT_CHANGED','Native source identity changed during capture');
      second.accountSource.profileVerification=proof;second.source.profileVerification=proof;return {...second,changed};
    }
    return {...first,changed};
  }
  async function verifyCapturedSource(captured){const actual=await local();if(!compare(actual,captured))throw fail('WORK_NATIVE_ACCOUNT_CHANGED','The selected native account source changed after capture');return {verified:true,sourceFingerprint:actual.source.sourceFingerprint??null,rawSourceFiles:actual.accountSource.rawSourceFiles??null};}
  async function verifyRefreshedCredential({source,credentialBytes,profileRoot}){
    const captured={...source,accountIdentityHash:source.identityHash},before=await local();if(!compare(before,captured))throw fail('WORK_NATIVE_ACCOUNT_CHANGED','Selected native source changed during refresh');
    const selected=await nativeClaudeConfigPath({env:{CLAUDE_CONFIG_DIR:profileRoot},home}),privateConfig=await readPrivateCredentialFile(selected.path),identity=nativeClaudeConfigIdentity(privateConfig);
    if(identity.identityHash!==source.identityHash)throw fail('WORK_NATIVE_ACCOUNT_CHANGED','Native private refresh metadata changed the selected account');
    const proof=await verifiedProfile(credentialBytes,identity),after=await local(),again=nativeClaudeConfigIdentity(await readPrivateCredentialFile(selected.path));
    if(!compare(after,captured)||again.identityHash!==identity.identityHash)throw fail('WORK_NATIVE_ACCOUNT_CHANGED','Native source identity changed while refresh was verified');
    return {verified:true,identityHash:identity.identityHash,profileVerification:proof};
  }
  return {readSource,verifyCapturedSource,verifyRefreshedCredential,cacheSnapshot:()=>({entries:profiles.size})};
}
