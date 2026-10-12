import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {CgTransport} from '../src/cg-transport.mjs';
import {CgService} from '../src/cg-service.mjs';
import {fitReferences} from '../src/cg-reference-registry.mjs';
import {cgProtocol} from '../src/cg-presets.mjs';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jp1sAAAAASUVORK5CYII=','base64');
const profile={kind:'ark',protocol:'ark-images',baseUrl:'https://ark.cn-beijing.volces.com/api/v3',model:'doubao-seedream-4-0-20260415',key:'fixture-private-key',options:{references:true}};
const json=(data,status=200,headers={})=>new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json',...headers}});
test('Ark text, single and ordered multiple references all use one JSON generation endpoint',async()=>{
 const path=join(mkdtempSync(join(tmpdir(),'buddy-ark-')),'ref.png');writeFileSync(path,png);const calls=[];
 const transport=new CgTransport({fetchImpl:async(url,opts)=>{calls.push({url,opts});return json({data:[{b64_json:png.toString('base64')}]});}});
 for(const refs of [[],[{path}],[{path,role:'environment'},{path,role:'character'}]]){
  assert.deepEqual((await transport.generate(profile,{prompt:'character',references:refs})).buffer,png);
  const c=calls.at(-1),body=JSON.parse(c.opts.body);assert.equal(c.url,profile.baseUrl+'/images/generations');assert.equal(c.opts.headers.authorization,'Bearer '+profile.key);assert.equal(body.n,undefined);assert.equal(body.quality,undefined);assert.equal(body.sequential_image_generation,'disabled');assert.equal(body.size,'2K');assert.equal(body.stream,false);
  if(!refs.length)assert.equal(body.image,undefined);else if(refs.length===1)assert.equal(body.image,'data:image/png;base64,'+png.toString('base64'));else assert.equal(body.image.length,2);
 }
 assert.equal(calls.length,3);
});
test('Ark URL results download without forwarding API credentials; 5 pro omits unsupported sequence settings',async()=>{
 const calls=[];const t=new CgTransport({fetchImpl:async(url,opts)=>{calls.push({url:String(url),opts});return calls.length===1?json({data:[{url:'https://images.example.test/output.jpg'}]}):new Response(png);}});
 await t.generate({...profile,model:'doubao-seedream-5-0-pro-260628'},{prompt:'test'});assert.equal(JSON.parse(calls[0].opts.body).sequential_image_generation,undefined);assert.equal(calls[1].opts.headers,undefined);
});
test('Legacy official Ark connections route correctly; gateways remain explicitly configured',()=>{
 assert.equal(cgProtocol({...profile,protocol:'openai-images'}),'ark-images');assert.equal(cgProtocol({...profile,protocol:'openai-images',baseUrl:'https://gateway.test/api/v3'}),'openai-images');
 const refs=Array.from({length:14},(_,i)=>({role:'character',name:String(i)}));assert.equal(fitReferences(profile,[{role:'environment'},...refs]).length,14);assert.throws(()=>fitReferences(profile,[...refs,{role:'character'}]),/全部人物/);assert.throws(()=>fitReferences({...profile,model:'doubao-seedream-5-0-pro-260628'},refs),/全部人物/);
});
test('Ark errors include HTTP, code, message and request ID but redact credentials, prompt and URL tokens',async()=>{
 const prompt='private prompt text';const t=new CgTransport({fetchImpl:async()=>json({error:{code:'InvalidEndpointOrModel.NotFound',message:`Unavailable. ${profile.key} ${prompt} Bearer hidden-secret https://example.test/path?api_key=hidden-secret`}},404,{'x-request-id':'req-123'})});
 await assert.rejects(()=>t.generate(profile,{prompt}),e=>{assert.equal(e.details.status,404);assert.equal(e.details.code,'InvalidEndpointOrModel.NotFound');assert.equal(e.details.requestId,'req-123');assert.match(e.message,/Unavailable/);assert.ok(!e.message.includes(profile.key));assert.ok(!e.message.includes(prompt));assert.ok(!e.message.includes('hidden-secret'));return true;});
});
test('Gemini and Wan nested prompts are redacted from service errors without changing request payloads',async()=>{
 const prompt='fixture confidential character scene',path=join(mkdtempSync(join(tmpdir(),'buddy-nested-cg-')),'ref.png');writeFileSync(path,png);
 for(const protocol of ['gemini-images','wan-image','wan-t2i','wan-t2i-legacy']){
  const t=new CgTransport({fetchImpl:async(url,opts)=>{
   const body=JSON.parse(opts.body),submitted=protocol==='gemini-images'?body.input[0].text:protocol==='wan-t2i-legacy'?body.input.prompt:body.input.messages[0].content[0].text;
   assert.equal(submitted,prompt);assert.equal(body.prompt,undefined);assert.equal(opts.prompt,undefined);
   return json({error:{code:'InvalidInput',message:'Rejected: '+submitted}},400);
  }});
  await assert.rejects(()=>t.generate({...profile,protocol,model:'fixture-image'},{prompt,references:protocol==='wan-image'?[{path}]:[]}),e=>{
   assert.equal(e.details.code,'InvalidInput');assert.ok(!e.message.includes(prompt));assert.ok(!e.details.reason.includes(prompt));assert.match(e.details.reason,/redacted/);return true;
  });
 }
});
test('Wan resumed task errors redact the saved prompt without resubmitting it',async()=>{
 const prompt='fixture saved private scene';let calls=0;
 const t=new CgTransport({fetchImpl:async(url,opts)=>{calls++;assert.match(url,/tasks\/fixture-task$/);assert.equal(opts.method,'GET');assert.equal(opts.body,undefined);assert.equal(opts.prompt,undefined);return json({error:{message:'Failed: '+prompt}},400);}});
 await assert.rejects(()=>t.generate({...profile,protocol:'wan-t2i'},{prompt,remoteTask:{id:'fixture-task'}}),e=>!e.message.includes(prompt)&&e.message.includes('redacted'));
 assert.equal(calls,1);
});
test('Ark errors cannot become successful connection checks; model listing filters non-image models',async()=>{
 const t=new CgTransport({fetchImpl:async()=>json({error:{code:'ModelNotOpen',message:'Open model first'}},404)});await assert.rejects(()=>t.check(profile),/ModelNotOpen/);
 const models=await new CgTransport({fetchImpl:async()=>json({data:[{id:'doubao-seed-2-1-pro'},{id:profile.model}]})}).listModels(profile);assert.deepEqual(models.map(x=>x.id),[profile.model]);
});
test('Bounded malformed error bodies, per-image errors and empty results preserve useful failure',async()=>{
 for(const response of [new Response('<html>secret</html>',{status:502}),new Response('x'.repeat(70000),{status:400})])await assert.rejects(()=>new CgTransport({fetchImpl:async()=>response}).generate(profile,{prompt:'test'}),e=>e.message.length<200&&!e.message.includes('<html>'));
 await assert.rejects(()=>new CgTransport({fetchImpl:async()=>json({data:[{error:{code:'ImageRejected',message:'Image could not be generated'}}]})}).generate(profile,{prompt:'test'}),/ImageRejected/);
 await assert.rejects(()=>new CgTransport({fetchImpl:async()=>json({data:[]})}).generate(profile,{prompt:'test'}),/没有返回图片/);
});
test('Ark configuration and detailed failed job survive restart without storing plaintext keys',async()=>{
 const dataRoot=mkdtempSync(join(tmpdir(),'buddy-ark-service-')),crypto={isEncryptionAvailable:()=>true,encryptString:key=>Buffer.from(key).reverse(),decryptString:bytes=>Buffer.from(bytes).reverse().toString()},codex={defaultModel:'codex',close(){},setEnabled(){}};
 const options={dataRoot,crypto,codex,imageCodec:bytes=>({png:bytes,thumbnail:bytes,width:1,height:1}),fetchImpl:async()=>json({error:{code:'ModelNotOpen',message:'Please enable model'}},404)};
 const s=new CgService(options);await s.ready;const saved=await s.save({...profile,protocol:'openai-images'});assert.equal(saved.protocol,'ark-images');await s.activate(saved.id);assert.equal(s.enabled,false);s.start();const j=await s.enqueue({sourceEventId:'test-ark',prompt:'test'});while(s.job(j.id).status!=='failed')await new Promise(r=>setTimeout(r,10));assert.equal(s.publicJob(s.job(j.id)).errorDetails.code,'ModelNotOpen');assert.ok(!JSON.stringify(s.view()).includes(profile.key));await s.close();const restored=new CgService(options);await restored.ready;assert.equal(restored.job(j.id).errorDetails.code,'ModelNotOpen');await restored.close();
});
