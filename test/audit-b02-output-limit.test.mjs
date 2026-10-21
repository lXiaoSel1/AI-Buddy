import test from 'node:test';
import assert from 'node:assert/strict';
import {ApiTransport} from '../src/api-transport.mjs';
import {ModelRouter} from '../src/model-router.mjs';
import {createCompanionService,lenientReplyText} from '../src/companion-service.mjs';
import {fakeCrypto,stubCodex} from './support/mock-model-server.mjs';
import {tmpDir,memoryStore,syntheticEngine,companionFixture,sleep} from './support/audit-harness.mjs';

const CUT='{"text":"今天我们一起去海边散步，然后';
const sse=payloads=>new Response(payloads.map(v=>'data: '+(typeof v==='string'?v:JSON.stringify(v))+'\n\n').join(''),{headers:{'content-type':'text/event-stream'}});
const json=value=>new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});
const truncated={
 'chat-completions':max=>sse([{choices:[{delta:{content:CUT},finish_reason:null}]},{choices:[{delta:{},finish_reason:'length'}]},{choices:[],usage:{prompt_tokens:900,completion_tokens:max}},'[DONE]']),
 anthropic:max=>sse([{type:'message_start',message:{usage:{input_tokens:900}}},{type:'content_block_delta',delta:{type:'text_delta',text:CUT}},{type:'message_delta',delta:{stop_reason:'max_tokens'},usage:{output_tokens:max}},{type:'message_stop'}]),
 gemini:max=>sse([{candidates:[{content:{parts:[{text:CUT}]}}]},{candidates:[{finishReason:'MAX_TOKENS'}],usageMetadata:{promptTokenCount:900,candidatesTokenCount:max}}]),
 responses:max=>sse([{type:'response.output_text.delta',delta:CUT},{type:'response.incomplete',response:{status:'incomplete',incomplete_details:{reason:'max_output_tokens'},usage:{input_tokens:900,output_tokens:max}}}]),
 'responses-json':max=>json({status:'incomplete',incomplete_details:{reason:'max_output_tokens'},output:[{type:'message',content:[{type:'output_text',text:CUT}]}],usage:{input_tokens:900,output_tokens:max}}),
 'chat-completions-json':max=>json({choices:[{message:{content:CUT},finish_reason:'length'}],usage:{prompt_tokens:900,completion_tokens:max}}),
 'reasoning-only':max=>sse([{choices:[{delta:{},finish_reason:'length'}]},{choices:[],usage:{prompt_tokens:900,completion_tokens:max,completion_tokens_details:{reasoning_tokens:max}}},'[DONE]']),
};
const completeBody=()=>sse([{choices:[{delta:{content:'{"text":"完整的回复","emotion":"cheerful"}'},finish_reason:null}]},{choices:[{delta:{},finish_reason:'stop'}]},'[DONE]']);
async function drain(stream){const parts=[];try{for await(const part of stream)parts.push(part);return {parts,error:null};}catch(error){return {parts,error};}}

test('every protocol reports an output-limit stop as a length finish and keeps its usage',async()=>{
 for(const [name,make] of Object.entries(truncated)){
  const protocol=name.replace(/-json$/,'').replace('reasoning-only','chat-completions'),usage=[];
  const transport=new ApiTransport({fetchImpl:async()=>make(1600),onUsage:value=>usage.push(value)});
  const {parts,error}=await drain(transport.stream({id:'p',kind:'custom',protocol,baseUrl:'https://fixture.invalid/v1',key:'k',model:'m'},{messages:[{role:'user',content:'hi'}],maxTokens:1600}));
  assert.equal(error,null,name);assert.equal(parts.at(-1).reason.kind,'length',name);
  assert.equal(usage[0].usage.output,1600,name+' usage kept');
 }
});

test('request bodies honour the limit, auto and the Anthropic requirement',async()=>{
 const bodies={};
 for(const protocol of ['chat-completions','anthropic','gemini','responses'])for(const maxTokens of [8192,'auto']){
  const transport=new ApiTransport({fetchImpl:async(_,init)=>{bodies[protocol+'/'+maxTokens]=JSON.parse(init.body);return completeBody();}});
  await drain(transport.stream({id:'p',kind:'custom',protocol,baseUrl:'https://fixture.invalid/v1',key:'k',model:'m'},{messages:[{role:'user',content:'hi'}],maxTokens}));
 }
 assert.equal(bodies['chat-completions/8192'].max_tokens,8192);assert.equal(bodies['chat-completions/auto'].max_tokens,undefined);
 assert.equal(bodies['responses/auto'].max_output_tokens,undefined);assert.deepEqual(bodies['gemini/auto'].generationConfig,{});
 assert.equal(bodies['anthropic/auto'].max_tokens,8192);
});

async function router(t,{limit=8192,responses,contextTokens=128000,models}={}){
 const requests=[];let call=0;
 const value=new ModelRouter({codex:stubCodex(),dataRoot:tmpDir('b02-router',{t}),crypto:fakeCrypto,outputLimit:()=>limit,fetchImpl:async(_,init)=>{requests.push(JSON.parse(init.body));return responses[Math.min(call++,responses.length-1)]();}});
 await value.ready;t.after(()=>value.close());
 const saved=await value.save({kind:'custom',name:'A',protocol:'chat-completions',baseUrl:'https://fixture.invalid/v1',model:'m',key:'k',contextTokens,...(models?{models}:{})});
 await value.activate(saved.id);value.setEnabled(true);return {router:value,requests};
}
const text=parts=>parts.filter(p=>p.type==='text-delta').map(p=>p.text).join('');

test('user-limited requests use the setting with the caller floor, clamped by the model and the context window',async t=>{
 const {router:a,requests:ra}=await router(t,{responses:[completeBody]});
 await drain(a.stream({messages:[{role:'user',content:'hi'}],maxTokens:1200,userLimit:true}));assert.equal(ra[0].max_tokens,8192);
 const {router:b,requests:rb}=await router(t,{limit:512,responses:[completeBody]});
 await drain(b.stream({messages:[{role:'user',content:'hi'}],maxTokens:1200,userLimit:true}));assert.equal(rb[0].max_tokens,1200,'the old value stays a floor');
 const {router:c,requests:rc}=await router(t,{responses:[completeBody],models:[{id:'m',maxOutputTokens:4096}]});
 await drain(c.stream({messages:[{role:'user',content:'hi'}],maxTokens:1200,userLimit:true}));assert.equal(rc[0].max_tokens,4096,'model catalog limit');
 const {router:d,requests:rd}=await router(t,{responses:[completeBody],contextTokens:8192});
 await drain(d.stream({messages:[{role:'user',content:'x'.repeat(3000)}],maxTokens:1200,userLimit:true}));assert.ok(rd[0].max_tokens<=8192-3000,'what the context window leaves');
 const {router:e,requests:re}=await router(t,{limit:'auto',responses:[completeBody]});
 await drain(e.stream({messages:[{role:'user',content:'hi'}],maxTokens:1200,userLimit:true}));assert.equal(re[0].max_tokens,undefined);
 const {router:f,requests:rf}=await router(t,{responses:[completeBody]});
 await drain(f.stream({messages:[{role:'user',content:'hi'}],maxTokens:300}));assert.equal(rf[0].max_tokens,300,'internal calls keep their own limit');
});

test('a truncated reply is retried once with twice the limit, then reported as truncated',async t=>{
 const {router:a,requests:ra}=await router(t,{responses:[()=>truncated['chat-completions'](8192),completeBody]});
 const ok=await drain(a.stream({messages:[{role:'user',content:'hi'}],maxTokens:1200,userLimit:true}));
 assert.equal(ok.error,null);assert.equal(text(ok.parts),'{"text":"完整的回复","emotion":"cheerful"}','only the complete attempt is delivered');
 assert.deepEqual(ra.map(r=>r.max_tokens),[8192,16384]);
 const {router:b,requests:rb}=await router(t,{responses:[()=>truncated['reasoning-only'](8192)]});
 const failed=await drain(b.stream({messages:[{role:'user',content:'hi'}],maxTokens:1200,userLimit:true}));
 assert.equal(failed.error.code,'MODEL_OUTPUT_TRUNCATED');assert.equal(rb.length,2);assert.equal(text(failed.parts),'');
 const {router:c,requests:rc}=await router(t,{limit:'auto',responses:[()=>truncated['chat-completions'](4096),completeBody]});
 await drain(c.stream({messages:[{role:'user',content:'hi'}],maxTokens:1200,userLimit:true}));assert.deepEqual(rc.map(r=>r.max_tokens),[undefined,16384]);
});

test('group chat never stores or shows a raw JSON fragment',async t=>{
 assert.equal(lenientReplyText(CUT),'今天我们一起去海边散步，然后');assert.equal(lenientReplyText('普通台词'),null);assert.equal(lenientReplyText('{"emotion":"x"'),'');
 const store=memoryStore(await companionFixture()),{engine}=syntheticEngine({getStore:()=>store});
 let reply=CUT;const provider={enabled:true,currentSelection:()=>({provider:'p1',model:'m'}),resolveConnection:()=>({mode:'global',connectionId:'p1',name:'p1',model:'m',error:null}),resolveContextCapacity:()=>({tokens:128000,source:'fixture',verified:true}),runTurn:async fn=>fn(),
  async *stream(){yield {type:'text-delta',text:reply};yield {type:'finish',reason:{kind:'stop'}};}};
 const service=await createCompanionService({store,engine,provider,dataRoot:tmpDir('b02-group',{t}),now:Date.now});t.after(()=>service.close());
 const group=(await service.action('companion-group-save',{name:'测试群',memberIds:['claude','gpt'],mode:'list'})).companion.groups[0];
 await service.action('companion-group-select',{id:group.id,entryCharacterId:'claude'});
 await service.action('companion-group-send',{id:group.id,text:'大家好',forceCharacterId:'claude'});
 for(let n=0;n<40&&service.viewState().groupRuntime.status!=='awaiting-presentation';n++)await sleep(25);
 const pending=store.state.groups[group.id].pending.message;
 assert.equal(pending.text,'今天我们一起去海边散步，然后');assert.doesNotMatch(service.viewState().groupRuntime.pendingMessage.text,/\{"text"/);
 await service.action('companion-group-stop',{id:group.id});
 reply='{"emotion":"cheerful"';await service.action('companion-group-send',{id:group.id,text:'再说一次',forceCharacterId:'claude'});
 for(let n=0;n<40&&service.viewState().groupRuntime.status!=='failed';n++)await sleep(25);
 assert.equal(service.viewState().groupRuntime.status,'failed');assert.match(service.viewState().groupRuntime.error,/格式不完整/);
});
