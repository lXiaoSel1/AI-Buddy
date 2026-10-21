import { apply } from './adapted/game-core.ts';
import { restrictedFileService } from './storage.mjs';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import {AsyncLocalStorage} from 'node:async_hooks';
import { EventEmitter } from 'node:events';
import {openCompanionStore,effectiveCard} from './companion-store.mjs';
import {createCompanionService} from './companion-service.mjs';
import {writePortableImages} from './companion-media.mjs';

export async function createGalgame({dataRoot,provider,model,cg=null,resources=null,getLanguage=()=> 'zh-CN',onCharacter=()=>{},onPetVisibility=()=>{},onChatCommitted=()=>{},onCgUpdated=()=>{},onActivity=()=>{}}) {
  const companionStore=await openCompanionStore(dataRoot);
  const languageContext=new AsyncLocalStorage();
  const personaContext=new AsyncLocalStorage();
  const root=join(dataRoot,'game-workspace');mkdirSync(root,{recursive:true});
  const bus=new EventEmitter(), effects=[];
  const privateSessionId='whale-companion-local';
  const privateHeader={id:privateSessionId,cwd:root,origin:'main',events:[]};
  const scope={fs:restrictedFileService(root),sandboxPolicy:{resolve:()=>({workspaceRoot:root})},sessions:{list:()=>[privateHeader]},workspaceRegistry:{list:()=>[{path:root}]},agentDefaultModel:{currentSelection:()=>provider.currentSelection?provider.currentSelection():({provider:'codex',model})},sessionQuery:{listSessions:async()=>[privateHeader],listEvents:async()=>[]}};
  bus.on('galgame/chat-committed',onChatCommitted);
  bus.on('galgame/cg-updated',onCgUpdated);
  const ctx={llm:provider,cg,resources,writePortableImages:files=>writePortableImages(dataRoot,cg?.imageCodec,files),companionCards:Object.values(companionStore.state.cards).map(card=>({...card,effective:effectiveCard(card)})),language:()=>languageContext.getStore()||getLanguage(),emit:(event,value)=>bus.emit(event,value),dshHomePath:(...parts)=>join(dataRoot,'galgame',...parts),inject:(_,fn)=>fn(scope),on:(event,fn)=>bus.on(event,fn),effect:fn=>{const cleanup=fn();if(typeof cleanup==='function')effects.push(cleanup);}};
  const engine=apply(ctx,{enabled:true,chatProvider:'codex',chatModel:model,singleChatSelection:!!provider.currentSelection,strictModelErrors:!!provider.currentSelection});
  const settings=await engine.handleAction('settings-get',{});
  // Default whale identity is fixed independently from the actual Codex model.
  if(!settings?.characterId){
    const view=await engine.handleAction('view',{});
    await engine.handleAction('settings-set',{characterMode:'manual',characterId:resources?.fallback(resources.status().initialCharacter)??(provider.currentSelection?view.current||'deepseek':'deepseek'),sideStorySeedSource:'activity',...(!provider.currentSelection?{chatMode:'manual',chatProvider:'codex',chatModel:model}:{})});
  }
  const companion=await createCompanionService({store:companionStore,engine,provider,dataRoot,imageCodec:cg?.imageCodec,resources,onCharacter,onChatCommitted,onActivity,getLanguage});
  ctx.assertCompanionLife=(id,token)=>companion.assertLife(id,token);
  ctx.guardCompanionProfile=(action,args)=>companion.guardProfile(action,args);
  ctx.companionLifeIds=ids=>Object.fromEntries(ids.filter(id=>companionStore.state.lives?.[id]).map(id=>[id,companionStore.state.lives[id].id]));
  ctx.companionCgVisible=(cg,id)=>{const life=companionStore.state.lives?.[id];return !life||cg.lifeIds?.[id]? !life||cg.lifeIds[id]===life.id : life.legacyImportEnabled===true||(life.selectedCgIds??[]).includes(cg.id);};
  ctx.companionHistory=(characterId,personaId)=>companion.history(characterId,personaId);
  ctx.companionPersonaId=()=>personaContext.getStore()||companion.context().personaId;
  ctx.companionProgress=(characterId,personaId)=>companion.progress(characterId,personaId);
  let sequence=0;
  return {
    async action(action,args={}) {
      if(action.startsWith('companion-'))return companion.action(action,args);
      companion.guardProfile(action,args);
      if(action==='chat')return languageContext.run(getLanguage(),()=>companion.chat(args));
      const usesChat=action==='chat'||action==='side-story-free-reply'||action==='side-story'&&!['advance','close','choose'].includes(args.op);
      if(usesChat && !provider.enabled) throw new Error('当前为离线模式；请先手动开启联网聊天');
      if(['cg-generate','cg-retry','skit-cg','side-story-cg'].includes(action)&&!cg?.available()) return {ok:false,error:'请在设置中选择 CG 绘图连接'};
      if(action==='settings-set')args={...args,settings:{...args.settings,sideStorySeedSource:'activity'},sideStorySeedSource:'activity'};
      if(['cg-generate','cg-retry'].includes(action))args={...args,personaId:companion.context().personaId};
      const language=getLanguage();
      const capturedPersona=companion.context().personaId;
      const run=()=>personaContext.run(capturedPersona,()=>languageContext.run(language,()=>engine.handleAction(action,{...args,sessionId:privateSessionId})));
      let result=provider.runTurn&&usesChat?await provider.runTurn(run):await run();
      if(usesChat&&capturedPersona!==companion.context().personaId)result=await engine.handleAction('view',{sessionId:privateSessionId});
      if(action==='pet-set' || action==='settings-set'){const saved=await engine.handleAction('settings-get',{});await onPetVisibility(saved.petEnabled!==false);}
      await companion.reflectLegacy(action,args,result);
      if(result?.current||result?.view?.current)onCharacter(companion.followCharacter());
      if(result?.current)return companion.decorate(result);
      if(result?.view)return {...result,view:await companion.decorate(result.view)};
      return result;
    },
    context:()=>companion.context(),
    hasCharacter:id=>companion.hasCharacter(id),
    touch:args=>companion.touch(args),
    workTokens(amount) {
      if(amount<=0)return;
      bus.emit('session/event',{header:{id:'local-work-ledger',cwd:root}},{type:'assistant/message',seq:++sequence,time:Date.now(),data:{id:'local-ledger-'+Date.now()+'-'+sequence,usage:{inputTokens:amount,outputTokens:0}}});
    },
    close(){companion.close();for(const fn of effects)fn();},
  };
}
