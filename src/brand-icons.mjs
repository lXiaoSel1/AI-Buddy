// Panel, taskbar and tray icons follow the current desktop pet: the round head crops in
// assets/theme/<id>/ (PNG, because nativeImage cannot read WebP). Missing files fall back to the app icon.
import {nativeImage} from 'electron';
import {existsSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {themeAsset,THEMES} from './appearance.mjs';
import {petCharacterName} from './pet-characters.mjs';

const cache=new Map();
export function brandIcons(root,id){
 if(cache.has(id))return cache.get(id);
 const file=name=>join(root,themeAsset(id,name));
 let icons=null;
 if(['icon-256.png','tray-16.png','tray-24.png','tray-32.png'].every(name=>existsSync(file(name)))){
  const tray=nativeImage.createEmpty();
  for(const [size,scaleFactor] of [[16,1],[24,1.5],[32,2]])tray.addRepresentation({scaleFactor,buffer:readFileSync(file(`tray-${size}.png`))});
  icons={window:nativeImage.createFromPath(file('icon-256.png')),tray};
 }
 cache.set(id,icons);return icons;
}
export const brandTooltip=(id,language)=>language==='en'?`AI Buddy · ${THEMES[id]?.nameEn||petCharacterName(id)} is with you`:`AI 酱 · ${petCharacterName(id)} 陪着你`;
