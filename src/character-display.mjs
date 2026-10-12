// Persistent character-owned presentation; legacy root fields are migrated once.
export function migrateCharacterDisplay(state){
 if(!state?.characters)return false;
 // The engine exposes character proxies with synthetic property descriptors.
 // An undefined value, not hasOwn(), is the reliable legacy-field check here.
 const entries=Object.entries(state.characters),pending=entries.filter(([,c])=>c.backgroundOverride===undefined);
 if(!pending.length)return false;
 const legacy=state.bg,owner=typeof legacy==='string'&&legacy.startsWith('cg:')?entries.find(([,c])=>c.cgs?.some(g=>g.id===legacy.slice(3)))?.[0]:state.current;
 for(const [id,c]of pending){c.backgroundOverride=id===owner&&typeof legacy==='string'?legacy:null;c.backgroundName=id===owner?String(state.preferences?.customBgName||''):'';c.spriteVisibility=['show','hide'].includes(c.spriteVisibility)?c.spriteVisibility:'auto';}
 state.bg=null;if(state.preferences)state.preferences.customBgName='';return true;
}
export function characterBackground(state,id=state.current){migrateCharacterDisplay(state);return state.characters?.[id]?.backgroundOverride??null;}
export function setCharacterBackground(state,value,id=state.current,name=''){
 migrateCharacterDisplay(state);const c=state.characters?.[id];if(!c)throw Error('Unknown character');
 c.backgroundOverride=value;c.backgroundName=name;
 for(const cg of c.cgs||[])cg.savedAsBg=value==='cg:'+cg.id;
}
export function isSpriteVisible(mode='auto',backgroundMode='builtin',autoHide=true){return mode==='show'||(mode!=='hide'&&!(backgroundMode==='cg'&&autoHide));}
