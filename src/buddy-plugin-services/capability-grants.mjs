import {contextFailure,plain} from './trusted-context.mjs';
import {SOCIAL_CAPABILITIES} from './social-contract.mjs';

export const BUDDY_PLUGIN_CAPABILITIES=Object.freeze([...new Set(['characters.getContext','models.request','memory.appendEvent','usage.record','notifications.publish','ui.registerPage','lifecycle.register','archive.read','archive.restore','tools.list','tools.invoke','work.host',...SOCIAL_CAPABILITIES])]);
const capabilities=new Set(BUDDY_PLUGIN_CAPABILITIES);
function list(value,name){if(!Array.isArray(value)||value.some(v=>typeof v!=='string'||!capabilities.has(v)))throw contextFailure('Invalid '+name,'BUDDY_GRANT_INVALID');return [...new Set(value)];}
/** A declaration alone never grants a capability. The context can narrow a host grant again. */
export function createCapabilityGrantRegistry({now=Date.now}={}){
  const rows=new Map();let closed=false;
  function set(spec){
    if(closed||!plain(spec)||typeof spec.pluginId!=='string'||!spec.pluginId||spec.pluginId.length>300)throw contextFailure('Invalid plugin grant','BUDDY_GRANT_INVALID');
    const declared=list(spec.declared,'declared capabilities'),granted=list(spec.granted,'granted capabilities'),old=rows.get(spec.pluginId),expiresAt=spec.expiresAt??null;
    if(expiresAt!=null&&(!Number.isFinite(expiresAt)||expiresAt<=now()))throw contextFailure('Grant expiration must be in the future','BUDDY_GRANT_INVALID');
    const generation=spec.generation??((old?.generation??0)+1);if(!Number.isSafeInteger(generation)||generation<1||old&&generation<=old.generation)throw contextFailure('Grant generation must increase','BUDDY_GRANT_INVALID');
    const row={pluginId:spec.pluginId,declared,granted,enabled:spec.enabled!==false,expiresAt,generation};rows.set(spec.pluginId,row);return structuredClone(row);
  }
  function require(pluginId,capability,context){
    const row=rows.get(pluginId);if(closed||!row?.enabled)throw contextFailure('Plugin is not enabled','BUDDY_PLUGIN_DISABLED');
    if(row.expiresAt!=null&&now()>=row.expiresAt)throw contextFailure('Plugin capability grant expired','BUDDY_GRANT_EXPIRED');
    if(!row.declared.includes(capability)||!row.granted.includes(capability)||!context.permissionScope.includes(capability))throw contextFailure('Plugin capability not granted: '+capability,'BUDDY_CAPABILITY_DENIED');
    return row.generation;
  }
  function assertGeneration(pluginId,generation){const row=rows.get(pluginId);if(closed||!row?.enabled||row.generation!==generation||row.expiresAt!=null&&now()>=row.expiresAt)throw contextFailure('Plugin activation changed','BUDDY_PLUGIN_DISABLED');}
  return {set,require,assertGeneration,get:id=>structuredClone(rows.get(id)??null),revoke(id){const row=rows.get(id);if(row)rows.set(id,{...row,enabled:false,generation:row.generation+1});},close(){closed=true;rows.clear();}};
}
