import React from 'react';
import {CompanionManager} from '../../src/companion-ui.mjs';
import {GroupHeader} from '../../src/group-header.mjs';
import {GalgameCSS} from '../../src/adapted/galgame-client.ts';
import {setLocale} from '../../src/i18n.mjs';
import {applyAppearance} from '../../src/appearance.mjs';

const h=React.createElement;
const character={id:'deepseek',name:'DeepSeek',builtin:true,effective:{}},persona={id:'me',name:'Self'};
const conversations=Array.from({length:60},(_,index)=>({id:'session-'+index,title:'Conversation '+(index+1),characterId:character.id,personaId:persona.id,messageCount:120}));
const group={id:'fixture-group',name:'Group history fixture',memberIds:[character.id],personaId:persona.id,photos:[]};
const row=(prefix,index)=>({id:prefix+'-'+index,role:'assistant',characterId:character.id,personaId:persona.id,status:'presented',createdAt:index+1000,text:'Synthetic proper dialogue number '+index+(index===10?' needle':'')});
const data=Object.fromEntries([
 ['session-0',Array.from({length:120},(_,index)=>row('private',index+1))],
 ['session-59',Array.from({length:120},(_,index)=>row('late',index+1))],
 [group.id,Array.from({length:120},(_,index)=>row('group',index+1))],
]);
data['session-0'][39].role='user';
const repeated='same-logical-id';
for(const index of [39,89])Object.assign(data['session-0'][index],{occurrenceId:data['session-0'][index].id,id:repeated});
data[group.id].push({...row('group',121),status:'pending-presentation'});
const base={activeCharacterId:character.id,activePersonaId:persona.id,activeConversationId:'session-0',settings:{allowUserMessageEdit:true},
 characters:[character],personas:[persona],conversations,groups:[group],groupRuntime:{status:'idle'},revision:1};
const calls=[];
const messageTarget=args=>data[args.conversationId].find(row=>row.id===args.id&&row.occurrenceId===args.occurrenceId);
let declineFavorite=false;
async function request(action,args={}){
 calls.push([action,args]);
 if(action==='companion-history-page'){
  const all=data[args.ownerId]??[];
  const before=args.before?.ordinal??Infinity;
  const matches=all.filter(message=>(args.ownerType!=='group'||message.status!=='pending-presentation')&&message.text.toLowerCase().includes(args.search.toLowerCase())&&(!args.favorites||message.favorite));
  const prior=matches.filter(message=>all.indexOf(message)+1<before);
  const messages=prior.slice(-args.limit),hasMore=prior.length>messages.length;
  return {totalCount:matches.length,messages:structuredClone(messages),hasMore,nextBefore:hasMore?{ordinal:all.indexOf(messages[0])+1,rowId:messages[0].occurrenceId??messages[0].id}:null,revision:1};
 }
 if(action==='companion-message-edit'){
  const message=messageTarget(args);
  Object.assign(message,{text:args.text,originalText:message.text,revisions:[{text:'Server revision preserved',at:1234}]});
  return {ok:true,message:{...message}};
 }
 if(action==='companion-message-favorite'){
  if(declineFavorite)return {ok:false,error:'Could not save fixture favorite'};
  messageTarget(args).favorite=args.value;
  return {ok:true};
 }
 if(action==='companion-conversation-list')return {ok:true,conversations};
 if(action==='side-story-log')return {skits:[]};
 if(action==='cg-gallery')return {items:[]};
 if(action==='companion-conversation-export')throw Error('Export is only for an explicit user action');
 return {ok:true};
}
function failUnless(ok,message){if(!ok)throw Error(message);}
async function until(check,description){
 for(let i=0;i<220;i++){const value=check();if(value)return value;await new Promise(resolve=>setTimeout(resolve,10));}
 throw Error('History fixture did not reach '+description);
}
function style(){
 applyAppearance({theme:'deepseek'});
 const css=document.createElement('style');css.textContent=GalgameCSS+'\nbody{margin:0}*,*::before,*::after{box-sizing:border-box}';document.head.append(css);
}
function enter(input,value){
 Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input),'value').set.call(input,value);
 input.dispatchEvent(new Event('input',{bubbles:true}));
}
const desired=(node,rows,number)=>node.querySelectorAll(rows).length===number;
async function exercise(scroller,selector,prefix){
 await until(()=>calls.some(([action,payload])=>action==='companion-history-page'&&payload.limit===50),prefix+' bounded page IPC');
 await until(()=>desired(scroller,selector,50),prefix+' latest 50 messages');
 failUnless(scroller.querySelector(selector).textContent.includes('71'),prefix+' recent page starts at 71');
 failUnless(scroller.scrollHeight>scroller.clientHeight&&scroller.scrollHeight-scroller.scrollTop-scroller.clientHeight<5,prefix+' first open is at the latest line '+[scroller.scrollHeight,scroller.scrollTop,scroller.clientHeight].join('/'));
 scroller.scrollTop=0;
 scroller.dispatchEvent(new Event('scroll'));
 await until(()=>desired(scroller,selector,100),prefix+' append older 50 '+JSON.stringify({bodyHeight:scroller.clientHeight,scrollHeight:scroller.scrollHeight,rect:scroller.getBoundingClientRect().toJSON(),scrollTop:scroller.scrollTop,called:calls.filter(([action])=>action==='companion-history-page'),parent:scroller.parentElement.getBoundingClientRect().toJSON()}));
 failUnless(scroller.querySelector(selector).textContent.includes('21'),prefix+' older page starts at 21');
 const original=[...scroller.querySelectorAll(selector)].find(node=>node.textContent.includes('number 71'));
 const delta=original.getBoundingClientRect().top-scroller.getBoundingClientRect().top;
 failUnless(delta>-15&&delta<140,prefix+' older page retains the first visible position: '+delta);
}

export async function privateHistory(root){
 style();calls.length=0;
 root.render(h(CompanionManager,{state:{...base,messages:data['session-0'].slice(-3)},request,panel:'history',historyOnly:true,galgame:true,onClose(){}}));
 const dialog=await until(()=>document.querySelector('#buddy-companion-dialog[open]'),'private history');
 const scroller=dialog.querySelector('.buddy-history-main');
 await exercise(scroller,'article.buddy-message','private');
 const oldMessage=scroller.querySelector('[data-history-message-id="private-40"]');
 const newerOccurrence=scroller.querySelector('[data-history-message-id="private-90"]');
 failUnless(oldMessage?.textContent.includes('number 40')&&newerOccurrence?.textContent.includes('number 90'),'Same logical ID keeps both rendered occurrences across the page boundary');
 oldMessage.querySelector('.buddy-message-actions button:last-child').click();
 enter(await until(()=>oldMessage.querySelector('textarea'),'older message edit'),'Edited older message');
 oldMessage.querySelector('.buddy-inline-actions button').click();
 await until(()=>oldMessage.textContent.includes('Server revision preserved'),'server edits stay authoritative in an older page');
 failUnless(desired(scroller,'article.buddy-message',100),'Editing keeps previously loaded rows present');
 declineFavorite=true;
 const favorite=oldMessage.querySelector('.buddy-message-actions button:first-child');
 favorite.click();
 await until(()=>dialog.textContent.includes('Could not save fixture favorite'),'favorite refusal is visible');
 failUnless(favorite.getAttribute('aria-pressed')==='false','A failed favorite does not alter the history row');
 declineFavorite=false;
 favorite.click();
 await until(()=>oldMessage.querySelector('[aria-pressed=true]'),'older message favorite');
 failUnless(newerOccurrence.textContent.includes('number 90')&&newerOccurrence.querySelector('[aria-pressed=false]'),'The other occurrence retains its original text and favorite state');
 for(const name of ['companion-message-edit','companion-message-favorite']){
  failUnless(calls.some(([action,args])=>action===name&&args.id===repeated&&args.occurrenceId==='private-40'),'Mutation targets the chosen row occurrence');
 }
 scroller.querySelector('.buddy-history-filters [role=radiogroup] button:last-child').click();
 await until(()=>desired(scroller,'article.buddy-message',1)&&scroller.textContent.includes('Edited older message'),'entire private history favorites');
 scroller.querySelector('.buddy-history-filters [role=radiogroup] button:first-child').click();
 await until(()=>desired(scroller,'article.buddy-message',50),'unfiltered latest page');
 const side=dialog.querySelector('.buddy-sidebar-list'),historyTop=scroller.scrollTop;
 side.scrollTop=side.scrollHeight;
 const last=[...side.querySelectorAll('button')].at(-1),bounds=side.getBoundingClientRect(),lastBounds=last.getBoundingClientRect();
 failUnless(last.textContent.includes('Conversation 60')&&side.scrollTop>0&&lastBounds.top>=bounds.top&&lastBounds.bottom<=bounds.bottom+1,'The independent sidebar scroll reaches conversation 60');
 failUnless(scroller.scrollTop===historyTop,'The sidebar does not move the transcript');
 last.click();
 await until(()=>calls.some(([action,args])=>action==='companion-history-page'&&args.ownerId==='session-59'),'session 60 bounded preview');
 await until(()=>desired(scroller,'article.buddy-message',50),'session 60 recent page');
 const search=dialog.querySelector('input[type=search]');
 enter(search,'Conversation 60');
 await until(()=>calls.some(([action,args])=>action==='companion-conversation-list'&&args.search==='Conversation 60'),'title-only metadata search');
 failUnless(desired(scroller,'article.buddy-message',50),'A title-only match still opens the latest dialogue');
 enter(search,'needle');
 await until(()=>desired(scroller,'article.buddy-message',1)&&scroller.textContent.includes('number 10'),'old private search result');
 failUnless(!calls.some(([action])=>action==='companion-conversation-export'),'Read-only history never loads whole exports');
}
export async function groupHistory(root){
 style();calls.length=0;
 root.render(h('div',{className:'gx-redesign grp','data-stage-scheme':'dark'},
  h(GroupHeader,{state:{...base,activeGroupId:group.id,groupMessages:data[group.id].slice(-3)},request,galgame:true,panelRequest:{groupId:group.id,panel:'history'}})));
 const dialog=await until(()=>document.querySelector('[data-group-dialog="history"][open]'),'group history');
 const scroller=dialog.querySelector('.buddy-group-history-list');
 await exercise(scroller,'article.buddy-message','group');
 failUnless(!scroller.querySelector('[data-history-message-id="group-121"]')&&dialog.querySelector('.buddy-group-history-tools small').textContent.includes('120'),'Group pages and total exclude pending presentation');
 const search=dialog.querySelector('input[type=search]');
 enter(search,'needle');
 await until(()=>desired(scroller,'article.buddy-message',1)&&scroller.textContent.includes('number 10'),'old group search result');
}

export async function groupExportError(root){
 style();setLocale('en');
 const requestExport=(action,args)=>action==='companion-group-export'
  ?Promise.reject(Error("Error invoking remote method 'game:action': Error: 导出会话不存在"))
  :request(action,args);
 root.render(h('div',{className:'gx-redesign grp','data-stage-scheme':'dark'},
  h(GroupHeader,{state:{...base,activeGroupId:group.id,groupMessages:data[group.id].slice(-3)},request:requestExport,galgame:true,panelRequest:{groupId:group.id,panel:'history'}})));
 const dialog=await until(()=>document.querySelector('[data-group-dialog="history"][open]'),'group history export');
 const button=Array.from(dialog.querySelectorAll('button')).find(node=>node.textContent.includes('Export group history'));
 failUnless(button,'The group export command is visible in English');
 button.click();
 const error=await until(()=>dialog.querySelector('[role=alert]'),'export refusal');
 failUnless(error.textContent==='The conversation to export was not found','The public alert translates the export failure: '+error.textContent);
}
