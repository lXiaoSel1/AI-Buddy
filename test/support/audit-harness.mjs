// Shared fixtures for the audit regression tests (ported from the 1.9.0 audit
// harnesses): temp directories, a two-character companion state, an in-memory
// store and a synthetic legacy engine with per-action hooks.
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

export function tmpDir(name,{t=null}={}){
 const dir=mkdtempSync(join(tmpdir(),'audit-'+name+'-'));
 if(t)t.after(()=>rmSync(dir,{recursive:true,force:true}));
 return dir;
}
export const gate=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
export const copy=value=>structuredClone(value);
export const sleep=ms=>new Promise(r=>setTimeout(r,ms));

// Two-character companion state (pattern from companion-r30-concurrency.test.mjs).
export async function companionFixture({now=Date.now()}={}){
 const {makeCard}=await import('../../src/companion-store.mjs');
 const {ensureLives}=await import('../../src/companion-life.mjs');
 const yesterday=new Date(now-86400000).toISOString().slice(0,10),at=Date.parse(yesterday+'T12:00:00Z');
 const cards=Object.fromEntries(['claude','gpt'].map(id=>[id,makeCard({id,name:id,fields:{personality:{mode:'custom',value:'安静'}}})]));
 const state={schema:1,migrated:true,cards,personas:{default:{id:'default',name:'默认身份',nickname:'你',relationships:{}}},relationships:{claude:{mode:'independent',byPersona:{default:{level:4,affection:35}}},gpt:{mode:'independent',byPersona:{default:{level:2,affection:5}}}},conversations:{conversation:{id:'conversation',characterId:'claude',personaId:'default',title:'claude',archived:false,createdAt:at,updatedAt:at+100,messages:[{id:'source-user',requestId:'original-turn',role:'user',text:'A synthetic previous-day exchange',createdAt:at,status:'sent'},{id:'source-reply',requestId:'original-turn',role:'assistant',text:'A synthetic presented reply',createdAt:at+10,presentation:'presented'}],choices:[],draft:''}},groups:{},events:{},touchQuotas:{},draftCards:{},settings:{allowUserMessageEdit:true},activeCharacterId:'claude',activePersonaId:'default',activeConversationId:'conversation',defaultPersonaId:'default',memorySettings:{timeZone:'UTC'}};
 ensureLives(state,now);return state;
}

// In-memory store with the same mutate/flush/snapshot contract as
// openCompanionStore (pattern from test/companion-r30-concurrency.test.mjs).
export function memoryStore(value){let state=copy(value),tail=Promise.resolve();return {get state(){return state;},snapshot:()=>copy(state),async mutate(fn){const job=tail.then(async()=>{const next=copy(state),result=await fn(next);state=next;return result;});tail=job.catch(()=>{});return job;},flush:()=>tail};}

// Synthetic legacy engine (pattern from companion-r30-concurrency.test.mjs),
// extended with hooks so each harness can inject behaviour per action.
export function syntheticEngine({getStore,hooks={},history={}}={}){
 const engineState={claude:{level:4,affection:35,chatLines:[],choices:[],cgs:[]},gpt:{level:2,affection:5,chatLines:[],choices:[],cgs:[]}},calls=[];
 const engine={async handleAction(action,args={}){
  calls.push({action,characterId:args.characterId});const store=getStore();
  const extra=await hooks.call?.(action,args,{store,engineState,calls});if(extra!==undefined)return extra;
  if(action==='companion-export')return {current:'claude',characters:Object.values(store.state.cards).map(card=>({id:card.id,profile:{displayName:card.name,persona:'安静',tone:'平和',address:'你',greeting:'你好',visual:''},history:copy(history[card.id]??[]),choices:[],personaId:'default',...copy(engineState[card.id]??{level:1,affection:0}),pendingRelationEvents:[]}))};
  if(action==='view')return {current:'claude',characterMode:'manual'};
  if(action==='settings-set')return {ok:true,characterMode:args.characterMode??'manual'};
  if(action==='companion-register')return {ok:true};
  if(action==='companion-project'){for(const [id,value]of Object.entries(args.relationships??{}))if(engineState[id])Object.assign(engineState[id],value);return {ok:true};}
  if(action==='companion-relationship'){const value={level:args.base.level,affection:args.base.affection+args.delta};if(engineState[args.characterId])Object.assign(engineState[args.characterId],value);return {ok:true,...value,levels:[]};}
  if(action==='companion-ack-events')return {ok:true};
  if(action==='companion-life-content')return {ok:true,content:copy(engineState[args.characterId])};
  if(action==='companion-life-validate')return {ok:true};
  if(action==='companion-life-project'){engineState[args.characterId]=args.content.reset?{level:1,affection:0,cgs:[],chatLines:[],choices:[]}:copy(args.content);return {ok:true};}
  if(action==='companion-media-validate')return {ok:true};
  if(action==='companion-media-import')return {ok:true,idMap:{}};
  if(action==='companion-media-export')return {ok:true,media:[]};
  throw Error('Unhandled synthetic engine action '+action);
 }};
 return {engine,engineState,calls};
}
