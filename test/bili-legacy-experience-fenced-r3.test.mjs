import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createSocialPluginBroker} from '../src/buddy-plugin-services/social-plugin-broker.mjs';

async function fixture(t,{comment=false,fenced=false,invalid=false}={}){
 const dataRoot=await mkdtemp(join(tmpdir(),'bili-experience-r3-')),identity={pluginId:'fixture-bili-experience',packageName:'@ai-buddy/bilibili-companion'},account={ref:'bili',accountId:'42',generation:1,enabled:true},profile={characterId:'deepseek',personaId:'p',lifeId:'l',operationId:'o',connectionRef:'model',available:true},model={id:'model',kind:'custom',protocol:'responses',model:'selected'},observations=new Map();let calls=0,recorded=0;
 const proposal=comment?{text:'An observed comment',evidenceRefs:['title']}:{summary:'An observed detail',evidenceRefs:['title']},text=JSON.stringify(proposal),reply=invalid?'Preface '+text:fenced?'```json\n'+text+'\n```':text;
 const transport={observation:id=>observations.get(id),request:async payload=>{const id='observation-'+observations.size,value=payload.method==='POST'?{code:0,data:{rpid:101}}:{data:{title:'Observed',desc:'Description'}};observations.set(id,{method:payload.method??'GET',body:JSON.stringify(value)});return {status:200,body:JSON.stringify(value),observationId:id};}};
 const core={socialHost:{registerContext:()=>({contextRef:'anchor',revoke(){}}),recordContextEvidence:value=>{recorded++;assert.equal(value.text,comment?proposal.text:proposal.summary);return {eventRef:'evidence-'+recorded};}},socialProfile:()=>profile,socialCatalog:()=>[]};
 const bridge={issueContext:async()=>({contextToken:'context'}),invoke:async request=>{if(request.method==='activity.check')return {valid:true};if(request.method==='activity.finish')return {};if(request.method==='experience.append')return {recorded:true};assert.equal(request.method,'models.request');calls++;return {requestId:'native-'+calls,text:reply,usageAccounting:'core-model-router'};}};
 const broker=createSocialPluginBroker({dataRoot,accounts:{forPlugin:()=>account,get:()=>account,secret:()=>({cookie:"synthetic-fixture"})},transport,bridge,getR95:()=>core,getProvider:()=>({state:{profiles:[model]},captureConnection:()=>model}),verifyBilibiliAccount:async()=>({connected:true,accountId:'42'})});t.after(()=>broker.close());
 const c=await broker.handlers['social.context.read']({identity,payload:{purpose:comment?'bilibili-public-comment':'bilibili-activity',characterId:'deepseek',modelConnectionRef:'model'},context:{authority:{kind:'app'}},check:async()=>{}});
 const call=async(method,payload)=>{payload={contextToken:c.contextToken,...payload};const context=await broker.contextProvider({identity,method,payload});return broker.handlers[method]({identity,context,payload,check:async()=>{}});};
 await call('connections.request',{platform:'bilibili',method:'GET',url:'https://api.bilibili.com/x/web-interface/view',leaseId:'lease'});
 const material={items:[{id:'title',text:'标题：Observed\n简介：Description'}]},result=await call('models.request',{leaseId:'lease',connectionRef:'model',purpose:comment?'bilibili-comment':'bilibili-understanding',requestId:'original-model-request',material,video:{aid:123},messages:[{role:'user',content:'Use only the observed material.'}]});
 return {call,result,proposal,count:()=>({calls,recorded})};
}

for(const fenced of [false,true])test(`legacy ${fenced?'fenced':'plain'} understanding records its original host receipt without another model request`,async t=>{
 const f=await fixture(t,{fenced});await f.call('experience.append',{providerRequestId:f.result.requestId,summaryCandidate:f.proposal.summary});assert.deepEqual(f.count(),{calls:1,recorded:1});
});
for(const fenced of [false,true])test(`${fenced?'fenced':'plain'} comment receipt is accepted by send proof and experience proof consistently`,async t=>{
 const f=await fixture(t,{comment:true,fenced});await f.call('connections.request',{platform:'bilibili',method:'POST',url:'https://api.bilibili.com/x/v2/reply/add',form:{message:f.proposal.text,oid:'123'},leaseId:'lease'});
 await f.call('experience.append',{sourceKind:'bilibili-comment',providerRequestId:f.result.requestId,platformMessageId:'101',deliveryState:'sent',text:f.proposal.text});assert.deepEqual(f.count(),{calls:1,recorded:1});
});
test('host experience proof refuses surrounding prose instead of extracting an embedded object',async t=>{
 const f=await fixture(t,{invalid:true});await assert.rejects(f.call('experience.append',{providerRequestId:f.result.requestId,summaryCandidate:f.proposal.summary}),{code:'SOCIAL_UNDERSTANDING_INVALID'});assert.deepEqual(f.count(),{calls:1,recorded:0});
});
