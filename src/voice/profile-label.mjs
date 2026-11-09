import {locale,t} from '../i18n.mjs';
import {PET_CHARACTERS} from '../pet-characters.mjs';

export function voiceProfileLabel(profile){
  const name=PET_CHARACTERS.find(row=>row.id===profile?.characterId)?.name,preset=profile?.bundledPreset;
  const defaultName=profile?.characterId==='deepseek'?'DeepSeek · 鲸鱼娘':name;
  if(preset?.bundleId==='ai-buddy.character-voices-r04'&&preset.version===1&&name&&profile.label===defaultName+' · 预制声线')return locale()==='en'?(profile.characterId==='deepseek'?'DeepSeek · Whale-chan':t(name))+' · Preset voice':profile.label;
  return profile?.label;
}
