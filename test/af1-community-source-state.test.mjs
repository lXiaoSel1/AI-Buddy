import test from 'node:test';
import assert from 'node:assert/strict';
import {setupCommunity,catalog,signed} from './support/community-fixtures.mjs';
for(const removed of [false,true])test('AF1 '+(removed?'removed':'disabled')+' community source immediately hides metadata and never refreshes remote',async t=>{
 let fetched=0;const f=await setupCommunity(t,{fetchImpl:async()=>{fetched++;return Response.json(signed(catalog(f.pub),f.pub));}});
 await f.service.action({action:'community-load-catalog',sourceId:f.pub.source.sourceId,url:'https://catalog.example/works.json',envelope:signed(catalog(f.pub),f.pub)});
 assert.equal((await f.service.action({action:'community-search'})).total,1);
 const original=f.legacy.action;f.legacy.action=async request=>{if(request.action==='sources-disable'||request.action==='sources-remove'){f.pub.source.enabled=false;f.pub.source.removed=removed;f.pub.source.generation++;return f.legacy.snapshot();}return original(request);};
 await f.service.action({action:removed?'sources-remove':'sources-disable',sourceId:f.pub.source.sourceId,disabled:true});
 assert.equal((await f.service.action({action:'community-search'})).total,0);
 await assert.rejects(f.service.action({action:'community-details',sourceId:f.pub.source.sourceId,id:'test.tools'}));
 await assert.rejects(f.service.action({action:'community-author',sourceId:f.pub.source.sourceId,id:'author.test'}), {code:'COMMUNITY_SOURCE_UNAVAILABLE'});
 await f.service.action({action:'community-refresh',sourceId:f.pub.source.sourceId});assert.equal(fetched,0);
 await f.restart();assert.equal((await f.service.action({action:'community-search'})).total,0);
});
test('AF1 source disabled during metadata fetch cannot reintroduce stale cards',async t=>{
 let enter,release;const entered=new Promise(r=>enter=r),wait=new Promise(r=>release=r);const f=await setupCommunity(t,{fetchImpl:async()=>{enter();await wait;return Response.json(signed(catalog(f.pub),f.pub));}});
 const loading=f.service.action({action:'community-load-catalog',sourceId:f.pub.source.sourceId,url:'https://catalog.example/works.json'});const failed=assert.rejects(loading);await entered;f.pub.source.enabled=false;f.pub.source.generation++;release();await failed;assert.equal((await f.service.action({action:'community-search'})).total,0);
});
test('AF1 source change in final busy check prevents native maintenance submission',async t=>{
 let f, calls=0; f=await setupCommunity(t,{busy:async()=>{if(++calls===2){f.pub.source.enabled=false;f.pub.source.generation++;}return false;}});
 await f.load(); const plan=await f.service.action({action:'dsh-plan',sourceId:f.pub.source.sourceId,id:'test.tools'});
 await f.service.action({action:'dsh-install',planId:plan.planId,grantedCapabilities:plan.declaredCapabilities}); await f.service.drainMaintenance();
 assert.equal(f.calls.filter(call=>call[0]==='install').length,0);
 assert.equal(f.service.snapshot().maintenance.jobs.at(-1).error.code,'PLUGIN_SOURCE_CHANGED');
});
