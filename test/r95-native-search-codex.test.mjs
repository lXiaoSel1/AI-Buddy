import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {CodexProvider} from '../src/codex-provider.mjs';
const collect=async iterable=>{const out=[];for await(const item of iterable)out.push(item);return out;};
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function fixture(t,onTurn,modelProvider="openai"){
 const root=await mkdtemp(join(tmpdir(),'r95-codex-search-')),requests=[],spawns=[],usage=[];let nextThread=0,nextTurn=0;
 const child=new EventEmitter();Object.assign(child,{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),kill(){this.killed=true;}});
 const notify=(method,params)=>!child.killed&&child.stdout.write(JSON.stringify({method,params})+'\n');
 child.stdin.on('data',bytes=>{for(const line of String(bytes).trim().split('\n')){const message=JSON.parse(line);requests.push(message);if(message.id==null||!message.method)continue;queueMicrotask(()=>{const result=message.method==='account/read'?{account:{type:'chatgpt'}}:message.method==='thread/start'?{thread:{id:'th'+(++nextThread),modelProvider}}:message.method==='turn/start'?{turn:{id:'turn'+(++nextTurn)}}:{};child.stdout.write(JSON.stringify({id:message.id,result})+'\n');if(message.method==='turn/start')queueMicrotask(()=>onTurn({notify,threadId:message.params.threadId,turnId:result.turn.id,usage,requests}));});}});
 const provider=new CodexProvider({binary:'fixture.exe',defaultModel:'gpt-6.1-sol',dataRoot:join(root,'data'),env:{USERPROFILE:root,CODEX_HOME:join(root,'empty-home')},onUsage:value=>usage.push(value),handshakeTimeoutMs:500,turnTimeoutMs:1500,spawnImpl:(binary,args,options)=>{spawns.push({binary,args,options});queueMicrotask(()=>child.emit('spawn'));return child;}});provider.setEnabled(true);t.after(async()=>{provider.close();await rm(root,{recursive:true,force:true});});return {provider,requests,usage,spawns};
}
function done({notify,threadId,turnId},text='answer'){notify('item/completed',{threadId,turnId,item:{id:'message',type:'agentMessage',text}});notify('turn/completed',{threadId,turn:{id:turnId,status:'completed'}});}
test('Codex search permission is per thread; only native webSearch events and actual annotations are allowed',async t=>{
 let turns=0;const f=await fixture(t,context=>{turns++;if(turns===1){context.notify('item/started',{threadId:context.threadId,turnId:context.turnId,item:{id:'web1',type:'webSearch',action:{type:'search',query:'q'}}});context.notify('item/completed',{threadId:context.threadId,turnId:context.turnId,item:{id:'web1',type:'webSearch',action:{type:'search',query:'q',sources:[{url:'https://example.com/real',title:'Actual result'},{url:'file:///private',title:'bad'}]}}});}done(context);});
 const first=await collect(f.provider.stream({messages:[{role:'user',content:'q'}],nativeSearch:{allowed:true,check:()=>true},reasoningEffort:'high'})),second=await collect(f.provider.stream({messages:[]}));const threads=f.requests.filter(row=>row.method==='thread/start');assert.equal(threads[0].params.config.web_search,'live');assert.equal(threads[1].params.config.web_search,'disabled');for(const thread of threads){assert.equal(thread.params.sandbox,'read-only');assert.equal(thread.params.approvalPolicy,'never');assert.equal(thread.params.config['features.shell_tool'],false);assert.equal(thread.params.config['features.apply_patch_freeform'],false);assert.deepEqual(thread.params.config.mcp_servers,{});}assert.ok(first.some(p=>p.type==='native-search-tool'));assert.equal(first.filter(p=>p.type==='native-search-sources').flatMap(p=>p.sources).length,1);assert.equal(second.filter(p=>p.type==='native-search-tool').length,0);assert.equal(f.requests.filter(p=>p.method==='turn/start')[0].params.effort,'high');assert.ok(f.spawns[0].args.includes('web_search="disabled"'));
});
test('Codex permitted search still refuses shell, file changes, MCP and dynamic tools',async t=>{
 for(const type of ['commandExecution','fileChange','mcpToolCall','dynamicToolCall','collabToolCall','imageView','unknownFutureTool']){const f=await fixture(t,context=>{context.notify('item/started',{threadId:context.threadId,turnId:context.turnId,item:{id:'forbidden',type}});done(context);});await assert.rejects(()=>collect(f.provider.stream({messages:[],nativeSearch:{allowed:true,check:()=>true}})),/尝试调用工具/);assert.ok(f.requests.some(r=>r.method==='turn/interrupt'));}
});
test('Codex cancellation preserves prior actual usage with Core activity origin and purpose',async t=>{
 const controller=new AbortController(),f=await fixture(t,context=>context.notify('thread/tokenUsage/updated',{threadId:context.threadId,turnId:context.turnId,tokenUsage:{total:{inputTokens:7,outputTokens:2,totalTokens:9}}}));
 const pending=collect(f.provider.stream({messages:[],nativeSearch:{allowed:true,check:()=>true},purpose:'social-dream',activityOriginId:'core-dream-origin',signal:controller.signal}));
 for(let i=0;i<80&&!f.usage.length;i++)await delay(5);assert.equal(f.usage.length,1);controller.abort();await assert.rejects(()=>pending,/取消/);assert.equal(f.usage[0].usage.total_tokens,9);assert.equal(f.usage[0].activityOriginId,'core-dream-origin');assert.equal(f.usage[0].purpose,'social-dream');assert.ok(f.requests.some(r=>r.method==='turn/interrupt'));
});
test('Codex permission changed before thread creation prevents a search turn',async t=>{const f=await fixture(t,context=>done(context));await assert.rejects(()=>collect(f.provider.stream({messages:[],nativeSearch:{allowed:true,check:()=>false}})),/权限/);assert.equal(f.requests.filter(r=>r.method==='turn/start').length,0);});


test('Codex custom or unknown actual model providers cannot inherit OpenAI search',async t=>{for(const modelProvider of ['custom-proxy',null]){const f=await fixture(t,context=>done(context),modelProvider);await assert.rejects(()=>collect(f.provider.stream({messages:[],nativeSearch:{allowed:true}})),error=>error.code==='NATIVE_SEARCH_PROVIDER_UNVERIFIED');assert.equal(f.requests.filter(row=>row.method==='turn/start').length,0);}});
