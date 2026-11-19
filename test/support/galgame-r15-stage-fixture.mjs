import React from 'react';
import {applyAppearance} from '../../src/appearance.mjs';
import {CompanionGroupDialogue,CompanionManager} from '../../src/companion-ui.mjs';
import {GalgameCSS} from '../../src/adapted/galgame-client.ts';
import {setLocale} from '../../src/i18n.mjs';
import workspaceCss from '../../src/workspace.css';

const h=React.createElement,ids=['deepseek','claude','kimi','qwen','gpt'];
const group={id:'fixture-group',name:'群聊',mode:'natural',memberIds:ids,mutedIds:['qwen']};
const state={activeGroupId:group.id,groups:[group],groupMessages:[],characters:ids.map(id=>({id,name:id})),groupRuntime:{
 status:'generating',roundId:'round-r15',roundNumber:62,roundMembers:ids,spokenIds:['deepseek'],queue:['claude','kimi'],
},r95:{lines:[{messageId:'proactive',kind:'greeting',text:'我来看看你。',status:'presented'}]}};
function check(value,message){if(!value)throw Error(message);}
async function waitFor(predicate){
 for(let n=0;n<100;n++){const result=predicate();if(result)return result;await new Promise(resolve=>setTimeout(resolve,10));}
 throw Error('Expected stage element did not appear');
}
function prepare(){
 setLocale('zh-CN');applyAppearance({theme:'claude'});
 const style=document.createElement('style');style.textContent=workspaceCss+GalgameCSS;document.head.append(style);
}
function draw(root,current,request=async()=>({})){
 root.render(h('div',{className:'gx-redesign grp','data-stage-scheme':'dark',style:{position:'relative',width:1100,height:700}},
  h(CompanionGroupDialogue,{state:current,request,stageUi:{inputOpen:false},classic:false,galgame:true}),
  h('button',{id:'outside-round'},'外部'),
  h('span',{id:'stage-ink',style:{color:'var(--dlg-text)'}},'舞台'),
  h('span',{id:'stage-muted',style:{color:'var(--dlg-muted)'}},'舞台说明'),
 ));
}
export async function run(root){
 prepare();const calls=[];const request=async action=>{calls.push(action);};draw(root,state,request);
 const toggle=await waitFor(()=>document.querySelector('[data-group-round-toggle]'));
 check(toggle.getAttribute('aria-expanded')==='false','Round starts collapsed');toggle.click();
 const popup=await waitFor(()=>document.querySelector('.q-roundpop'));
 check(Math.abs(popup.getBoundingClientRect().width-420)<1,'Progress panel is 420 pixels wide');
 check(popup.textContent.includes('第 62 轮'),'Round number comes from runtime, beyond the rendered history page');
 const rows=[...popup.querySelectorAll('[data-group-round-member]')];
 check(rows.map(row=>row.dataset.groupRoundMember).join(',')===ids.join(','),'All members are in speaking order');
 check(rows.map(row=>row.dataset.roundStatus).join(',')==='done,busy,next,muted,waiting','Members show committed, active, next, muted and waiting states');
 check(rows.at(-1).textContent.includes('候场'),'Natural unassigned members wait');
 check(popup.querySelector('[data-companion-group-continue]').disabled,'Continue waits for the current reply');
 document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
 await waitFor(()=>!document.querySelector('.q-roundpop'));check(document.activeElement===toggle,'Escape restores toggle focus');
 toggle.click();await waitFor(()=>document.querySelector('.q-roundpop'));
 document.querySelector('#outside-round').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}));
 await waitFor(()=>!document.querySelector('.q-roundpop'));
 draw(root,{...state,groupRuntime:{...state.groupRuntime,status:'failed',canRetry:true}},request);
 toggle.click();await waitFor(()=>document.querySelector('[data-round-status="failed"]'));
 document.querySelector('.q-roundpop [data-companion-group-stop]').click();
 await waitFor(()=>calls.includes('companion-group-stop'));
}

export async function stageActions(root){
 prepare();const calls=[];
 const auto={id:'auto',status:'active',mode:'rounds',roundIndex:0,roundLimit:6,opportunityIndex:0,members:ids,pending:{characterId:'claude',status:'dispatched'}};
 draw(root,{...state,groupRuntime:{...state.groupRuntime,mode:'auto'},r95:{...state.r95,groupId:group.id,auto}},async(action,args)=>{calls.push([action,args]);return {ok:true};});
 const status=await waitFor(()=>document.querySelector('.r95-auto-state'));
 check(getComputedStyle(status.querySelector('b')).color===getComputedStyle(document.querySelector('#stage-ink')).color,'Auto speaker uses stage foreground');
 const options=[...document.querySelectorAll('[data-speech-option]')];
 check(options.length===2&&options.every(button=>button.classList.contains('ch')),'Both proactive actions use ordinary frameless choice capsules');
 check(options.map(button=>button.querySelector('kbd')?.textContent).join(',')==='1,2','Both actions keep their index badges');
 check(options.map(button=>button.textContent.trim()).join(',')==='1回她,2知道了','Action labels remain unchanged');
 options[1].click();await waitFor(()=>calls.some(([action,args])=>action==='companion-r95'&&args.action==='speech-read'));
 check(calls.length===1,'Acknowledging the proactive line sends exactly one read');
}

export async function fileExport(root){
 prepare();const actions=[];
 const history={...state,activeConversationId:'private',conversations:[{id:'private',title:'验收会话',characterId:'claude',personaId:'default',messageCount:0}],activePersonaId:'default'};
 const request=async(action,args)=>{
  if(action==='companion-conversation-export'){
   actions.push(args);
   return actions.length===1?{ok:true,cancelled:true}:{ok:true,export:{path:'C:/fixture-out/conversation.json',messageCount:0,ownerCounts:[],sha256:'a'.repeat(64)}};
  }
  return {ok:true,messages:[],totalCount:0};
 };
 let downloads=0;URL.createObjectURL=()=>{downloads++;return 'blob:test';};
 root.render(h(CompanionManager,{state:history,request,panel:'history',historyOnly:true,galgame:true}));
 const button=await waitFor(()=>[...document.querySelectorAll('button')].find(node=>node.textContent.trim()==='导出'));
 button.click();await waitFor(()=>actions.length===1);await new Promise(resolve=>setTimeout(resolve,20));
 check(!document.querySelector('#mount').textContent.includes('会话已导出。'),'Cancelling the save dialog does not report success');
 button.click();await waitFor(()=>document.querySelector('#mount').textContent.includes('会话已导出。'));
 check(actions.every(args=>Object.keys(args).length===1&&args.id==='private'),'Only the conversation identity is sent to the host');
 check(downloads===0,'The renderer does not create or download a JSON blob');
}
