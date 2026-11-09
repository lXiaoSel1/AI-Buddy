import {locale,t} from '../i18n.mjs';
import {PET_CHARACTERS} from '../pet-characters.mjs';

export function voiceProfileLabel(profile){
  const name=PET_CHARACTERS.find(row=>row.id===profile?.characterId)?.name,preset=profile?.bundledPreset;
  const defaultName=profile?.characterId==='deepseek'?'DeepSeek · 鲸鱼娘':name;
  if(preset?.bundleId==='ai-buddy.character-voices-r04'&&preset.version===1&&name&&profile.label===defaultName+' · 预制声线')return locale()==='en'?(profile.characterId==='deepseek'?'DeepSeek · Whale-chan':t(name))+' · Preset voice':profile.label;
  return profile?.label;
}

export function voiceProfileChoices(profiles=[]){
  const rows=[...profiles].sort((a,b)=>Number(!!b.bundledPreset)-Number(!!a.bundledPreset)||(Date.parse(b.importedAt)||0)-(Date.parse(a.importedAt)||0)||String(a.id).localeCompare(String(b.id)));
  const counts=new Map();for(const row of rows){const label=voiceProfileLabel(row);counts.set(label,(counts.get(label)??0)+1);}
  return rows.map(row=>{
    let label=voiceProfileLabel(row);
    if(!row.bundledPreset&&counts.get(label)>1){const date=Date.parse(row.importedAt);label+=' · '+(Number.isFinite(date)?new Intl.DateTimeFormat(locale()==='en'?'en-US':'zh-CN',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false}).format(date):locale()==='en'?'Import time unknown':'导入时间未知');}
    return {...row,displayLabel:label};
  });
}
