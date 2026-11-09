import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {createUpdateService} from '../src/update-service.mjs';
import {UpdateSettingsView} from '../src/update-settings.mjs';
import {setLocale} from '../src/i18n.mjs';
test('mirror mismatch keeps the selected release and official override belongs to one explicit retry',async()=>{
 const calls=[],selectionId='a'.repeat(64);let prepares=0;
 const service=createUpdateService({version:'2.0.13',build:'candidate',supported:true,run:async(op,ctx)=>{
  calls.push({op,official:ctx.official===true});
  if(op==='check')return {ok:true,stage:'available',selectionId,version:'2.0.14'};
  if(++prepares===1)return {ok:false,code:'NETWORK_MIRROR_MISMATCH',retryOfficial:true};
  return {ok:true,stage:'ready',selectionId,version:'2.0.14'};
 }});
 await service.action('check');await service.action('download');assert.equal(service.view().retryOfficial,true);assert.equal(service.view().retryAction,'download');
 await service.action('download',{official:true});assert.equal(service.view().phase,'ready');assert.equal(service.view().retryOfficial,false);
 await service.action('check');assert.deepEqual(calls,[{op:'check',official:false},{op:'prepare',official:false},{op:'prepare',official:true},{op:'check',official:false}]);
 await assert.rejects(service.action('download',{official:true}),{code:'APP_UPDATE_INVALID_STATE'});
});
test('update settings exposes official retry only for a confirmed mirror failure in both languages',()=>{
 for(const [language,label]of [['zh-CN','改用官方地址重试'],['en','Retry using official addresses']]){
  setLocale(language);const props={version:'2.0.13',state:{phase:'error',error:'NETWORK_MIRROR_MISMATCH',retryOfficial:true,retryAction:'download',target:{version:'2.0.14'}},act(){},checkPlugins(){},onPlugins(){}};
  const markup=renderToStaticMarkup(React.createElement(UpdateSettingsView,props));assert.match(markup,/data-update-action="retry-official"/);assert.ok(markup.includes(label));
  props.state.error='APP_UPDATE_VERIFICATION_FAILED';assert.ok(renderToStaticMarkup(React.createElement(UpdateSettingsView,props)).includes(language==='en'?'The mirror returned a file':'镜像返回的文件'));
  props.state.retryOfficial=false;assert.doesNotMatch(renderToStaticMarkup(React.createElement(UpdateSettingsView,props)),/data-update-action="retry-official"/);
 }
 setLocale('zh-CN');
});
