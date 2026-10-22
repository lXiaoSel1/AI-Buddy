import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {AnalyticsPage,UsageGapNotice} from '../src/analytics-ui.mjs';
import {DEFAULT_PREFERENCES,normalizePreferences,validatePreferencesPatch} from '../src/preferences.mjs';

const NOTE='11 条请求缺少完整用量，合计为已记录部分。';
const page=(name,preferences={})=>renderToStaticMarkup(React.createElement(AnalyticsPage,{page:name,settings:{preferences:{...DEFAULT_PREFERENCES,...preferences}},monitor:{missingRequests:11,errors:[]}}));

test('the incomplete-usage notice is shown by default and can be turned off as a preference',()=>{
 assert.equal(DEFAULT_PREFERENCES.showUsageGapNotice,true);
 assert.deepEqual(validatePreferencesPatch({showUsageGapNotice:false}),{showUsageGapNotice:false});
 assert.throws(()=>validatePreferencesPatch({showUsageGapNotice:'no'}));
 assert.equal(normalizePreferences({showUsageGapNotice:false}).showUsageGapNotice,false);
});

test('work overview pages show the notice with a dismiss button until it is dismissed',()=>{
 for(const name of ['overview','projects']){
  const shown=page(name);
  assert.ok(shown.includes(NOTE),name);
  assert.match(shown,/aria-label="关闭提示；之后只在 Token 检测中显示"/);
  assert.ok(!page(name,{showUsageGapNotice:false}).includes('缺少完整用量'),name+' after dismissing');
 }
 assert.ok(!renderToStaticMarkup(React.createElement(UsageGapNotice,{count:3})).includes('<button'),'no button without a dismiss action');
});

test('outside the work overview the note appears in Token detection only',()=>{
 const source=readFileSync(new URL('../src/dashboard.mjs',import.meta.url),'utf8');
 assert.ok(source.includes("page==='tokens'&&data?.missingRequests>0"));
 assert.ok(!source.includes('!hideDiagnostics&&data?.missingRequests'));
});
