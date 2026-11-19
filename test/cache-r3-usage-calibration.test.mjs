import test from 'node:test';
import assert from 'node:assert/strict';
import {ApiTransport} from '../src/api-transport.mjs';

test('successful private replies expose actual prompt usage to window calibration',async()=>{
 const samples=[];
 const transport=new ApiTransport({fetchImpl:async()=>Response.json({choices:[{message:{content:'Synthetic reply'},finish_reason:'stop'}],usage:{prompt_tokens:120,completion_tokens:5,total_tokens:125}})});
 const profile={id:'test',kind:'custom',protocol:'chat-completions',baseUrl:'http://localhost:1234/v1',model:'synthetic'};
 for await(const _ of transport.stream(profile,{messages:[{role:'user',content:'synthetic'}],onPromptUsage:value=>samples.push(value)})){}
 assert.deepEqual(samples,[120]);
});

test('Anthropic calibration uses full input and skips missing input counters',async()=>{
 const samples=[];
 const profile={id:'test',kind:'claude',protocol:'anthropic',baseUrl:'http://localhost:1234/v1',model:'synthetic'};
 for(const usage of [{input_tokens:10,cache_read_input_tokens:100,cache_creation_input_tokens:20,output_tokens:3},{cache_read_input_tokens:100,output_tokens:3}]){
  const transport=new ApiTransport({fetchImpl:async()=>Response.json({content:[{type:'text',text:'Synthetic reply'}],stop_reason:'end_turn',usage})});
  for await(const _ of transport.stream(profile,{messages:[{role:'user',content:'synthetic'}],onPromptUsage:value=>samples.push(value)})){}
 }
 assert.deepEqual(samples,[130]);
});

test('R4 private finish reaches the caller even while calibration persistence waits',async()=>{
 let release,called=false;
 const blocked=new Promise(resolve=>{release=resolve;});
 const transport=new ApiTransport({fetchImpl:async()=>Response.json({choices:[{message:{content:'Synthetic reply'},finish_reason:'stop'}],usage:{prompt_tokens:120}})});
 const profile={id:'test',kind:'custom',protocol:'chat-completions',baseUrl:'http://localhost:1234/v1',model:'synthetic'};
 const stream=transport.stream(profile,{messages:[{role:'user',content:'synthetic'}],onPromptUsage:()=>{called=true;return blocked;}});
 try{
  assert.equal((await stream.next()).value.type,'text-delta');
  const next=stream.next();
  assert.equal(await Promise.race([next.then(result=>result.value.type),new Promise(resolve=>setImmediate(()=>resolve('blocked')))]),'finish');
 }finally{release();await stream.return();}
 assert.equal(called,true,'a consumer that returns at finish still schedules the sample');
});
