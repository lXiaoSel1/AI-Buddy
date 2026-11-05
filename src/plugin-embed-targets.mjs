// Which plugin pages can sit inside the main window (approved design G). Shared by the main process
// (plugin-embed.mjs) and the window's own page, so it imports nothing from Node or Electron.
export const EMBED_TARGETS=Object.freeze({
  bilibili:Object.freeze({kind:'community',packageName:'@ai-buddy/bilibili-companion',page:'plugin-bilibili',icon:'tv'}),
  qq:Object.freeze({kind:'community',packageName:'@ai-buddy/qq-connect',page:'plugin-qq',icon:'chats'}),
  'card-games':Object.freeze({kind:'community',packageName:'@ai-buddy/card-games',page:'plugin-card-games',icon:'nav-card-games'}),
  work:Object.freeze({kind:'work',packageName:'@ai-buddy/work-collaboration',page:'agent-tasks',icon:'nav-work'})});
/** G1: the sidebar's 插件 group, from what is installed: enabled community plugins with their own page (an embed target, or
 * one that declares ui.registerPage). Embed targets first in their own order (Bilibili, QQ), then the rest by name.
 * Returns [pageId, icon, record]; pages that cannot sit in the main window get an "ext:<packageKey>" id (own window). */
export function pluginPageEntries(records=[],nameOf=record=>record.packageName){
  const pageTarget=record=>EMBED_TARGETS[embedTargetFor(record.packageName)];
  const order=Object.keys(EMBED_TARGETS),rank=record=>{const i=order.indexOf(embedTargetFor(record.packageName));return i<0?order.length:i;};
  return records.filter(record=>record?.enabled===true&&typeof record.packageName==='string'&&(pageTarget(record)&&pageTarget(record).kind!=='work'||!embedTargetFor(record.packageName)&&record.backend!=='legacy'&&(record.declaredCapabilities??[]).includes('ui.registerPage')))
    .sort((a,b)=>rank(a)-rank(b)||String(nameOf(a)).localeCompare(String(nameOf(b))))
    .map(record=>{const target=embedTargetFor(record.packageName);return target?[EMBED_TARGETS[target].page,EMBED_TARGETS[target].icon,record]:['ext:'+record.packageKey,'nav-plugins',record];});
}
export const embedTargetFor=packageName=>Object.keys(EMBED_TARGETS).find(key=>EMBED_TARGETS[key].packageName===packageName)??null;
// The bundled card package owns a private DSH runtime; the official package uses the community runtime.
export const embedSlotKind=(target,record)=>target==='card-games'&&record?.localBundled===true?'card':EMBED_TARGETS[target].kind;
// Community plugins share one DSH page that opens on DSH's own panel; only plugin code can switch it. The host names the
// plugin on <html> (data-buddy-open-plugin) and fires "ai-buddy:open-plugin-page"; the plugin answers with data-buddy-panel.
// Both scripts answer "<data-buddy-embedded>|<data-buddy-panel>". Used for the main window and for separate windows.
export const PANEL_PLUGIN=/^@[a-z0-9][a-z0-9-]{0,80}\/[a-z0-9][a-z0-9-]{0,80}$/;
export const panelScript=pluginId=>{if(!PANEL_PLUGIN.test(pluginId))throw TypeError('Invalid plugin page');return `(()=>{const r=document.documentElement,d=r.dataset,id=${JSON.stringify(pluginId)};d.buddyOpenPlugin=id;window.dispatchEvent(new CustomEvent('ai-buddy:open-plugin-page',{detail:{pluginId:id}}));return (d.buddyEmbedded||'')+'|'+(d.buddyPanel||'');})()`;};
export const PANEL_CHECK='(()=>{const d=document.documentElement.dataset;return (d.buddyEmbedded||"")+"|"+(d.buddyPanel||"");})()';
const version=value=>{const m=/^(\d+)\.(\d+)\.(\d+)(-.*)?$/.exec(String(value??''));return m?[+m[1],+m[2],+m[3],m[4]?0:1]:null;};
/** Community pages switch panel only from plugin code, which arrived in 2.0.1; older ones keep their own window. */
export function embedCapable(target,exactVersion){
  if(!Object.hasOwn(EMBED_TARGETS,target))return false;if(target==='work')return true;
  const v=version(exactVersion);if(!v)return false;
  for(const [i,min] of (target==='card-games'?[0,1,0,0]:[2,0,1,1]).entries()){if(v[i]!==min)return v[i]>min;}return true;
}
