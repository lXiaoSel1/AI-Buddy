import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {setLocale} from '../src/i18n.mjs';
import {VoicePopover,VoiceCharacters} from '../src/voice/design-ui.mjs';
import {cloudCharacterLabel} from '../src/voice/cloud-design-ui.mjs';
import {CloudVoiceBatchStatus} from '../src/voice/cloud-settings-ui.mjs';

const h=React.createElement,bundledPreset={bundleId:'ai-buddy.character-voices-r04',version:1};
// Exact defaults from both approved r04 Breeze/GPT presets/index.json files; no local package dependency.
const defaults=[
  ['deepseek','DeepSeek · 鲸鱼娘 · 预制声线','DeepSeek · Whale-chan · Preset voice'],
  ['grok','Grok · 预制声线','Grok · Preset voice'],
  ['seed','Seed · 预制声线','Seed · Preset voice'],
  ['kimi','Kimi · 预制声线','Kimi · Preset voice'],
  ['qwen','Qwen · 预制声线','Qwen · Preset voice'],
  ['minimax','MiniMax · 预制声线','MiniMax · Preset voice'],
  ['chatgpt','GPT · 预制声线','GPT · Preset voice'],
  ['gemini','Gemini · 预制声线','Gemini · Preset voice'],
  ['claude','Claude · 预制声线','Claude · Preset voice'],
  ['glm','GLM · 预制声线','GLM · Preset voice'],
  ['hunyuan','混元 · 预制声线','Hunyuan · Preset voice'],
];
function displays(profile){
  const id=profile.engine==='gpt'?'ai-buddy.voice-gpt-sovits':'ai-buddy.voice-breeze',snapshot={state:{scope:{characterId:profile.characterId},selectedPackageId:id,preparation:{state:'ready'},settings:{enabled:true},profile,packages:[]}};
  return [renderToStaticMarkup(h(VoicePopover,{snapshot})),renderToStaticMarkup(h(VoiceCharacters,{snapshot,id})),...[false,true].map(design=>renderToStaticMarkup(h(CloudVoiceBatchStatus,{batch:{items:[{...profile,status:'activated'}]},design}))),cloudCharacterLabel(profile)];
}
for(const language of ['zh-CN','en'])test(`bundled preset labels follow ${language} in all profile displays and custom labels stay unchanged`,()=>{
  setLocale(language);
  try{
    for(const [characterId,label,english] of defaults)for(const engine of ['breeze','gpt']){
      const profile={characterId,engine,label,bundledPreset},expected=language==='en'?english:label;
      for(const text of displays(profile)){assert.ok(text.includes(expected),`missing ${expected}`);if(language==='en')assert.ok(!text.includes('预制声线'));}
      for(const text of displays({...profile,bundledPreset:undefined}))assert.ok(text.includes(profile.label),'a custom label resembling a preset stays verbatim');
      for(const renamed of ['我的专属名字',label.replace(' · 预制声线',' · 自定义 · 预制声线'),...(characterId==='deepseek'?['DeepSeek · 预制声线']:[])])for(const text of displays({...profile,label:renamed}))assert.ok(text.includes(renamed),'a renamed bundled profile stays verbatim');
    }
  }finally{setLocale('zh-CN');}
});
