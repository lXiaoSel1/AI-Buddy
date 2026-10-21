import {mkdirSync,readFileSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {writeAtomic} from './atomic-write.mjs';

// B4: conversation drafts change every few hundred milliseconds while the user types,
// so they live in galgame/drafts.json instead of the companion store. Writes are
// atomic and at most one per delayMs; flush() writes what is pending.
export function createDraftStore(dataRoot,{delayMs=1000,onError=()=>{}}={}){
 const path=join(dataRoot,'galgame','drafts.json');let drafts={};
 try{const raw=JSON.parse(readFileSync(path,'utf8'));if(raw?.drafts&&typeof raw.drafts==='object'&&!Array.isArray(raw.drafts))drafts=raw.drafts;}catch(error){if(error.code!=='ENOENT')onError(error);}
 let timer=null,dirty=false;
 function write(){
  clearTimeout(timer);timer=null;if(!dirty)return;dirty=false;
  try{mkdirSync(dirname(path),{recursive:true});writeAtomic(path,JSON.stringify({version:1,drafts}));}
  catch(error){dirty=true;onError(error);}
 }
 return {
  path,
  get:id=>Object.hasOwn(drafts,id)?drafts[id]:undefined,
  set(id,text){if(Object.hasOwn(drafts,id)&&drafts[id]===text)return;drafts={...drafts,[id]:text};dirty=true;if(!timer){timer=setTimeout(write,delayMs);timer.unref?.();}},
  delete(id){if(!Object.hasOwn(drafts,id))return;const {[id]:_,...rest}=drafts;drafts=rest;dirty=true;if(!timer){timer=setTimeout(write,delayMs);timer.unref?.();}},
  entries:()=>Object.entries(drafts),
  clear(){drafts={};dirty=true;write();},
  flush:write,
 };
}
