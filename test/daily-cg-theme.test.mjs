import test from 'node:test';
import assert from 'node:assert/strict';
import {dailyCgMaterials,localDailyCgTheme,parseDailyCgTheme,dailyCgThemePrompt,prepareDailyCgTheme} from '../src/daily-cg-theme.mjs';
import {CgThemePlanner,localTheme,themePrompt} from '../src/cg-theme.mjs';
import {CG_POV_RULES,DAILY_CG_COMPOSITION_POLICY,constrainDailyCgPrompt} from '../src/cg-composition.mjs';
const brief=()=>({kind:'daily',charId:'deepseek',language:'zh-CN',visual:'已确认的鲸鱼娘女仆',profile:{displayName:'DeepSeek'},daily:{logicalDay:'2026-11-01',slot:'10:00',timeZone:'UTC',fictional:true},materials:[{id:'video-1',text:'她看了一段关于雨中花园的视频，觉得安静。',sourceKind:'personal-activity',sourceHash:'a'.repeat(64)}],mood:{overall:{label:'平静'}},preferences:['喜欢看书']});
test('daily image-only fallback uses allowed material and stays fictional without forcing owner POV',()=>{
 const b=brief(),theme=localDailyCgTheme(b),prompt=dailyCgThemePrompt(b,theme);assert.equal(theme.fictional,true);assert.deepEqual(theme.sourceEventIds,['video-1']);assert.equal(theme.compositionPolicy,DAILY_CG_COMPOSITION_POLICY);assert.match(prompt,/雨中花园/);assert.match(prompt,/只有当前角色/);assert.doesNotMatch(prompt,/摄像机就是画外男生的双眼/);assert.equal(constrainDailyCgPrompt(prompt),prompt);assert.equal(theme.source,'local');
});
test('evening prefers fresh source events and does not reintroduce fictional, unknown-date or old revisions',()=>{
 const b=brief();b.daily.slot='22:00';b.previousMaterialEventIds=['video-1'];b.materials.push({id:'chat-2',text:'当天新聊过的花朵',sourceKind:'user-report'},{id:'dream',text:'梦中约会',fictional:true},{id:'undated',text:'旧记录',dateUnknown:true},{id:'old-revision',text:'旧说法',latest:false});const theme=localDailyCgTheme(b);assert.deepEqual(theme.sourceEventIds,['chat-2']);assert.deepEqual(dailyCgMaterials(b).map(row=>row.perspective),['user-report']);assert.doesNotMatch(dailyCgThemePrompt(b,theme),/梦中约会|旧记录|旧说法|雨中花园/);
});
test('no material produces a clearly marked preference and mood imagination',()=>{
 const b=brief();b.materials=[];const theme=localDailyCgTheme(b);assert.equal(theme.inspiration,'known-preferences-and-mood');assert.equal(theme.fictional,true);assert.deepEqual(theme.sourceEventIds,[]);assert.match(theme.keepsake,/喜欢看书/);assert.equal(theme.expression,'平静');assert.match(dailyCgThemePrompt(b,theme),/虚构插画/);
});
test('an evening with no new material uses a preference imagination instead of repeating the morning source',()=>{
 const b=brief();b.daily.slot='22:00';b.previousMaterialEventIds=['video-1'];const theme=localDailyCgTheme(b);assert.deepEqual(theme.sourceEventIds,[]);assert.equal(theme.inspiration,'known-preferences-and-mood');assert.doesNotMatch(dailyCgThemePrompt(b,theme),/雨中花园/);
});
test('video provenance preserves understood and unshared states instead of becoming a shared viewing',()=>{
 const b=brief();b.materials[0].source={type:'social',socialKind:'bilibili-watch',sha256:'a'.repeat(64)};b.materials[0].understandingState='understood';b.materials[0].presentationState='not-presented';const projected=dailyCgMaterials(b)[0];assert.equal(projected.socialKind,'bilibili-watch');assert.equal(projected.understandingState,'understood');assert.equal(projected.presentationState,'not-presented');
});
test('daily theme parser accepts solo composition and rejects unknown source IDs or factual claims',()=>{
 const b=brief(),theme=localDailyCgTheme(b);assert.ok(parseDailyCgTheme(JSON.stringify(theme),b));assert.equal(parseDailyCgTheme(JSON.stringify({...theme,sourceEventIds:['private-unknown']}),b),null);assert.equal(parseDailyCgTheme(JSON.stringify({...theme,fictional:false}),b),null);
});
test('online planner uses its frozen profile and falls back once after invalid provenance',async()=>{
 const b=brief(),calls=[],profile={id:'frozen',model:'user-chat',reasoningEffort:'xhigh'},router={enabled:true,runBackground:async(captured,fn)=>{assert.deepEqual(captured,profile);return fn();},async *stream(request){calls.push(request);yield {type:'text-delta',text:JSON.stringify({...localDailyCgTheme(b),sourceEventIds:['another-life']})};}};
 const result=await prepareDailyCgTheme(router,b,[],{enabled:true,profile,language:'zh-CN'});assert.equal(calls.length,1);assert.equal(calls[0].purpose,'cg-daily-theme');assert.match(calls[0].system,/自己的理解/);assert.equal(result.theme.source,'local');assert.match(result.theme.fallbackReason,/来源引用/);
});
test('CgThemePlanner routes daily only; existing upgrade theme and POV remain unchanged',async()=>{
 const router={enabled:false,selected:()=>({id:'chat',model:'model'})},planner=new CgThemePlanner(router),b=brief(),daily=await planner.prepare(b,[],planner.capture());assert.equal(daily.theme.fictional,true);assert.doesNotMatch(daily.prompt,/摄像机就是画外男生的双眼/);
 const level={charId:'deepseek',level:4,visual:'鲸鱼娘'},theme=localTheme(level);assert.ok(themePrompt(level,theme).includes(CG_POV_RULES));assert.equal(theme.camera,'male-first-person');assert.equal(localTheme(b).fictional,true);
});
test('English fallback and online output preserve fictional evidence metadata',async()=>{
 const b={...brief(),language:'en'},theme=localDailyCgTheme(b);assert.match(theme.title,/morning/);assert.match(dailyCgThemePrompt(b,theme),/fictional artwork/);const profile={id:'chat',model:'chosen'},router={enabled:true,async *stream(){yield {type:'text-delta',text:JSON.stringify({...theme,title:'Quiet garden studies'})};}};const result=await prepareDailyCgTheme(router,b,[],{enabled:true,profile,language:'en'});assert.equal(result.theme.source,'model');assert.equal(result.theme.model,'chosen');assert.deepEqual(result.theme.sourceEventIds,['video-1']);
});
test('an aborted daily planner does not produce a fallback that could be charged later',async()=>{
 const controller=new AbortController();controller.abort();await assert.rejects(prepareDailyCgTheme({enabled:false},brief(),[],null,controller.signal),{code:'DAILY_CG_CANCELLED'});
});
