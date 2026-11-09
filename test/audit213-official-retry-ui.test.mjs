import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {pluginResult} from '../src/plugin-center-helpers.mjs';
import {MaintenanceRow} from '../src/community-center.mjs';
import {VoiceParts} from '../src/voice/design-ui.mjs';
import {setLocale} from '../src/i18n.mjs';
import {invokeWithOfficialRetry,officialRetryPin,officialRetryRequest} from '../src/plugin-official-retry.mjs';
test('B8: renderer plugin error keeps the source host and explicit official-retry flag',()=>{assert.throws(()=>pluginResult({error:{code:'NETWORK_MIRROR_MISMATCH',message:'Fixture rejected',host:'mirror.invalid',retryOfficial:true}}),error=>error.host==='mirror.invalid'&&error.retryOfficial===true);});
for(const lang of ['zh-CN','en'])test(lang+': B8 a failed install job exposes only its exact official retry',()=>{setLocale(lang);const calls=[],job={id:'fixed-job',packageKey:'dsh:official:@fixture/plugin',operation:'install',state:'failed',version:'1.0.0',error:{code:'NETWORK_MIRROR_MISMATCH',retryOfficial:true,message:'Fixture mismatch'}};const element=MaintenanceRow({job,installed:[],busy:false,onRetry:(...args)=>calls.push(args),onReview(){}}),html=renderToStaticMarkup(element);assert.ok(html.includes(lang==='en'?'Retry using official addresses':'改用官方地址重试'));const children=React.Children.toArray(element.props.children),button=children.find(row=>row.props?.['data-maintenance-official-retry']);assert.ok(button);button.props.onClick();assert.equal(calls[0][0],job);assert.equal(calls[0][1].official,true);});
test('B8: voice mirror failure offers an explicit official retry for the same provider and package only',()=>{
 setLocale('zh-CN');const id='ai-buddy.voice-breeze',snapshot={state:{selectedPackageId:id,settings:{packages:{[id]:{ttsProvider:'local'}}}},assetProgress:{engineId:id,provider:'local',kind:'breeze',state:'failed',code:'NETWORK_MIRROR_MISMATCH',retryOfficial:true}};
 const html=renderToStaticMarkup(React.createElement(VoiceParts,{snapshot,id,onPrepareOfficial(){}}));assert.match(html,/改用官方地址重试/);
});
test('B8: error-owned request pins survive other polls and caller mutations without retrying models',async()=>{
 const request={action:'install',planId:'confirmed-plan',version:'1.0.0',digest:'frozen-digest'},calls=[];let first;
 const invoke=async input=>{calls.push(structuredClone(input));throw Object.assign(Error('Fixture mismatch'),{code:'NETWORK_MIRROR_MISMATCH',retryOfficial:true});};
 try{await invokeWithOfficialRetry(invoke,request);}catch(error){first=error;}
 request.planId='another-plan';await invokeWithOfficialRetry(async()=>({state:'ready'}),{action:'status'});
 await assert.rejects(invokeWithOfficialRetry(invoke,{action:'search',query:'another query'}));
 const retry=officialRetryRequest(officialRetryPin(first));assert.deepEqual(retry,{action:'install',planId:'confirmed-plan',version:'1.0.0',digest:'frozen-digest',official:true});assert.equal(calls.length,2,'Explicit retry preparation must not submit a request');
 await assert.rejects(invokeWithOfficialRetry(invoke,{action:'models.request',input:'Never resubmit'}),error=>officialRetryPin(error)===null);
 await assert.rejects(invokeWithOfficialRetry(invoke,retry),error=>officialRetryPin(error)===null);assert.equal(calls.at(-1).official,true);
});
test('B8: voice retry remains disabled when the provider changed after the failed download',()=>{
 const id='ai-buddy.voice-breeze',snapshot={state:{selectedPackageId:id,settings:{packages:{[id]:{ttsProvider:'minimax'}}}},assetProgress:{engineId:id,provider:'local',kind:'selected',state:'failed',code:'NETWORK_MIRROR_MISMATCH',retryOfficial:true}};
 const html=renderToStaticMarkup(React.createElement(VoiceParts,{snapshot,id,onPrepareOfficial(){}}));assert.match(html,/<button[^>]*disabled[^>]*data-voice-official-retry/);
});
