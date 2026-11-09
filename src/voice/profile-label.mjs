import {locale,t} from '../i18n.mjs';
import {PET_CHARACTERS} from '../pet-characters.mjs';

export function voiceProfileLabel(profile){
  const name=PET_CHARACTERS.find(row=>row.id===profile?.characterId)?.name,preset=profile?.bundledPreset;
  if(preset?.bundleId==='ai-buddy.character-voices-r04'&&preset.version===1&&name&&profile.label===name+' · 预制声线')return t(name)+' · '+(locale()==='en'?'Preset voice':'预制声线');
  return profile?.label;
}
