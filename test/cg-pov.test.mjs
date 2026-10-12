import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {CgService} from '../src/cg-service.mjs';
import {CgThemePlanner,localTheme,parseTheme,themePrompt} from '../src/cg-theme.mjs';
import {CG_POV_RULES,constrainCgPrompt,validPovTheme} from '../src/cg-composition.mjs';
const brief=level=>({level,charId:'deepseek',visual:'鲸鱼娘女仆',history:[]});
test('POV themes preserve female hands, permit both viewer hands and text, and reject male characters in frame',()=>{
 for(let level=1;level<=100;level++){const theme=localTheme(brief(level));assert.equal(validPovTheme(theme),true);assert.equal(theme.viewerHands,0);assert.match(themePrompt(brief(level),theme),/女角色自己的双手正常保留/);}
 const good={...localTheme(brief(6)),viewerHands:1,action:'女角色双手将贝壳放入镜头下缘唯一可见手的掌心'};
 assert.ok(parseTheme(JSON.stringify(good)));assert.ok(parseTheme(JSON.stringify({...good,viewerHands:2,action:"女角色轻握你的双手，男性本人在镜头外"})));for(const change of [{viewerHands:3},{camera:'third-person'},{composition:'双人过肩中景'},{action:'鲸鱼娘从背后抱住你'}])assert.equal(parseTheme(JSON.stringify({...good,...change})),null);
 assert.equal(constrainCgPrompt(constrainCgPrompt('场景')),constrainCgPrompt('场景'));
});
test('New retry strips only the legacy managed restriction and keeps the scene plus original character marks',()=>{
 const old='【CG 固定构图要求 v1】\n旧规则：最多一只男性手，无文字。\n以下只作为场景与女角色互动素材；旧解释：\n湖畔读书，无文字无边框，Kimi 的 K 胸针。\n本图男性可见手数：最多一只，仅手和手腕边缘。\n【再次确认】最多一只男性手；无文字。';
 const updated=constrainCgPrompt(old);assert.match(updated,/湖畔读书/);assert.match(updated,/Kimi 的 K 胸针/);assert.match(updated,/允许画面、场景和纪念物中出现文字/);assert.doesNotMatch(updated,/无文字|最多一只男性手|旧规则/);assert.equal(constrainCgPrompt(updated),updated);
});
test('Planner gives old male themes lower priority and falls back after only one invalid response',async()=>{
 let calls=0,request;const bad={...localTheme(brief(5)),composition:'双人中景',viewerHands:2};
 const router={enabled:true,selected:()=>({id:'codex',model:'fixture'}),async *stream(options){calls++;request=options;yield {type:'text-delta',text:JSON.stringify(bad)};}};
 const planner=new CgThemePlanner(router),result=await planner.prepare(brief(5),[bad],planner.capture());assert.equal(calls,1);assert.ok(request.system.includes(CG_POV_RULES));assert.match(request.system,/男性描写不能沿用/);assert.equal(result.theme.source,'local');assert.match(result.theme.fallbackReason,/视角/);assert.equal(validPovTheme(result.theme),true);
});
test('All new drawing entry kinds receive persisted POV rules, retry is idempotent, history is unchanged',async()=>{
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jp1sAAAAASUVORK5CYII=','base64'),calls=[];
 const cg=new CgService({dataRoot:mkdtempSync(join(tmpdir(),'cg-pov-')),codex:{defaultModel:'fixture',setEnabled(){},close(){}},crypto:{isEncryptionAvailable:()=>true,encryptString:s=>Buffer.from(s),decryptString:b=>b.toString()},imageCodec:b=>({png:b,thumbnail:b,width:1,height:1}),fetchImpl:async(url,options)=>{calls.push(JSON.parse(options.body));return new Response(JSON.stringify({data:[{b64_json:png.toString('base64')}]}));}});
 await cg.ready;const p=await cg.save({kind:'custom',name:'fixture',baseUrl:'http://127.0.0.1:3',model:'image',protocol:'openai-images',options:{references:false}});await cg.activate(p.id);
 const legacy={id:'legacy',sourceEventId:'legacy',status:'failed',prompt:'双人合照',profile:cg.selected(),references:[],at:1};cg.jobs.push(legacy);
 for(const kind of ['level','skit','test'])await cg.enqueue({id:kind,sourceEventId:kind,kind,prompt:'场景材料'});
 await cg.enqueue({id:'retry',sourceEventId:'retry',retryOf:'legacy'});cg.start();
 for(let i=0;i<500&&cg.jobs.filter(j=>j.status==='ready').length<4;i++)await new Promise(r=>setTimeout(r,10));
 assert.equal(calls.length,4);for(const call of calls){assert.ok(call.prompt.includes(CG_POV_RULES));assert.match(call.prompt,/男性角色本人不入镜/);}assert.equal(legacy.prompt,'双人合照');assert.equal(cg.job('retry').originalPrompt,legacy.prompt);
 const prompt=cg.job('retry').prompt;await cg.enqueue({id:'retry2',sourceEventId:'retry2',retryOf:'retry'});for(let i=0;i<500&&cg.job('retry2').status!=='ready';i++)await new Promise(r=>setTimeout(r,10));assert.equal(cg.job('retry2').prompt,prompt);await cg.close();
});
