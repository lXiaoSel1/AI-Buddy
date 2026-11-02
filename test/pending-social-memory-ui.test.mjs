import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {PendingSocialMemory} from '../src/companion-life-ui.mjs';
import {setLocale} from '../src/i18n.mjs';
test('unattributed legacy social records remain locally readable, bounded and read-only in both languages',()=>{for(const lang of ['zh-CN','en']){setLocale(lang);const memory={pendingAttributionTotal:130,pendingAttribution:Array.from({length:130},(_,i)=>({id:'record-'+i,text:'original-'+i,day:'2026-10-31',sourceKind:'user-report',accountId:'INTERNAL_ACCOUNT_DO_NOT_RENDER'}))},raw=JSON.stringify(memory),html=renderToStaticMarkup(React.createElement(PendingSocialMemory,{memory}));assert.match(html,/data-memory-pending-attribution/);assert.match(html,/original-99/);assert.doesNotMatch(html,/original-100|INTERNAL_ACCOUNT_DO_NOT_RENDER|<button|<input/);assert.match(html,/130/);assert.equal(JSON.stringify(memory),raw);}setLocale('zh-CN');assert.equal(renderToStaticMarkup(React.createElement(PendingSocialMemory,{memory:{}})),'');});
