// Preparing a target never interrupts the current feedback or clears its queue.
export class PetCharacterSwitch{
 constructor({current='deepseek',prepare,commit,onPrepared=()=>{},onError=()=>{}}){Object.assign(this,{current,target:current,prepare,commit,onPrepared,onError});this.ticket=0;this.prepared=null;this.loading=false;this.failed=false;}
 request(id){
  if(id===this.target&&!this.failed)return;
  this.target=id;this.failed=false;const ticket=++this.ticket;this.prepared?.dispose?.();this.prepared=null;
  if(id===this.current){this.loading=false;return;}
  this.loading=true;
  Promise.resolve().then(()=>this.prepare(id)).then(value=>{if(ticket!==this.ticket){value.dispose?.();return;}this.prepared=value;this.loading=false;this.onPrepared();}).catch(error=>{if(ticket!==this.ticket)return;this.loading=false;this.failed=true;this.target=this.current;this.onError(error);});
 }
 advance({busy=false}={}){
  if(busy||!this.prepared)return false;
  const next=this.prepared;this.prepared=null;this.commit(this.target,next);this.current=this.target;return true;
 }
 dispose(){this.ticket++;this.prepared?.dispose?.();this.prepared=null;}
}
