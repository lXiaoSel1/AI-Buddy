import {createHash} from 'node:crypto';
import {readdirSync,readFileSync,rmSync} from 'node:fs';
import {basename,dirname,join} from 'node:path';
import {writeAtomic} from './atomic-write.mjs';

const UUID='[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const ownedName=new RegExp('^('+UUID+')\\.json(?:\\.'+UUID+'\\.partial)?$');

function restoreSourcePath(databasePath,id){
  if(!/^[a-f0-9-]{36}$/.test(id))throw Error('Invalid life restore transaction ID');
  return databasePath+'.life-restore-'+id+'.json';
}

export function writeLifeRestoreSource(path,id,target){
  const text=JSON.stringify(target);
  const source=restoreSourcePath(path,id);
  writeAtomic(source,text);
  return createHash('sha256').update(text).digest('hex');
}

export function readLifeRestoreSource(path,id,sha256){
  const bytes=readFileSync(restoreSourcePath(path,id));
  if(createHash('sha256').update(bytes).digest('hex')!==sha256)throw Error('Life restore source hash changed');
  return JSON.parse(bytes);
}

export function cleanOrphanLifeRestoreSources(path,activeId){
  const dir=dirname(path),prefix=basename(path)+'.life-restore-';
  for(const entry of readdirSync(dir,{withFileTypes:true})){
    if(!entry.isFile()||!entry.name.startsWith(prefix))continue;
    const owned=ownedName.exec(entry.name.slice(prefix.length));
    if(owned&&owned[1]!==activeId)rmSync(join(dir,entry.name),{force:true});
  }
}

export function removeLifeRestoreSource(path,id){
  rmSync(restoreSourcePath(path,id),{force:true});
}
