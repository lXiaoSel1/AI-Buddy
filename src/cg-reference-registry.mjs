import {join} from 'node:path';
import {existsSync} from 'node:fs';
import {CHARACTER_CATALOG,CHARACTER_ART} from './character-catalog.mjs';
import {cgProtocol,arkReferenceLimit} from './cg-presets.mjs';
// CG identity follows the Galgame portrait key, never the desktop pet master.
// Electron nativeImage cannot decode the legacy WebP. The PNG is a verified,
// pixel-identical conversion of that portrait, not a different character asset.
const PORTRAIT_ART=Object.freeze({'maid-left':'assets/cg-references/maid-left.png',...Object.fromEntries(Object.values(CHARACTER_CATALOG).map(c=>[c.sprite,c.assets.portrait]))});
const DEFAULT_PORTRAIT_KEYS=Object.freeze({deepseek:'maid-left',...Object.fromEntries(Object.values(CHARACTER_CATALOG).map(c=>[c.id,c.sprite]))});
export function createCharacterReferenceResolver(build,readAsset){
 const dataReference=value=>{if(typeof value!=='string'||!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=\s]+$/.test(value))throw Error('参考图片数据无效');return {buffer:Buffer.from(value.split(',')[1],'base64')};};
 return async(characters,scene=null)=>{
  const references=characters.flatMap(character=>{
   if(character.customCharacter===true&&character.referenceMode==='text-only'&&!character.dataUrl)return [];
   let source;
   // Connection test jobs and older jobs may carry only a registered character ID.
   // An explicit custom/legacy key must never be silently replaced by a default.
   const spriteKey=character.spriteKey||(!character.customCharacter&&Object.hasOwn(DEFAULT_PORTRAIT_KEYS,character.id)?DEFAULT_PORTRAIT_KEYS[character.id]:null);
   if(character.dataUrl)source=dataReference(character.dataUrl);
   else if(spriteKey&&Object.hasOwn(PORTRAIT_ART,spriteKey))source={path:join(build,PORTRAIT_ART[spriteKey])};
   else {const key=String(spriteKey||'');if(!/^[a-zA-Z0-9_-]+$/.test(key))throw Error('角色参考图不存在：'+(character.name||character.id||'未知角色')+'（缺少已登记的立绘或自定义参考图）');source={path:join(build,'assets/cg-references',key+'.webp')};}
   if(source.path&&!existsSync(source.path))throw Error('角色参考图不存在：'+(character.name||character.id));
   return [{...source,role:'character',characterId:character.id,name:character.name||character.id,resourceVersion:character.resourceVersion||null}];
  });
  let environment=null;
  if(scene?.dataUrl)environment=dataReference(scene.dataUrl);
  else if(scene?.assetRef&&readAsset)environment=dataReference(readAsset(scene.assetRef));
  else if(scene?.key&&CHARACTER_ART[scene.key])environment={path:join(build,CHARACTER_ART[scene.key])};
  if(environment){if(environment.path&&!existsSync(environment.path))throw Error('场景参考图不存在');references.push({...environment,role:'environment',name:scene.description,ignoreCharacters:true});}
  return references;
 };
}
export function referenceInstructions(references=[]){
 if(!references.length)return '本次为纯文生图，未使用人物参考。';
 return [references.some(row=>row.role==='character')?'参考图按附图顺序绑定，禁止交换人物身份：':'本次未使用人物参考；只按角色文字描述作画，以下附图仅提供环境线索：',...references.map((r,i)=>r.role==='environment'
  ? `图 ${i+1} 仅作环境线索：只借鉴空间、光线和材质，忽略图中所有人物、人体、雕像和人像；不能把它们加入新画面，也不要求复制场景。`
  : `图 ${i+1} 是角色 ${r.name||r.characterId||i+1} 的身份参考；保持脸、头发、服饰、原有字母与标志和实际附肢，允许改变动作、表情、视角与持物。允许出现文字，原有标识属于人物外观的一部分。`)].join('\n');
}
export function fitReferences(profile,references){
 if(profile.options?.references===false||profile.protocol?.startsWith('wan-t2i'))return [];
 const limit=profile.protocol==='wan-image'?4:cgProtocol(profile)==='ark-images'?arkReferenceLimit(profile.model):Infinity;
 const characters=references.filter(r=>r.role!=='environment'),environments=references.filter(r=>r.role==='environment');
 if(characters.length>limit)throw Error('此连接不能容纳全部人物参考，请选择支持更多参考图的连接');
 return [...characters,...environments.slice(0,Math.max(0,limit-characters.length))];
}
