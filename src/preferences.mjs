import {THEMES} from './appearance.mjs';
import {validPetCharacter} from './pet-characters.mjs';
import {defaultViews,validateViews} from './statistics-views.mjs';
export const DEFAULT_PREFERENCES=Object.freeze({maxOutputTokens:8192,language:'zh-CN',theme:'deepseek',themeMode:'fixed',hideSpriteOnCg:true,petVisible:true,petCharacterMode:'follow',petFixedCharacter:'deepseek',petScale:1.25,animationSpeed:0.75,alwaysOnTop:true,clickThrough:true,followCursor:true,showStatusBadge:true,showUsageGapNotice:true,completionBubbles:true,autoSleep:true,petPhysics:true,throwStrength:'standard',monitorRefreshMs:1000,displayTimeZone:'America/New_York',statisticsTimeZone:'local',autoPriceUpdates:false,statisticsViews:defaultViews()});
export const PET_SCALES=Object.freeze([0.75,1,1.25,1.5]);
export const ANIMATION_SPEEDS=Object.freeze([0.25,0.5,0.75,1]);
export const MONITOR_INTERVALS=Object.freeze([1000,2000,5000]);
const zones=['America/New_York','local','UTC'];
function valid(key,value){
  if(key==='throwStrength')return ['gentle','standard','strong','exaggerated'].includes(value);
  if(key==='petCharacterMode')return ['follow','fixed'].includes(value);
  if(key==='petFixedCharacter')return validPetCharacter(value);
  if(key==='language')return ['zh-CN','en'].includes(value);
  if(key==='theme')return Object.hasOwn(THEMES,value);
  if(key==='themeMode')return ['fixed','character'].includes(value);
  if(key==='statisticsViews'){try{validateViews(value);return true;}catch{return false;}}
  if(key==='petScale')return PET_SCALES.includes(value);
  if(key==='animationSpeed')return ANIMATION_SPEEDS.includes(value);
  if(key==='monitorRefreshMs')return MONITOR_INTERVALS.includes(value);
  if(key==='statisticsTimeZone'){try{if(value!=='local')new Intl.DateTimeFormat('en',{timeZone:value});return typeof value==='string';}catch{return false;}}
  if(key==='displayTimeZone')return zones.includes(value);
  if(key==='maxOutputTokens')return value==='auto'||Number.isInteger(value)&&value>=256&&value<=65536;
  return typeof DEFAULT_PREFERENCES[key]==='boolean'&&typeof value==='boolean';
}
export function normalizePreferences(value={},legacyVisible=true){
  const result={...DEFAULT_PREFERENCES,petVisible:legacyVisible!==false,statisticsTimeZone:value&&Object.keys(value).length?'America/New_York':'local'};
  if(value&&typeof value==='object')for(const key of Object.keys(DEFAULT_PREFERENCES))if(valid(key,value[key]))result[key]=key==='statisticsViews'?validateViews(value[key]):value[key];
  return result;
}
export function validatePreferencesPatch(patch){
  if(!patch||typeof patch!=='object'||Array.isArray(patch))throw new Error('设置必须是对象');
  const result={};
  for(const [key,value] of Object.entries(patch)){
    if(!Object.hasOwn(DEFAULT_PREFERENCES,key)||!valid(key,value))throw new Error('无效的设置：'+key);
    result[key]=key==='statisticsViews'?validateViews(value):value;
  }
  return result;
}
export function formatActivityTime(value,zone='America/New_York'){
  if(!value)return '—';
  return new Date(value).toLocaleString('zh-CN',{...(zone==='local'?{}:{timeZone:zone}),hour12:false});
}
