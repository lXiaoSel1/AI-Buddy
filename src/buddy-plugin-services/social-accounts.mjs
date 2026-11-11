import {DatabaseSync} from 'node:sqlite';
import {lstatSync,mkdirSync,statSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {checkR95DatabaseCompatibility} from '../r95-data-compatibility.mjs';
import {SOCIAL_ACCOUNTS_DATABASE,SOCIAL_STORAGE_UNAVAILABLE} from './social-contract.mjs';

const error=(code,message=code)=>Object.assign(Error(message),{code});
const plugins=Object.freeze({'@ai-buddy/bilibili-companion':'bilibili','@ai-buddy/qq-connect':'qq'});
const clean=value=>typeof value==='string'&&value.length<=300&&!/[\x00-\x1f]/.test(value)&&value.trim();
const accountWriter='r95-social-accounts-v1';

export class SocialAccountStorageError extends Error{
  constructor(stage,cause){
    super(cause?.message??'Social account storage is unavailable',{cause});
    this.code=SOCIAL_STORAGE_UNAVAILABLE;
    this.database=SOCIAL_ACCOUNTS_DATABASE;
    this.stage=stage;
  }
}

function accountFileEntry(path){
  try{return lstatSync(path);}catch(cause){if(cause.code!=='ENOENT')throw cause;return null;}
}

function inspectAccountFile(path){
  const entry=accountFileEntry(path);
  if(entry){
    const target=entry.isSymbolicLink()?statSync(path):entry;
    if(!target.isFile())throw error('SOCIAL_ACCOUNT_FILE_INVALID','Social account storage path is not a regular file');
    return true;
  }
  if(accountFileEntry(path+'-wal')||accountFileEntry(path+'-shm'))throw error('SOCIAL_ACCOUNT_MAIN_FILE_MISSING','Social account database is missing but its WAL or SHM remains');
  return false;
}

function checkStoredAccounts(db,hasSchemaMarker){
  const entry=db.prepare("SELECT type FROM sqlite_master WHERE name='accounts' COLLATE NOCASE AND type IN ('table','view')").get();
  const schemaError=()=>error('SOCIAL_ACCOUNT_SCHEMA_INVALID','The saved social account table has an invalid schema');
  if(!entry){
    if(hasSchemaMarker)throw schemaError();
    return;
  }
  if(entry.type!=='table')throw schemaError();
  const columns=db.prepare('PRAGMA table_info(accounts)').all();
  const expected=['ref','body','secret'];
  if(columns.length!==expected.length||columns.some((column,index)=>column.name.toLowerCase()!==expected[index]||column.pk!==Number(index===0)))throw schemaError();
  const invalid=db.prepare(`
    SELECT 1 FROM accounts
    WHERE CASE WHEN typeof(body)='text' AND json_valid(body) THEN json_type(body)<>'object' ELSE 1 END
    LIMIT 1
  `).get();
  if(invalid)throw error('SOCIAL_ACCOUNT_BODY_INVALID','The social account database contains an invalid saved account');
}

function openAccountDatabase(dataRoot){
  const path=join(dataRoot,SOCIAL_ACCOUNTS_DATABASE);
  let stage='inspect',db;
  try{
    if(inspectAccountFile(path)){
      stage='readonly-open';
      db=new DatabaseSync(path,{readOnly:true});
      const compatibility=checkR95DatabaseCompatibility(db,{writer:accountWriter,onStage:value=>{stage=value;}});
      const hasLegacyMetadata=db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='metadata'").get();
      const legacyVersion=hasLegacyMetadata?db.prepare("SELECT value FROM metadata WHERE key='schemaVersion'").get()?.value:undefined;
      if(hasLegacyMetadata&&legacyVersion!=='1')throw error('SOCIAL_ACCOUNT_SCHEMA_UNSUPPORTED');
      checkStoredAccounts(db,compatibility.schema===1||legacyVersion==='1');
      stage='readonly-close';
      db.close();
      db=undefined;
      stage='inspect';
      if(!inspectAccountFile(path))throw error('SOCIAL_ACCOUNT_MAIN_FILE_MISSING','Social account database disappeared during startup');
    }
    stage='writer-open';
    mkdirSync(dirname(path),{recursive:true});
    db=new DatabaseSync(path);
    stage='initialize';
    db.exec('PRAGMA synchronous=FULL; BEGIN IMMEDIATE;');
    db.exec(`CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT); INSERT OR IGNORE INTO meta VALUES('schemaVersion','1'); INSERT OR IGNORE INTO meta VALUES('minimumWriter','"${accountWriter}"');`);
    db.exec("CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL); INSERT OR IGNORE INTO metadata VALUES('schemaVersion','1'); CREATE TABLE IF NOT EXISTS accounts(ref TEXT PRIMARY KEY,body TEXT NOT NULL,secret BLOB);");
    if(db.prepare("SELECT value FROM metadata WHERE key='schemaVersion'").get()?.value!=='1')throw error('SOCIAL_ACCOUNT_SCHEMA_UNSUPPORTED');
    db.exec('COMMIT');
    stage='writer-configure';
    db.exec('PRAGMA journal_mode=WAL;');
    return db;
  }catch(cause){
    try{db?.close();}catch{/* Keep the original storage error if cleanup also fails. */}
    throw new SocialAccountStorageError(stage,cause);
  }
}

export function localEndpoint(value,schemes){
  let url;try{url=new URL(value);}catch{throw error('SOCIAL_ENDPOINT_INVALID');}
  if(!schemes.includes(url.protocol)||!['127.0.0.1','[::1]','localhost'].includes(url.hostname)||url.username||url.password||url.search||url.hash)throw error('SOCIAL_ENDPOINT_DENIED','QQ connection must use an explicitly configured local endpoint');
  return url.href;
}
/** Account credentials are written only by the trusted APP entry. Plugins see
 * opaque references and labels; no password, cookie or secret reaches DSH. */
export function createSocialAccounts({dataRoot,crypto}={}){
  const db=openAccountDatabase(dataRoot);
  const listeners=new Set();let closed=false,closeError;
  const check=()=>{if(closed)throw error('SOCIAL_ACCOUNTS_CLOSED');};
  function list(){check();return db.prepare('SELECT body FROM accounts ORDER BY ref').all().map(row=>JSON.parse(row.body));}
  function get(ref){check();const row=db.prepare('SELECT body FROM accounts WHERE ref=?').get(ref);return row?JSON.parse(row.body):null;}
  function forPlugin(packageName){const matches=list().filter(a=>a.pluginId===packageName&&a.enabled);if(matches.length!==1)throw error('SOCIAL_ACCOUNT_REQUIRED','Configure one managed account for this plugin in the APP');return matches[0];}
  function secret(ref){check();const row=db.prepare('SELECT secret FROM accounts WHERE ref=?').get(ref);if(!row)throw error('SOCIAL_ACCOUNT_REQUIRED');if(!row.secret)return {};
    if(!crypto?.isEncryptionAvailable?.())throw error('SOCIAL_ACCOUNT_CRYPTO_REQUIRED');return JSON.parse(crypto.decryptString(Buffer.from(row.secret)));
  }
  function save(input,{notify=true}={}){
    check();if(!input||!plugins[input.pluginId]||!clean(input.accountId)||!clean(input.label))throw error('SOCIAL_ACCOUNT_INVALID');
    const old=input.ref?get(input.ref):null;if(input.ref&&!old)throw error('SOCIAL_ACCOUNT_UNKNOWN');
    if(old&&old.pluginId!==input.pluginId)throw error('SOCIAL_ACCOUNT_PLUGIN_CHANGED');
    const platform=plugins[input.pluginId],ref=old?.ref??'social-'+randomUUID(),generation=(old?.generation??0)+1;
    if(input.enabled!==false&&list().some(a=>a.ref!==ref&&a.pluginId===input.pluginId&&a.enabled))throw error('SOCIAL_ACCOUNT_ALREADY_ACTIVE','Disable the existing managed account before changing accounts');
    const body={ref,pluginId:input.pluginId,platform,accountId:input.accountId,label:input.label,enabled:input.enabled!==false,generation,...input.activityApprovalRequired===true?{activityApprovalRequired:true}:{}};
    if(old?.accountId===input.accountId){if(old.managedProfileId)body.managedProfileId=old.managedProfileId;if(old.avatar)body.avatar=old.avatar;}
    if(platform==='qq'){body.httpUrl=localEndpoint(input.httpUrl??old?.httpUrl,['http:','https:']);body.webSocketUrl=localEndpoint(input.webSocketUrl??old?.webSocketUrl,['ws:','wss:']);}
    let ciphertext=old?db.prepare('SELECT secret FROM accounts WHERE ref=?').get(ref).secret:null;
    if(input.secret!==undefined){
      if(!crypto?.isEncryptionAvailable?.())throw error('SOCIAL_ACCOUNT_CRYPTO_REQUIRED','The OS credential store is unavailable');
      const value=input.secret;if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!(platform==='qq'?['accessToken']:['cookie']).includes(k))||Object.values(value).some(v=>typeof v!=='string'||v.length>32768||/[\r\n\0]/.test(v)))throw error('SOCIAL_SECRET_INVALID');
      ciphertext=crypto.encryptString(JSON.stringify(value));
    }
    db.prepare('INSERT INTO accounts VALUES(?,?,?) ON CONFLICT(ref) DO UPDATE SET body=excluded.body,secret=excluded.secret').run(ref,JSON.stringify(body),ciphertext);
    if(notify)for(const listener of listeners)listener({ref,generation});return body;
  }
  function commitLogin(input,{requireConfirmation=true}={}){
    check();if(!input?.secret)throw error('SOCIAL_LOGIN_PROOF_REQUIRED');
    const matches=list().filter(a=>a.pluginId===input.pluginId),same=matches.find(a=>a.accountId===input.accountId);
    const changed=[];let result;
    db.exec('BEGIN IMMEDIATE');
    try{
      for(const old of matches)if(old.enabled&&old.ref!==same?.ref){const next={...old,enabled:false,generation:old.generation+1};db.prepare('UPDATE accounts SET body=? WHERE ref=?').run(JSON.stringify(next),old.ref);changed.push(next);}
      result=save({...input,ref:same?.ref,enabled:true,activityApprovalRequired:requireConfirmation},{notify:false});
      // The native profile and its encrypted credentials commit in the same
      // transaction. A crash cannot leave an account pointing to another profile.
      if(input.resourceId!==undefined){if(result.platform!=='qq'||!/^[a-f0-9]{8}-[a-f0-9-]{27}$/.test(input.resourceId))throw error('QQ_PRIVATE_PROFILE_REQUIRED');result.managedProfileId=input.resourceId;}
      if(typeof input.avatar==='string'&&/^https:\/\/(?:[a-z0-9-]+\.)*(?:hdslb\.com|qlogo\.cn)\//i.test(input.avatar)&&input.avatar.length<2048)result.avatar=input.avatar;
      db.prepare('UPDATE accounts SET body=? WHERE ref=?').run(JSON.stringify(result),result.ref);changed.push(result);db.exec('COMMIT');
    }catch(cause){db.exec('ROLLBACK');throw cause;}
    for(const row of changed)for(const listener of listeners)listener({ref:row.ref,generation:row.generation});
    return result;
  }
  function remove(ref){check();const row=get(ref);if(!row)throw error('SOCIAL_ACCOUNT_UNKNOWN');db.prepare('DELETE FROM accounts WHERE ref=?').run(ref);for(const listener of listeners)listener({ref,generation:row.generation+1});return {removed:true};}
  function approveActivities(ref){check();const row=get(ref);if(!row?.enabled)throw error('SOCIAL_ACCOUNT_UNKNOWN');db.prepare('UPDATE accounts SET body=? WHERE ref=?').run(JSON.stringify({...row,activityApprovalRequired:false}),ref);return {approved:true};}
  function subscribe(listener){listeners.add(listener);return()=>listeners.delete(listener);}
  return {list,get,forPlugin,secret,save,commitLogin,remove,approveActivities,subscribe,close(){if(closeError)throw closeError;if(closed)return;closed=true;listeners.clear();try{db.close();}catch(error){closeError=error;throw error;}}};
}
