import {mkdir,readFile,readdir,rm,stat} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {resolve,relative,isAbsolute,join,sep} from 'node:path';
import {assertPluginTreeNoLinks} from './plugin-archive.mjs';
import {renamePluginPath} from './plugin-files.mjs';
import {writeAtomic} from './atomic-write.mjs';

function owned(control,path){const value=resolve(control,path),rel=relative(control,value);if(!rel||isAbsolute(rel)||rel==='..'||rel.startsWith('..'+sep))throw Error('Quarantine path escaped plugin storage');return value;}
const exists=async path=>{try{await stat(path);return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}};
export async function pluginTrashPending(control){try{return (await readdir(join(control,'trash'))).some(name=>/^[a-f0-9-]{36}\.json$/.test(name));}catch(error){if(error.code==='ENOENT')return false;throw error;}}
async function referenced(control){const paths=new Set();for(const name of ['registry.json','registry-v2.json'])try{const value=JSON.parse(await readFile(join(control,name),'utf8'));for(const row of Object.values(value.packages??{}))for(const saved of Object.values(row.versions??{}))paths.add(saved.directory);}catch(error){if(error.code!=='ENOENT')throw error;}return paths;}
async function finish(control,journal,file){const live=await referenced(control);for(const[index,entry]of journal.entries.entries()){if(typeof entry.from!=='string'||!entry.from.startsWith('packages/')||typeof entry.to!=='string'||entry.to!=='trash/'+journal.id+'/'+index||entry.from.includes('\\')||entry.from.split('/').some(part=>!part||part==='.'||part==='..'))throw Error('Invalid plugin quarantine record');const from=owned(control,entry.from),to=owned(control,entry.to);await assertPluginTreeNoLinks(from);await assertPluginTreeNoLinks(to);if(live.has(entry.from)){if(await exists(to)){if(await exists(from))throw Error('Both original and quarantined plugin directories exist; retained for inspection');await mkdir(resolve(from,'..'),{recursive:true});await renamePluginPath(to,from);}}else await rm(to,{recursive:true,force:true});}await rm(owned(control,'trash/'+journal.id),{recursive:true,force:true});await rm(file,{force:true});}
export async function recoverPluginTrash(control){if(!await pluginTrashPending(control))return;for(const name of await readdir(join(control,'trash')))if(/^[a-f0-9-]{36}\.json$/.test(name)){const file=join(control,'trash',name);await assertPluginTreeNoLinks(file);const journal=JSON.parse(await readFile(file,'utf8'));if(journal.schemaVersion!==1||journal.id+'.json'!==name||!Array.isArray(journal.entries))throw Error('Invalid plugin quarantine journal');await finish(control,journal,file);}}
export async function quarantinePluginDirectories(control,directories,commit){
 const id=randomUUID(),file=join(control,'trash',id+'.json'),entries=[...new Set(directories)].map((from,index)=>({from,to:'trash/'+id+'/'+index}));
 const journal={schemaVersion:1,id,entries};await mkdir(join(control,'trash',id),{recursive:true});writeAtomic(file,JSON.stringify(journal));
 try{for(const entry of entries){if(!entry.from.startsWith('packages/'))throw Error('Only immutable package directories can be quarantined');const from=owned(control,entry.from),to=owned(control,entry.to);await assertPluginTreeNoLinks(from);if(await exists(from))await renamePluginPath(from,to);}await commit();}
 catch(error){try{await finish(control,journal,file);}catch(recovery){throw new AggregateError([error,recovery],'Plugin uninstall retained quarantined files for recovery');}throw error;}
 // A cleanup failure cannot resurrect the removed registration. Startup resumes this exact quarantine.
 try{await finish(control,journal,file);}catch{};
}
