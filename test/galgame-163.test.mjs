import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {CgThemePlanner,localTheme,distinctTheme,parseTheme} from '../src/cg-theme.mjs';
import {CgService} from '../src/cg-service.mjs';
import {ModelRouter} from '../src/model-router.mjs';
import {createGalgame} from '../src/galgame-host.mjs';
import {createSnapshotStorage,readJson} from '../src/storage.mjs';
import {UsageQuery} from '../src/usage-query.mjs';
const temp=()=>mkdtempSync(join(tmpdir(),'aichan163-'));
const crypto={isEncryptionAvailable:()=>true,encryptString:s=>Buffer.from(s),decryptString:b=>b.toString()};
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jp1sAAAAASUVORK5CYII=','base64');
const codex={defaultModel:'fixture',enabled:false,setEnabled(){},close(){}};
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn){for(let i=0;i<300;i++){if(await fn())return;await delay(10);}throw Error('timed out');}
async function setup(options={}){const cg=new CgService({dataRoot:temp(),codex,crypto,imageCodec:b=>({png:b,thumbnail:b,width:1,height:1}),fetchImpl:async()=>new Response(JSON.stringify({data:[{b64_json:png.toString('base64')}]})),...options});await cg.ready;const p=await cg.save({kind:'custom',name:'test',baseUrl:'http://127.0.0.1:3',model:'image',protocol:'openai-images',options:{references:true}});await cg.activate(p.id);return cg;}
const brief=level=>({charId:'deepseek',level,visual:'蓝发鲸鱼娘女仆',history:[]});

test('Themes vary through high levels and reject repeated structure, not just title or level changes',()=>{
 const history=[];for(let level=1;level<=200;level++){const theme=localTheme(brief(level),history.slice(-6));assert.equal(distinctTheme(theme,history.slice(-6)),true);history.push(theme);}
 const old=history[0];assert.equal(parseTheme(JSON.stringify({...old,title:'Lv.999'}),[old]),null);assert.equal(parseTheme('{}',[]),null);
});
test('Theme planner makes one internal request, validates it, and falls back without reopening chat',async()=>{
 let calls=0,last;const router={enabled:true,selected:()=>({id:'chat',model:'fixture'}),async *stream(options){calls++;last=options;yield {type:'text-delta',text:JSON.stringify(localTheme(brief(32),[]))};}};
 const planner=new CgThemePlanner(router),capture=planner.capture();const first=await planner.prepare(brief(32),[],capture);assert.equal(calls,1);assert.equal(last.purpose,'cg-theme');assert.equal(first.theme.source,'model');assert.match(first.prompt,/不复制参考图/);
 const repeated=await planner.prepare(brief(33),[first.theme],capture);assert.equal(calls,2);assert.equal(repeated.theme.source,'local');assert.equal(distinctTheme(repeated.theme,[first.theme]),true);
 router.enabled=false;assert.equal((await planner.prepare(brief(34),[],capture)).theme.source,'local');assert.equal(calls,2);assert.equal(router.enabled,false);
});
test('Queued normal chat precedes background planning; connections lock and captured route is kept',async()=>{
 const router=new ModelRouter({dataRoot:temp(),crypto,codex});await router.ready;const p=await router.save({kind:'custom',name:'text',baseUrl:'http://127.0.0.1:3',model:'fixture'});await router.activate(p.id);
 const order=[];let finish;const first=router.runTurn(async()=>{order.push('first');await new Promise(r=>finish=r);});await until(()=>finish);
 const bg=router.runBackground(router.selected(),async()=>{order.push('theme');assert.equal(router.selected().id,p.id);});const chat=router.runTurn(async()=>order.push('chat'));await assert.rejects(()=>router.activate(p.id));finish();await Promise.all([first,bg,chat]);assert.deepEqual(order,['first','chat','theme']);router.close();
});
test('Whole theme and drawing queue is serial, retry reuses the saved prompt, interrupted planning is not resubmitted',async()=>{
 let calls=0,draws=0,release;const root=temp(),planner={capture:()=>({enabled:true}),async prepare(b){calls++;if(calls===1)await new Promise(r=>release=r);const theme=localTheme(b,[]);return {theme,prompt:'fixed '+b.level};}};
 const cg=await setup({dataRoot:root,themePlanner:planner,fetchImpl:async()=>{draws++;return new Response('bad',{status:500});}});cg.start();await cg.enqueue({id:'a',sourceEventId:'a',themeBrief:brief(32)});await until(()=>release);await cg.enqueue({id:'b',sourceEventId:'b',themeBrief:brief(33)});assert.equal(cg.job('b').status,'queued');assert.equal(draws,0);await assert.rejects(()=>cg.trashJob('a'),/等待/);await cg.trashJob('b');release();await until(()=>cg.job('a').status==='failed');assert.equal(draws,1);await cg.enqueue({id:'retry',sourceEventId:'retry',retryOf:'a',themeBrief:brief(99)});await until(()=>cg.job('retry').status==='failed');assert.equal(calls,1);assert.equal(cg.job('retry').prompt,cg.job('a').prompt);assert.ok(cg.job('retry').prompt.includes('fixed 32'));await cg.close();
 const store=createSnapshotStorage(join(root,'cg-jobs.json'));const data=await readJson(store);data.jobs[0].status='planning';data.jobs[0].prompt=null;await store.writeText(JSON.stringify(data));const restored=await setup({dataRoot:root,themePlanner:planner});restored.start();await delay(50);assert.equal(restored.job('a').status,'failed');assert.equal(calls,1);assert.ok(restored.job('b').deletedAt);await restored.close();
});
test('Gallery recycle/restore persists, resets only its active background, and never rewrites the image',async()=>{
 const root=temp(),cg=await setup({dataRoot:root}),provider={enabled:false,listProviders:()=>[],listModels:()=>[],async *stream(){throw Error('offline');}};let game=await createGalgame({dataRoot:root,cg,provider,model:'fixture'});cg.start();const before=await game.action('view'),job=await game.action('cg-generate');await until(async()=>(await game.action('cg-gallery')).items[0]?.status==='ready');const item=(await game.action('cg-gallery')).items[0],file=join(root,cg.job(item.id).assetRef),sha=()=>createHash('sha256').update(readFileSync(file)).digest('hex'),original=sha();await game.action('cg-save-bg',{id:item.id});assert.equal((await game.action('view')).bg,'cg');
 assert.equal((await game.action('cg-trash',{id:item.id})).ok,true);assert.equal((await game.action('cg-gallery')).items.length,0);assert.equal((await game.action('cg-trash-list')).items.length,1);assert.notEqual((await game.action('view')).bg,'cg');cg.changed();await delay(30);game.close();await cg.close();
 const next=await setup({dataRoot:root});game=await createGalgame({dataRoot:root,cg:next,provider,model:'fixture'});next.start();await delay(30);assert.equal((await game.action('cg-gallery')).items.length,0);await game.action('cg-restore',{id:item.id});assert.equal((await game.action('cg-gallery')).items.length,1);assert.notEqual((await game.action('view')).bg,'cg');assert.equal(sha(),original);assert.equal((await game.action('view')).level,before.level);assert.equal(next.jobs.length,1);game.close();await next.close();
});
test('Token coverage is token weighted, preserves request coverage, unknown totals and incremental corrections',()=>{
 const q=new UsageQuery();const row=(id,total,priced)=>({requestId:id,sessionId:id,tool:'codex',model:priced?'known':'unknown',timestamp:'2026-10-11T00:00:00Z',cacheIncluded:false,usage:{input:total,output:0,total},knownFields:total==null?[]:['input','output','total']});const prices={revision:1,estimate:r=>({amount:r.model==='known'?1:null,currency:'USD',reason:'missing'}),info:()=>({})};
 q.replaceGroup('a',[row('small',10,true),row('big',90,false),row('missing',null,true)]);let c=q.query({},prices).cost;assert.equal(c.coverage,2/3);assert.equal(c.tokenCoverage,.1);assert.equal(c.allTokens,100);assert.equal(c.missingTokenRequests,1);q.replaceGroup('a',[row('small',100,true),row('big',100,false)]);c=q.query({},prices).cost;assert.equal(c.tokenCoverage,.5);assert.equal(c.missingTokenRequests,0);assert.equal(c.amounts.USD,1);
});

test('Deleting during reference preparation cannot resurrect or submit the job',async()=>{
 let release,draws=0;const cg=await setup({referenceResolver:async()=>{await new Promise(r=>release=r);return [{buffer:png}];},fetchImpl:async()=>{draws++;throw Error('must not submit');}});cg.start();
 const add=cg.enqueue({id:'race',sourceEventId:'race',prompt:'fixture',characters:[{}]});await until(()=>release);await cg.trashJob('race');release();await add;await delay(30);assert.equal(cg.job('race').status,'cancelled');assert.ok(cg.job('race').deletedAt);assert.equal(draws,0);await cg.close();
});

test('Disabling automatic CG aborts planning and cancels unsubmitted work without a drawing call',async()=>{
 let started=false,draws=0;
 const planner={capture:()=>({enabled:true}),async prepare(brief,history,capture,signal){started=true;return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(Error('cancelled')),{once:true}));}};
 const cg=await setup({themePlanner:planner,fetchImpl:async()=>{draws++;throw Error('must not submit');}});await cg.setEnabled(true);cg.start();
 await cg.enqueue({id:'auto-planning',sourceEventId:'level:1',automatic:true,themeBrief:brief(1)});await until(()=>started);
 await cg.enqueue({id:'auto-waiting',sourceEventId:'level:2',automatic:true,themeBrief:brief(2)});await cg.setEnabled(false);await until(()=>!cg.pumping);
 assert.equal(cg.job('auto-planning').status,'cancelled');assert.equal(cg.job('auto-waiting').status,'cancelled');assert.equal(draws,0);assert.equal(cg.enabled,false);await cg.close();
});

