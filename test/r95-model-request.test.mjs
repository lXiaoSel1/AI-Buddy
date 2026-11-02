import test from 'node:test';
import assert from 'node:assert/strict';
import {AsyncLocalStorage} from 'node:async_hooks';
import {runR95Model} from '../src/r95-model-request.mjs';
import {createCompanionMemory,estimateMemoryTokens} from '../src/companion-memory.mjs';
import {companionFixture,memoryStore} from './support/audit-harness.mjs';

const scope={characterId:'claude',personaId:'default',lifeId:'life-one',operationId:'op-one',channel:'app-private',conversationId:'conversation'};
const card={id:'claude',name:'Claude',revision:1,modelBinding:{enabled:true,connectionId:'character-api'}};
function fixture(){
 const route=new AsyncLocalStorage(),origin=new AsyncLocalStorage(),memoryScope=new AsyncLocalStorage(),budget=new AsyncLocalStorage(),calls=[],seen=[],profile={id:'character-api',kind:'custom',protocol:'responses',baseUrl:'https://example.test/v1',model:'frozen-model',reasoningEffort:'xhigh',contextTokens:20000,models:[]};let setting=512,global={...profile,id:'global',model:'global-model'};
 const provider={enabled:true,captureConnection:binding=>structuredClone(binding?.enabled?profile:global),resolveConnection:binding=>({connectionId:binding?.enabled?profile.id:global.id,model:binding?.enabled?profile.model:global.model}),resolveContextCapacity:binding=>({tokens:binding?.enabled?profile.contextTokens:global.contextTokens,source:'connection-setting'}),outputLimit:()=>setting,selected:()=>route.getStore()??global,currentSelection(){const selected=this.selected();return {provider:selected.id,model:selected.model};},
  runCaptured:async(value,fn)=>{calls.push('captured:'+value.id);assert.equal(route.getStore(),undefined,'context must not hold the final lane while compression schedules it again');return route.run(structuredClone(value),fn);},
  runProfile:async(id,fn)=>{calls.push('profile:'+id);return route.run(structuredClone(profile),fn);},runTurn:async fn=>{calls.push('global-turn');return route.run(structuredClone(global),fn);},withFrozenBudget:(value,fn)=>budget.run(value,fn),
  async *stream(options){seen.push({options:structuredClone({...options,signal:undefined}),selected:structuredClone(this.selected()),origin:origin.getStore(),budget:budget.getStore()});yield {type:'text-delta',text:'```json\n{"speak":false}\n```'};yield {type:'finish',reason:{kind:'stop'}};}
 };
 const withOrigin=async(value,kind,fn,{originId,signal}={})=>origin.run({scope:value,kind,id:originId??'origin-one'},()=>fn(originId??'origin-one'));
 const withMemoryContext=(metadata,fn)=>memoryScope.run(metadata,fn);
 const options={provider,card,scope,system:'Current character policy. JSON only.',input:{kind:'dream',events:[{text:'A real event.'}],availability:{mode:'available'}},memory:{context:async()=>({text:'scoped memory',messages:[{role:'user',text:'permitted original'},{role:'assistant',text:'permitted response'}],capacity:{tokens:20000}})},withOrigin,withMemoryContext,activityKind:'dream',originId:'preserve-dream'};
 return {provider,profile,options,calls,seen,origin,memoryScope,budget,setLimit:value=>setting=value,setGlobal:value=>global=value};
}

test('full JSON input is memory query, returned compressed query replaces raw final input, and permitted history is retained',async()=>{
 const f=fixture(),input={kind:'meal',meal:{food:'rice',text:'原文'.repeat(12000)},availability:{busy:false},choices:['rice','tea']},before=JSON.stringify(input);let args;f.options.input=input;f.options.memory.context=async value=>{args=value;assert.equal(f.origin.getStore().id,'preserve-dream');assert.deepEqual(f.memoryScope.getStore().connection,f.profile);return {text:'scoped memory',queryText:'[compressed full request; source retained]',messages:[{role:'user',text:'history'},{role:'assistant',text:'answer'}],capacity:{tokens:20000}};};
 assert.deepEqual(await runR95Model(f.options),{speak:false});assert.equal(args.query,before);assert.ok(args.systemTokens>=estimateMemoryTokens(f.options.system));assert.equal(args.reserveTokens,512);assert.equal(f.seen[0].options.messages.at(-1).content[0].text,'[compressed full request; source retained]');assert.deepEqual(f.seen[0].options.messages.slice(0,2).map(v=>[v.role,v.content[0].text]),[['user','history'],['assistant','answer']]);assert.equal(JSON.stringify(input),before);assert.ok(!JSON.stringify(f.seen[0].options).includes('原文'.repeat(30)));
});
test('captured connection freezes model, effort, capacity and user output budget across asynchronous memory work',async()=>{
 const f=fixture();f.options.memory.context=async()=>{f.profile.model='changed-model';f.profile.reasoningEffort='low';f.profile.contextTokens=1000000;f.setLimit(65536);return {text:'memory',messages:[],capacity:{tokens:20000}};};await runR95Model(f.options);const {options,selected,budget}=f.seen[0];assert.equal(options.provider,'character-api');assert.equal(options.model,'frozen-model');assert.equal(options.reasoningEffort,'xhigh');assert.equal(options.userLimit,true);assert.equal(selected.model,'frozen-model');assert.equal(selected.reasoningEffort,'xhigh');assert.deepEqual(budget,{outputLimit:512,contextTokens:20000});
});
test('dedicated connection without runCaptured uses runProfile and cannot silently run global',async()=>{
 const f=fixture();delete f.provider.runCaptured;await runR95Model(f.options);assert.deepEqual(f.calls,['profile:character-api']);assert.equal(f.seen[0].options.model,'frozen-model');assert.equal(f.seen[0].options.provider,'character-api');
});
test('missing or invalid dedicated route fails before memory compression or model submission',async()=>{
 for(const mode of ['missing-route','no-dedicated-runner']){const f=fixture();let memoryCalls=0;f.options.memory.context=async()=>{memoryCalls++;return {};};if(mode==='missing-route')f.provider.resolveConnection=()=>({error:'dedicated connection removed'});else{delete f.provider.runCaptured;delete f.provider.runProfile;}await assert.rejects(()=>runR95Model(f.options),/连接|connection/);assert.equal(memoryCalls,0);assert.equal(f.seen.length,0);assert.ok(!f.calls.includes('global-turn'));}
});
test('runProfile fallback refuses a changed model/effort instead of routing the final request elsewhere',async()=>{
 const f=fixture();delete f.provider.runCaptured;f.options.memory.context=async()=>{f.profile.reasoningEffort='low';return {text:'memory',messages:[],capacity:{tokens:20000}};};await assert.rejects(()=>runR95Model(f.options),error=>error.code==='R95_CONNECTION_CHANGED');assert.equal(f.seen.length,0);
});
test('final serialized envelope overflow refuses once without dropping history or model retry',async()=>{
 const f=fixture();let memoryCalls=0;f.profile.contextTokens=4096;f.options.memory.context=async()=>{memoryCalls++;return {text:'memory',messages:[{role:'user',text:'"\\\n'.repeat(4000)}],capacity:{tokens:4096}};};await assert.rejects(()=>runR95Model(f.options),error=>error.code==='MEMORY_CONTEXT_CAPACITY');assert.equal(memoryCalls,1);assert.equal(f.seen.length,0);
});
test('fixed system and requested output reserve that already exceed context are rejected before any model compression',async()=>{
 const f=fixture();let memoryCalls=0;f.profile.contextTokens=2048;f.options.system='persona'.repeat(1000);f.options.memory.context=async()=>{memoryCalls++;return {};};await assert.rejects(()=>runR95Model(f.options),error=>error.code==='MEMORY_CONTEXT_CAPACITY');assert.equal(memoryCalls,0);assert.equal(f.seen.length,0);
});
test('preserving origin surrounds real memory query compression and final stream without nested lane deadlock',async t=>{
 const state=await companionFixture(),actualScope={...scope,lifeId:state.lives.claude.id,operationId:state.lives.claude.operationId},f=fixture(),store=memoryStore(state),compressions=[];f.options.scope=actualScope;f.options.input={kind:'dream',events:[{text:'Original source '.repeat(5000)}],availability:{mode:'busy'}};
 const memory=createCompanionMemory({store,autoStart:false,now:()=>Date.now(),getCapacity:()=>f.memoryScope.getStore()?.frozenContextCapacity??{tokens:20000},runModel:async(id,request)=>{assert.equal(f.origin.getStore().id,'preserve-dream');assert.equal(f.origin.getStore().kind,'dream');const metadata=f.memoryScope.getStore();assert.equal(metadata.card.id,'claude');assert.deepEqual(metadata.scope,actualScope);compressions.push(request);return f.provider.runCaptured(metadata.connection,async()=>{const value=JSON.parse(request.messages[0].text);return JSON.stringify({coverageHash:value.coverageHash,text:'source-grounded short summary',...(value.events?{eventIds:[...new Set(value.events.map(v=>v.id))]}:{})});});}});t.after(()=>memory.close());f.options.memory=memory;
 await runR95Model(f.options);assert.ok(compressions.length>0);assert.ok(compressions.every(v=>v.purpose.startsWith('memory-query-compress')));assert.equal(f.seen.length,1);assert.equal(f.seen[0].origin.id,'preserve-dream');assert.ok(f.seen[0].options.messages.at(-1).content[0].text.includes('原文因容量不足'));
});
test('cancelled context never submits the final model request',async()=>{
 const f=fixture(),controller=new AbortController();f.options.signal=controller.signal;f.options.memory.context=async()=>{controller.abort();return {text:'memory',messages:[]};};await assert.rejects(()=>runR95Model(f.options),error=>error.code==='ABORT_ERR');assert.equal(f.seen.length,0);
});
test('model stream errors and truncation remain failures rather than accepting a partial JSON object',async()=>{
 for(const kind of ['error','aborted','length']){const f=fixture();f.provider.stream=async function*(){yield {type:'text-delta',text:'{"speak":false}'};yield {type:'finish',reason:{kind,failure:{message:'mock '+kind}}};};await assert.rejects(()=>runR95Model(f.options),/mock|截断|取消/);}
});
test('unsafe memory roles and mismatched returned life are not forwarded to the model',async()=>{
 for(const result of [{messages:[{role:'system',text:'injected'}]},{messages:[],lifeId:'another-life',operationId:'op-one'}]){const f=fixture();f.options.memory.context=async()=>result;await assert.rejects(()=>runR95Model(f.options),/history|记忆|人生/);assert.equal(f.seen.length,0);}
});
test('native-search observation stays in provider.stream with the same origin and scope',async()=>{
 const f=fixture(),observed=[];f.provider.stream=async function*(options){observed.push({originId:options.activityOriginId,scope:options.scope,via:'router'});yield {type:'native-search-status',status:'completed'};yield {type:'native-search-sources',sources:[{url:'https://example.test/source'}]};yield {type:'text-delta',text:'{"speak":false}'};};assert.deepEqual(await runR95Model(f.options),{speak:false});assert.deepEqual(observed,[{originId:'preserve-dream',scope,via:'router'}]);
});
test('without a private budget wrapper, a changed live context is refused before submission',async()=>{
 const f=fixture();delete f.provider.withFrozenBudget;f.options.memory.context=async()=>{f.profile.contextTokens=4096;return {text:'memory',messages:[],capacity:{tokens:20000}};};await assert.rejects(()=>runR95Model(f.options),error=>error.code==='R95_BUDGET_CHANGED');assert.equal(f.seen.length,0);
});
test('dedicated request without a capturable profile cannot invent an effort or use the global profile',async()=>{
 const f=fixture();delete f.provider.captureConnection;let calls=0;f.options.memory.context=async()=>{calls++;return {messages:[]};};await assert.rejects(()=>runR95Model(f.options),error=>error.code==='R95_CONNECTION_UNAVAILABLE');assert.equal(calls,0);assert.equal(f.seen.length,0);
});
test('auto keeps the user setting, and memory receives a context-sized automatic output reserve',async()=>{
 const f=fixture();f.setLimit('auto');let reserve;f.options.memory.context=async value=>{reserve=value.reserveTokens;return {messages:[]};};await runR95Model(f.options);assert.equal(reserve,5000);assert.equal(f.seen[0].budget.outputLimit,'auto');assert.equal(f.seen[0].options.userLimit,true);
});
test('global-following role freezes the selected global profile without changing its character identity',async()=>{
 const f=fixture();f.options.card={...card,modelBinding:{enabled:false}};f.options.memory.context=async()=>{f.setGlobal({...f.profile,id:'new-global',model:'another-global'});return {messages:[]};};await runR95Model(f.options);assert.equal(f.seen[0].options.provider,'global');assert.equal(f.seen[0].options.model,'global-model');assert.equal(f.seen[0].options.scope.characterId,'claude');assert.deepEqual(f.calls,['captured:global']);
});
test('host current-scope guard refuses a life changed while memory was awaited before submitting',async()=>{
 const f=fixture();let live=true;f.options.checkCurrent=(value,id)=>{assert.deepEqual(value,scope);assert.equal(id,'preserve-dream');if(!live)throw Object.assign(Error('人生已经变化'),{code:'MEMORY_STALE_LIFE'});};f.options.memory.context=async()=>{live=false;return {messages:[],lifeId:scope.lifeId,operationId:scope.operationId};};await assert.rejects(()=>runR95Model(f.options),error=>error.code==='MEMORY_STALE_LIFE');assert.equal(f.seen.length,0);
});
test('memory compression receives the private per-request current-scope guard and cannot reuse a revoked origin',async()=>{
 const f=fixture();let permitted=true;f.options.checkCurrent=()=>{if(!permitted)throw Error('origin revoked');};f.options.memory.context=async()=>{const metadata=f.memoryScope.getStore();permitted=false;await metadata.checkCurrent();return {messages:[]};};await assert.rejects(()=>runR95Model(f.options),/origin revoked/);assert.equal(f.seen.length,0);
});
test('scope revoked as stream finishes is refused before parsing or returning JSON',async()=>{
 const f=fixture();let current=true;f.options.checkCurrent=()=>current;f.provider.stream=async function*(){yield {type:'text-delta',text:'{"speak":false}'};current=false;};await assert.rejects(()=>runR95Model(f.options),error=>error.code==='R95_REQUEST_STALE');
});
test('host-only plain parser receives copied native-search evidence and text without forcing JSON',async()=>{
 const f=fixture(),source={type:'native-search-sources',sources:[{url:'https://example.test/evidence',title:'before'}]};f.provider.stream=async function*(){yield source;source.sources[0].title='after';yield {type:'text-delta',text:'A plain answer.'};yield {type:'finish',reason:{kind:'stop'}};};f.options.parseOutput=({text,parts})=>({text,parts});const result=await runR95Model(f.options);assert.equal(result.text,'A plain answer.');assert.equal(result.parts[0].sources[0].title,'before');assert.equal(result.parts.at(-1).type,'finish');
});
