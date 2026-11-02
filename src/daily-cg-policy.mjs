const words=value=>[...new Set(String(value??'').toLowerCase().match(/[a-z0-9_]{2,}|[\p{Script=Han}]{2,}/gu)??[])].flatMap(word=>/\p{Script=Han}/u.test(word)&&word.length>3?[word,...Array.from({length:word.length-1},(_,index)=>word.slice(index,index+2))]:[word]);
const topics=value=>Array.isArray(value?.topics)?value.topics.filter(topic=>typeof topic==='string'&&topic.trim()):[];
const readable=value=>typeof value==='string'?value:JSON.stringify(value??'');
// Match memory.relevance: restrictions are host-side filters, never model text.
export function dailyCgRestricted(value,restrictions){const lower=readable(value).toLowerCase();return topics(restrictions).some(topic=>words(topic).some(word=>lower.includes(word)));}
const denied=code=>Object.assign(Error('日常 CG 的素材限制与当前画面要求冲突；本时点未生成'),{code});
export function assertDailyCgPromptAllowed(value,restrictions){if(dailyCgRestricted(value,restrictions))throw denied('DAILY_CG_MATERIAL_RESTRICTED');}
export function dailyCgIdentity(profile={},visual=profile?.visual,restrictions){
 const identity=Object.fromEntries(['name','displayName','visual'].filter(key=>typeof profile?.[key]==='string').map(key=>[key,profile[key]]));
 if(dailyCgRestricted(identity,restrictions))throw denied('DAILY_CG_IDENTITY_RESTRICTED');
 if(typeof visual==='string')identity.visual=visual;
 if(dailyCgRestricted(identity,restrictions))throw denied('DAILY_CG_IDENTITY_RESTRICTED');
 return identity;
}
export function dailyCgCharacters(characters=[],restrictions){
 return characters.map(character=>{
  const result=Object.fromEntries(['id','name','identity','spriteKey','resourceVersion','referenceRole','customCharacter','referenceMode','dataUrl'].filter(key=>character?.[key]!==undefined).map(key=>[key,structuredClone(character[key])]));
  if(character?.profile)result.profile=dailyCgIdentity(character.profile,character.identity??character.profile.visual,restrictions);
  const {dataUrl,...identity}=result;if(dailyCgRestricted(identity,restrictions))throw denied('DAILY_CG_IDENTITY_RESTRICTED');
  return result;
 });
}
export function dailyCgScene(scene,restrictions,language='zh-CN'){
 const result=Object.fromEntries(['kind','key','description','name','resourceVersion','purpose','ignoreCharacters','dataUrl','assetRef','cgId','dedicatedScene'].filter(key=>scene?.[key]!==undefined).map(key=>[key,structuredClone(scene[key])]));
 const {dataUrl,...labels}=result;
 if(!dailyCgRestricted(labels,restrictions))return result;
 // A blocked environment must not return through its image reference.
 return {kind:'imagined',description:language==='en'?'a simple, open everyday space':'简洁开阔的生活空间',purpose:'environment-only',ignoreCharacters:true};
}
export function sanitizeDailyCgBrief(brief={}){
 const restrictions={topics:[...topics(brief.materialRestrictions)]},profile=dailyCgIdentity(brief.profile,brief.visual??brief.profile?.visual,restrictions),language=brief.language??'zh-CN';
 if(dailyCgRestricted(brief.charId,restrictions))throw denied('DAILY_CG_IDENTITY_RESTRICTED');
 const preferences=(Array.isArray(brief.preferences)?brief.preferences:[]).filter(row=>!dailyCgRestricted(row,restrictions)).map(row=>structuredClone(row));
 const sourceMood=brief.mood?.overall??brief.mood??{},label=typeof sourceMood.label==='string'&&!dailyCgRestricted(sourceMood.label,restrictions)?sourceMood.label:null;
 const value=Number.isFinite(sourceMood.value)?sourceMood.value:undefined;
 return {kind:'daily',charId:brief.charId,language,profile,visual:profile.visual,daily:structuredClone(brief.daily),materials:(Array.isArray(brief.materials)?brief.materials:[]).filter(row=>!dailyCgRestricted(row?.text,restrictions)).map(row=>structuredClone(row)),mood:{overall:{label,...(value!==undefined?{value}:{})}},preferences,scene:dailyCgScene(brief.scene,restrictions,language),previousMaterialEventIds:structuredClone(brief.previousMaterialEventIds??[]),materialRestrictions:restrictions};
}
