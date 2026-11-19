import {DatabaseSync} from 'node:sqlite';

export function observeEconomyRelease(observe){
 const exec=DatabaseSync.prototype.exec,depth=new WeakMap();
 DatabaseSync.prototype.exec=function(sql,...args){
  const level=depth.get(this)??0;
  if(sql.startsWith('SAVEPOINT economy_')){
   const result=exec.call(this,sql,...args);
   depth.set(this,level+1);
   return result;
  }
  if(sql.startsWith('RELEASE economy_')){
   if(level===1)observe('before');
   const result=exec.call(this,sql,...args);
   depth.set(this,level-1);
   if(level===1)observe('after');
   return result;
  }
  if(sql.startsWith('ROLLBACK TO economy_')){
   const result=exec.call(this,sql,...args);
   depth.set(this,level-1);
   return result;
  }
  return exec.call(this,sql,...args);
 };
 return ()=>{DatabaseSync.prototype.exec=exec;};
}

export function block(ms){Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,ms);}
