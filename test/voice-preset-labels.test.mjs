import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {setLocale} from '../src/i18n.mjs';
import {PET_CHARACTERS} from '../src/pet-characters.mjs';
import {VoicePopover,VoiceCharacters} from '../src/voice/design-ui.mjs';
import {cloudCharacterLabel} from '../src/voice/cloud-design-ui.mjs';
import {CloudVoiceBatchStatus} from '../src/voice/cloud-settings-ui.mjs';

const h=React.createElement,bundledPreset={bundleId:'ai-buddy.character-voices-r04',version:1};
function displays(profile){
  const id=profile.engine==='gpt'?'ai-buddy.voice-gpt-sovits':'ai-buddy.voice-breeze',snapshot={state:{scope:{characterId:profile.characterId},selectedPackageId:id,preparation:{state:'ready'},settings:{enabled:true},profile,packages:[]}};
  return [renderToStaticMarkup(h(VoicePopover,{snapshot})),renderToStaticMarkup(h(VoiceCharacters,{snapshot,id})),... [false,true].map(design=>renderToStaticMarkup(h(CloudVoiceBatchStatus,{batch:{items:[{...profile,status:'activated'}]},design}))),cloudCharacterLabel(profile)];
}
for(const language of ['zh-CN','en'])test(`bundled preset labels follow ${language} in all profile displays and custom labels stay unchanged`,()=>{
  setLocale(language);
  try{
    for(const {id:characterId,name} of PET_CHARACTERS)for(const engine of ['breeze','gpt']){
      const profile={characterId,engine,label:name+' · 预制声线',bundledPreset},expected=language==='en'?(characterId==='hunyuan'?'Hunyuan':name)+' · Preset voice':profile.label;
      for(const text of displays(profile)){assert.ok(text.includes(expected),`missing ${expected}`);if(language==='en')assert.ok(!text.includes('预制声线'));}
      for(const text of displays({...profile,bundledPreset:undefined}))assert.ok(text.includes(profile.label),'a custom label resembling a preset stays verbatim');
      for(const text of displays({...profile,label:'我的专属名字'}))assert.ok(text.includes('我的专属名字'),'a user-edited preset label stays verbatim');
    }
  }finally{setLocale('zh-CN');}
});
