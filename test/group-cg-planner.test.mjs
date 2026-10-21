import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizePhotoPlannerBinding,groupPhotoPlanner,validatePhotoPlanner} from '../src/group-cg-planner.mjs';

const automatic={enabled:false,connectionId:null};
const profiles=()=>[
 {id:'global',name:'全局模型',model:'global-model',reasoningEffort:'low',keyCiphertext:'SECRET_CIPHER',key:'SECRET_KEY',baseUrl:'https://private.example/api',models:[{id:'catalog-secret'}]},
 {id:'cheap',name:'经济模型',model:'cheap-model',reasoningEffort:'minimal'},
 {id:'stopped',name:'已停用',model:'stopped-model',enabled:false},
 {id:'image-only',name:'仅绘图',model:'image-model',capabilities:{chat:false}},
 {id:'empty',name:'尚未配置',model:''}
];
function provider(){const p={enabled:true,state:{activeId:'global',profiles:profiles()},calls:[]};p.selected=()=>p.state.profiles.find(row=>row.id===p.state.activeId);p.resolveConnection=binding=>{p.calls.push(structuredClone(binding));const row=binding?.enabled?p.state.profiles.find(row=>row.id===binding.connectionId):p.selected();return {connectionId:row?.id??binding?.connectionId??null,name:row?.name??'',model:row?.model??'',error:!row?'角色关联的聊天连接已删除，请重新选择':row.enabled===false?'角色关联的聊天连接已停用':row.capabilities?.chat===false?'该连接不支持聊天':!row.model?'聊天连接未设置模型':null};};return p;}
const group=()=>({id:'a',entryCharacterId:'entry',memberIds:['first','second']});
const cards=()=>({entry:{modelBinding:{enabled:true,connectionId:'cheap'}},first:{modelBinding:automatic}});

test('Planner bindings strictly validate only plain objects, boolean mode, and bounded nonempty IDs',()=>{
 for(const raw of [null,undefined,[],new Date(),Object.create({enabled:true}),{enabled:'true'},{enabled:1},{enabled:true},{enabled:true,connectionId:3},{enabled:true,connectionId:'   '},{enabled:true,connectionId:'x'.repeat(201)}])assert.throws(()=>normalizePhotoPlannerBinding(raw),/提示词策划/);
 assert.deepEqual(normalizePhotoPlannerBinding({enabled:false,connectionId:{secret:true},key:'ignored'}),automatic);
 assert.deepEqual(normalizePhotoPlannerBinding({enabled:true,connectionId:' cheap ',key:'ignored'}),{enabled:true,connectionId:'cheap'});
 const raw=Object.assign(Object.create(null),{enabled:true,connectionId:'cheap'});assert.deepEqual(normalizePhotoPlannerBinding(raw),{enabled:true,connectionId:'cheap'});
});

test('Old groups keep automatic routing through their entry character dedicated connection',()=>{
 const p=provider(),g=group(),c=cards(),view=groupPhotoPlanner(g,c,p);
 assert.deepEqual(view.binding,automatic);assert.equal(view.enabled,true);assert.deepEqual(view.effective,{connectionId:'cheap',name:'经济模型',model:'cheap-model',reasoningEffort:'minimal',error:null});assert.deepEqual(p.calls[0],c.entry.modelBinding);
 assert.equal(g.photoPlannerBinding,undefined);assert.deepEqual(c,cards());
});

test('Automatic mode uses the global connection if the entry card inherits it, independent of current speaker',()=>{
 const p=provider(),g={...group(),speakerId:'second',viewCharacterId:'first'},c={entry:{modelBinding:automatic}};
 assert.equal(groupPhotoPlanner(g,c,p).effective.connectionId,'global');g.speakerId='first';assert.equal(groupPhotoPlanner(g,c,p).effective.connectionId,'global');
 const fallback=groupPhotoPlanner({memberIds:['first']},{first:{modelBinding:{enabled:true,connectionId:'cheap'}}},p);assert.equal(fallback.effective.connectionId,'cheap');
});

test('Global routing supports activeId without selected(), and safe resolveConnection metadata',()=>{
 const p=provider();delete p.selected;delete p.resolveConnection;assert.equal(groupPhotoPlanner({}, {},p).effective.connectionId,'global');
 const minimal={enabled:true,resolveConnection:()=>({connectionId:'route',name:'只读路由',model:'route-model',reasoningEffort:'high',key:'DO_NOT_COPY'})};
 assert.deepEqual(groupPhotoPlanner({}, {},minimal).effective,{connectionId:'route',name:'只读路由',model:'route-model',reasoningEffort:'high',error:null});
});

test('Explicit selection stays scoped to each group and cannot change global or character connections',()=>{
 const p=provider(),c=cards(),a={...group(),photoPlannerBinding:{enabled:true,connectionId:'global'}},b={...group(),id:'b',photoPlannerBinding:{enabled:true,connectionId:'cheap'}};
 const before=JSON.stringify({state:p.state,c,a,b});assert.equal(groupPhotoPlanner(a,c,p).effective.connectionId,'global');assert.equal(groupPhotoPlanner(b,c,p).effective.connectionId,'cheap');assert.equal(groupPhotoPlanner(a,c,p).effective.connectionId,'global');assert.equal(JSON.stringify({state:p.state,c,a,b}),before);
});

test('Unavailable selected profiles report deleted, disabled, no-chat and missing-model reasons',()=>{
 const p=provider();for(const [id,message]of [['missing',/已删除/],['stopped',/已停用/],['image-only',/不支持聊天/],['empty',/未设置模型/]]){
  const binding={enabled:true,connectionId:id},view=groupPhotoPlanner({...group(),photoPlannerBinding:binding},cards(),p);assert.match(view.effective.error,message);assert.match(view.effective.error,/^提示词策划/);assert.throws(()=>validatePhotoPlanner(group(),cards(),p,binding),message);
 }
 const options=groupPhotoPlanner(group(),cards(),p).options;assert.equal(options.find(row=>row.id==='cheap').available,true);for(const id of ['stopped','image-only','empty'])assert.equal(options.find(row=>row.id===id).available,false);
});

test('A group can be configured offline, but an explicit prompt generation cannot silently fall back',()=>{
 const p=provider();p.enabled=false;const binding={enabled:true,connectionId:'cheap'};
 assert.deepEqual(validatePhotoPlanner(group(),cards(),p,binding),binding);assert.throws(()=>validatePhotoPlanner(group(),cards(),p,binding,{requireOnline:true}),/提示词策划需要联网聊天/);
 assert.deepEqual(validatePhotoPlanner(group(),cards(),p,automatic,{requireOnline:true}),automatic);assert.equal(groupPhotoPlanner({...group(),photoPlannerBinding:binding},cards(),p).enabled,false);
});

test('Automatic mode remains eligible for the existing local fallback when no connection is available',()=>{
 const view=groupPhotoPlanner({}, {},{enabled:false,state:{profiles:[],activeId:null}});assert.deepEqual(view.binding,automatic);assert.equal(view.effective.connectionId,null);assert.match(view.effective.error,/提示词策划尚未选择/);assert.deepEqual(view.options,[]);
 assert.deepEqual(validatePhotoPlanner({}, {},null,automatic,{requireOnline:true}),automatic);
});

test('Only credential-free whitelisted metadata leaves the router, with effort preserved or null',()=>{
 const p=provider(),view=groupPhotoPlanner({...group(),photoPlannerBinding:{enabled:true,connectionId:'global'}},cards(),p),encoded=JSON.stringify(view);
 for(const privateValue of ['SECRET_CIPHER','SECRET_KEY','private.example','catalog-secret','keyCiphertext','baseUrl','capabilities'])assert.ok(!encoded.includes(privateValue),privateValue);
 assert.deepEqual(Object.keys(view.effective).sort(),['connectionId','name','model','reasoningEffort','error'].sort());assert.deepEqual(Object.keys(view.options[0]).sort(),['id','name','model','reasoningEffort','available','error'].sort());assert.equal(view.effective.reasoningEffort,'low');assert.equal(view.options.find(row=>row.id==='stopped').reasoningEffort,null);
 view.binding.enabled=false;view.options[0].name='mutated';assert.equal(p.state.profiles[0].name,'全局模型');
});

test('Unexpected resolver exceptions and raw error payloads do not leak private details',()=>{
 const p=provider();p.resolveConnection=()=>{throw Error('SECRET_KEY https://private.example/api')};const view=groupPhotoPlanner(group(),cards(),p);assert.match(view.effective.error,/^提示词策划/);assert.ok(!JSON.stringify(view).includes('SECRET_KEY'));assert.ok(!JSON.stringify(view).includes('private.example'));
 p.resolveConnection=()=>({error:'SECRET_KEY unknown transport exception'});assert.equal(groupPhotoPlanner(group(),cards(),p).effective.error,'提示词策划连接暂不可用，请检查聊天连接配置');
});

test('Codex default effort matches the actual transport, while explicit model-default remains null',()=>{
 const p=provider();p.state.profiles.push({id:'codex',name:'Codex',kind:'codex',model:'gpt-6.1-sol'});
 const g={...group(),photoPlannerBinding:{enabled:true,connectionId:'codex'}};assert.equal(groupPhotoPlanner(g,cards(),p).effective.reasoningEffort,'low');
 p.state.profiles.at(-1).reasoningEffort=null;assert.equal(groupPhotoPlanner(g,cards(),p).effective.reasoningEffort,null);
});

test('Options are stable and unique even if a malformed catalog duplicates a profile ID',()=>{
 const p=provider();p.state.profiles.push({...p.state.profiles[1]});const view=groupPhotoPlanner(group(),cards(),p);assert.equal(view.options.length,5);assert.deepEqual(view.options.map(row=>row.id),['global','cheap','stopped','image-only','empty']);
});
