import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {VoiceChatControls} from '../src/voice/client.mjs';
import {MoodChip} from '../src/chat-r95-ui.mjs';

const h=React.createElement;
const snapshot={state:{settings:{enabled:true},preparation:{state:'ready'}}};
const voice=(speaking,galgame)=>renderToStaticMarkup(h(VoiceChatControls,{
 placement:'top',snapshot,presentation:speaking?{subtitle:{id:'fixture'}}:{},galgame,
}));

test('Galgame highlights the whole Voice button during playback only',()=>{
 assert.match(voice(true,true),/<button[^>]*class="[^"]*\bvx-vchip\b[^"]*\bon\b[^"]*"/);
 assert.doesNotMatch(voice(false,true),/<button[^>]*class="[^"]*\bvx-vchip\b[^"]*\bon\b[^"]*"/);
 assert.doesNotMatch(voice(true,false),/<button[^>]*class="[^"]*\bvx-vchip\b[^"]*\bon\b[^"]*"/);
});

test('Galgame mood has no chevron and remains a labelled button',()=>{
 const output=renderToStaticMarkup(h(MoodChip,{view:{mood:{label:'平静'}},galgame:true}));
 assert.match(output,/<button[^>]*aria-label="心情 · 平静"/);
 assert.doesNotMatch(output,/<svg/);
 assert.match(renderToStaticMarkup(h(MoodChip,{view:{mood:{label:'平静'}}})),/<svg/);
});
