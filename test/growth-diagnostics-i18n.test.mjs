import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {GrowthDiagnostics} from '../src/companion-life-ui.mjs';
import {locale,setLocale} from '../src/i18n.mjs';

const han=/\p{Script=Han}/u;
const statuses=['missing','invalid','empty','legacy-empty','failed','rejected','observing','applied','unknown-status'];
const reasons=['field-not-growable','invalid-candidate','invalid-preference-candidate','invalid-evidence-reference','invalid-evidence','insufficient-independent-evidence','insufficient-character-behavior','insufficient-active-days','counterevidence-needs-review','refinement-requires-revision','refinement-has-no-new-detail','deep-change-needs-revision','daily-character-limit','change-not-small-behavior','unsafe-abstraction','stale-card','stale-life','unknown-reason'];
function render(growth){const previous=locale();setLocale('en');try{return renderToStaticMarkup(React.createElement(GrowthDiagnostics,{growth}));}finally{setLocale(previous);}}

test('English growth diagnostics translate every dynamic batch status, rejection reason and fixed note',()=>{
 const html=render({batches:statuses.map((status,index)=>({status,day:'2026-11-01',at:0,candidateCount:1,applied:0,observing:1,rejected:index===0?reasons.map((code,i)=>({code,field:i===reasons.length-1?'unrecognized-field':'likes'})):[]}))});
 assert.doesNotMatch(html,han,'fixed English diagnostics must not fall back to Chinese dynamic labels');
 for(const label of ['Day-end memory and growth status','The model omitted growth candidates','Invalid growth candidate format','Explicitly no growth candidates','Original candidate status was not saved for this older batch','Growth commit failed','Growth candidates rejected','Growth candidates under observation','Growth changes applied','Growth status recorded','Candidates','Applied','Observing','Unknown field'])assert.ok(html.includes(label),label);
 for(const label of ['Field is not eligible for growth','Incomplete candidate structure','Incomplete preference candidate structure','Invalid original source reference','Original experiences could not be verified','More new independent experiences needed','More new experiences from the character needed','Valid experiences on more dates needed','Counterevidence found; continue observing','Changing an existing preference requires new evidence','No new specific preference detail','Deeper changes need a longer observation period','Daily change limit reached; keep observing','The change is too large or unsuitable','Contains details unsuitable for the shared character profile','The character profile changed; the old candidate was not applied','Candidate belongs to a previous life','Candidate does not meet growth requirements'])assert.ok(html.includes(label),label);
 assert.ok(html.includes('Completing memory consolidation does not mean the personality has changed.'));
});

test('English growth diagnostics translate empty-state copy',()=>{
 const html=render({});assert.doesNotMatch(html,han);assert.ok(html.includes('No day-end growth batches yet.'));assert.ok(html.includes('Completing memory consolidation does not mean the personality has changed.'));
});

test('English preference status labels are translated while synthetic source-language subjects and attributes remain intact',()=>{
 const content=['茶偏好','香型','清香','阅读偏好','题材','科幻'];
 const html=render({preferences:[{id:'tea',subject:content[0],status:'established',attributes:{[content[1]]:content[2]}},{id:'books',subject:content[3],status:'observing',attributes:{[content[4]]:content[5]}}]});
 assert.ok(html.includes('Established preference'));assert.ok(html.includes('Preference under observation'));for(const value of content)assert.ok(html.includes(value),value);
 const fixedUi=content.reduce((text,value)=>text.replaceAll(value,''),html);assert.doesNotMatch(fixedUi,han,'character-authored content may keep its language; fixed UI must be English');
});
