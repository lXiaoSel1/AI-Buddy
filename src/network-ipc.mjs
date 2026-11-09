export function createNetworkActions({getNetwork,isTrusted,onSaved=()=>{}}){
 return async function invoke(event,operation,value){
  if(!isTrusted(event))throw Error('Invalid network settings sender');
  const network=getNetwork();if(!network)throw Error('Network settings are not ready');
  if(operation==='get')return network.snapshot();
  if(operation==='test')return network.test();
  if(operation==='save'){const saved=await network.save(value);await onSaved(saved);return saved;}
  throw Error('Invalid network settings operation');
 };
}
