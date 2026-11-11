import {DatabaseSync} from 'node:sqlite';
import {existsSync} from 'node:fs';

const decoded=value=>{try{return JSON.parse(value);}catch{return value;}};
export function checkR95DatabaseCompatibility(db,{schemaKey='schemaVersion',versions=[1],writer,onStage}={}){
 onStage?.('user-version');
 const version=db.prepare('PRAGMA user_version').get().user_version;
 onStage?.('schema-check');
 if(version>1)throw Error('Unsupported R95 database user version');
 if(!db.prepare("SELECT 1 FROM sqlite_master WHERE name='meta' AND type='table'").get())return {exists:true,legacy:true};
 const get=key=>db.prepare('SELECT value FROM meta WHERE key=?').get(key)?.value,schema=get(schemaKey),minimum=get('minimumWriter');
 if(schema!==undefined&&!versions.includes(decoded(schema)))throw Error('Unsupported R95 database schema');
 if(minimum!==undefined&&decoded(minimum)!==writer)throw Error('Unsupported R95 minimum writer');
 return {exists:true,schema:schema===undefined?null:decoded(schema)};
}
/** Read-only before opening a writer. Never down-stamp an unknown schema/writer. */
export function assertR95DatabaseCompatible(path,options){
 if(!existsSync(path))return {exists:false};
 const db=new DatabaseSync(path,{readOnly:true});
 try{return checkR95DatabaseCompatibility(db,options);}finally{db.close();}
}
export function assertR95CompanionCompatible(state){
 if(!state||![1,2].includes(state.schema))throw Error('不支持的角色／身份存档版本');
 if(state.minimumWriter!==undefined&&state.minimumWriter!=='r95-social-core-v1')throw Error('此存档需要更新的写入程序，资料保持不变');
 if(state.requiredCapabilities?.some(value=>!['social-core-state-v1','work-task-evidence-v1'].includes(value)))throw Error('角色存档含未支持的新能力，资料保持不变');
 return true;
}
