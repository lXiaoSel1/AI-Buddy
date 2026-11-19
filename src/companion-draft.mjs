import {current,isDraft} from 'immer';

function detach(value,seen=new Map()){
  if(!value||typeof value!=='object')return value;
  if(seen.has(value))return seen.get(value);
  const source=isDraft(value)?current(value):value;
  const prototype=Object.getPrototypeOf(source);
  if(!Array.isArray(source)&&prototype!==Object.prototype&&prototype!==null)return source;
  const result=Array.isArray(source)?[]:{};
  seen.set(value,result);
  for(const [key,child] of Object.entries(source))Object.defineProperty(result,key,{
    value:detach(child,seen),enumerable:true,writable:true,configurable:true
  });
  if(Array.isArray(source))result.length=source.length;
  return result;
}

export function copyCompanionValue(value){
  if(isDraft(value))return structuredClone(current(value));
  try{return structuredClone(value);}
  catch(error){
    if(error.name!=='DataCloneError')throw error;
    return structuredClone(detach(value));
  }
}
