import React,{useState,useEffect,useRef} from 'react';
import {t,locale} from './i18n.mjs';
import {Icon} from './ui-icons.mjs';
import {Tabs,CheckSwitch,Segmented,EmptyState} from './ui-controls.mjs';
import {themeAsset} from './appearance.mjs';
import {PET_CHARACTERS} from './pet-characters.mjs';
import {TOOL_NAMES} from './token-types.mjs';
import {zoneOptions,zoneDay,intlTimeZone} from './preferences.mjs';
const h=React.createElement;
const requestId=()=>globalThis.crypto.randomUUID();
const english=()=>locale()==='en',lang=()=>english()?'en-US':'zh-CN',L=(zh,en)=>english()?en:zh;
// Built-in characters show their name; a custom character shows the name Core sends (characterName), never a raw id.
export const characterName=id=>{const row=PET_CHARACTERS.find(c=>c.id===id);return row?t(row.name):null;};
const displayName=view=>view.characterName??characterName(view.activeScope?.characterId)??t('当前角色');
// English singular/plural: the singular key is the Chinese text with 1 written out, so Chinese reads the same either way.
const plural=(n,one,many)=>(english()&&n===1?t(one):t(many)).replaceAll('{n}',n);
const PLURAL_UNITS={bowl:'bowls',portion:'portions',box:'boxes',plate:'plates','small portion':'small portions',cup:'cups',item:'items'};
export const unitLabel=(food,count=food.portions)=>{const word=t(food.unit);return count+' '+(english()&&count!==1?PLURAL_UNITS[word]??word:word);};
const pointWord=n=>english()?(n===1?'point':'points'):t('积分');
// Shop & backpack (approved design C1 投喂台, C2, C3, C4). Every control still sends the same actions:
// buy (one package, requestId), feed (one portion, requestId), settings, auto, retry-meal and ledger paging.
const DRINKS=new Set(['milk','juice']);
export const foodCategory=food=>DRINKS.has(food.id)?'drink':food.restore>=50?'meal':food.restore>=35?'main':'snack';
const CATEGORIES=[['main','主食'],['meal','正餐'],['snack','点心'],['drink','饮品']];
// The word and the number both come from the rounded fullness, so 99.6 never reads "100 / 100 · Not hungry".
export const roundedFullness=view=>Number.isFinite(view?.hunger?.satiety)?Math.round(view.hunger.satiety):null;
export const fullnessLabel=value=>value>=100?t('吃饱了'):value>=60?t('还不饿'):value>20?t('有点饿'):t('饿了');
// Her line on the shop stage comes from these local templates; nothing here calls a model.
const stageLine=(value,food)=>food?t('{food}！是给我的吗？').replace('{food}',t(food.name)):value==null?t('先在 Galgame 里选一位角色，再来给她买吃的。'):value>=100?t('吃饱啦，现在什么都吃不下了。'):value>=60?t('现在还不饿，不过看看也好。'):value>20?t('有点饿了，闻到好香的味道。'):t('肚子在叫了……能给我点吃的吗？');
// Times follow the app's statistics time zone; 'local' (the default) is the system zone.
const clock=(at,zone)=>new Date(at).toLocaleTimeString(lang(),{hour:'2-digit',minute:'2-digit',hour12:false,...zoneOptions(zone)});
const ZONE_NAMES={'America/New_York':'纽约时间','Asia/Shanghai':'北京时间'};
export const zoneName=zone=>{const id=intlTimeZone(zone);return !id?t('本机时区'):ZONE_NAMES[id]?t(ZONE_NAMES[id]):id;};
export function dayLabel(at,zone,now=Date.now()){
 const today=zoneDay(now,zone),day=zoneDay(at,zone),yesterday=new Date(Date.parse(today+'T12:00:00Z')-86400000).toISOString().slice(0,10);
 const date=new Date(at).toLocaleDateString(lang(),{month:english()?'short':'long',day:'numeric',...(day.slice(0,4)!==today.slice(0,4)?{year:'numeric'}:{}),...zoneOptions(zone)});
 return day===today?t('今天 · {date}').replace('{date}',date):day===yesterday?t('昨天 · {date}').replace('{date}',date):date;
}
// Reward rows name the tool the usage came from: canonical request ids start with the tool id (usage-reward-outbox).
export function rewardTool(row){const id=String(row?.requestId??'');if(row?.basis==='cg-fallback'||id.startsWith('cg:'))return t('CG 生成');const tool=id.includes(':')?id.slice(0,id.indexOf(':')):'';return Object.hasOwn(TOOL_NAMES,tool)?t(TOOL_NAMES[tool]):null;}
// A paused auto-meal says why in plain words; the backend's own message stays in the tooltip.
export function autoPauseText(session,view){
 const rice=(view.catalog??[]).find(food=>food.id==='rice')?.price??2,limit=view.settings?.dailyAutoPurchaseLimit,balance=view.wallet?.balance??0;
 switch(session?.reason){
  case 'AUTO_PURCHASE_DAILY_LIMIT':return t('今天自动买东西已经花到上限 {n} 积分。明天会恢复；也可以提高上限后重新检查。').replace('{n}',limit);
  case 'INSUFFICIENT_POINTS':return t('积分不够买一碗米饭（要 {p} 积分，现在 {b} 积分）。攒够以后重新检查。').replace('{p}',rice).replace('{b}',balance);
  case 'AUTO_NO_FOOD':case 'AUTO_PURCHASE_NOT_ALLOWED':return t('背包里没有允许她自己吃的食物，也没有打开自动买米饭。补点食物、多允许几样，或打开自动买米饭后重新检查。');
  case 'AUTO_FOOD_NOT_ALLOWED':return t('「饿了自己吃」刚被关掉，这一餐停下了。');
  case 'AUTO_FOOD_CHOICE_UNAVAILABLE':case 'AUTO_FOOD_CHOICE_INVALID':return t('她要从允许的食物里自己挑一样，这次没挑成；需要联网聊天开着。');
  case 'FOOD_DIETARY_RESTRICTION':return t('允许的食物里有她不能吃的，这一餐停下了。');
  default:return t('这一餐没能继续，可以稍后重新检查。');
 }
}
export function FoodArt({food,size=86}){
 const [missing,setMissing]=useState(false);
 return h('span',{className:'feed-plate'+(missing?' ph':''),style:{'--ps':size+'px'},'aria-hidden':true},missing?h('b',{style:{fontSize:Math.round(size*.34)}},t(food.name).slice(0,1)):h('img',{src:'./assets/food/'+food.id+'.webp',alt:'',loading:'lazy',draggable:false,onError:()=>setMissing(true)}));
}
const face=id=>h('img',{className:'feed-face',src:'./'+themeAsset(id||'deepseek','head.webp'),alt:'',draggable:false});
function Wallet({view,compact=false,spent=null}){
 const wallet=view.wallet??{},hunger=roundedFullness(view),character=displayName(view),next=Math.max(0,10000-(wallet.remainder??0)),balance=wallet.balance??0;
 return h('div',{className:'feed-wallet'+(compact?' compact':'')},
  h('div',{className:'feed-points'},h('span',{className:'feed-coin'},Icon('coin',{size:20})),h('div',null,h('span',{className:'feed-kv'},h('b',{className:'feed-big','data-feed-balance':true},balance),h('span',null,pointWord(balance)),spent&&h('span',{key:spent.at,className:'feed-delta feed-delta-float','aria-hidden':true},'−'+spent.n)),
   !compact&&h('div',{className:'feed-next'},h('span',{className:'ws-meter'},h('b',{style:{width:Math.min(100,(wallet.remainder??0)/100)+'%'}})),h('small',null,t('再攒 {n} 奖励量得下 1 积分').replace('{n}',next.toLocaleString(lang())))))),
  h('span',{className:'feed-div','aria-hidden':true}),
  h('div',{className:'feed-char'},view.activeScope?face(view.activeScope.characterId):h('span',{className:'feed-face empty'},Icon('person',{size:20})),h('div',null,
   h('b',null,view.activeScope?(character+(hunger!=null?' · '+fullnessLabel(hunger):'')):t('还没有选角色')),
   hunger!=null&&h('div',{className:'feed-sat'+(hunger<=20?' low':'')},h('span',{className:'ws-meter',role:'meter','aria-valuemin':0,'aria-valuemax':100,'aria-valuenow':hunger,'aria-label':t('饱食')},h('b',{style:{width:Math.min(100,hunger)+'%'}})),h('small',null,t('饱食 {n} / 100').replace('{n}',hunger))),
   view.paused&&h('small',{role:'status'},t('当前进食计时已暂停。')))),
  !compact&&h('details',{className:'feed-why'},h('summary',{'aria-label':t('积分是怎么来的'),title:t('积分是怎么来的')},Icon('info',{size:16})),h('div',{className:'feed-why-pop'},h('b',null,t('积分是怎么来的')),h('p',null,t('积分来自你在本机 AI 工具里的用量奖励，每攒满 10000 奖励量得 1 积分；历史用量不重复发奖。')),wallet.debtUnits>0&&h('p',{role:'status'},t('有用量修订差额：将从后续奖励里扣回 {n} 奖励量。').replace('{n}',wallet.debtUnits.toLocaleString(lang()))))));
}
function Notices({view}){return h(React.Fragment,null,!view.rewardsInitialized&&h('div',{className:'ui-note',role:'status'},Icon('clock',{size:16}),h('div',null,t('正在建立奖励起算水位，历史用量不重复发奖。'))));}
export function FeedingPage({view,onAction,initialTab='shop',timeZone,onPage,now=Date.now()}){
 const [tab,setTab]=useState(initialTab),[pending,setPending]=useState(false),[error,setError]=useState(''),[cap,setCap]=useState(''),[unlimited,setUnlimited]=useState(true),[ledger,setLedger]=useState(null),[category,setCategory]=useState('all'),[bought,setBought]=useState(null),[picked,setPicked]=useState(null),[saved,setSaved]=useState(false),[kind,setKind]=useState('all'),[zero,setZero]=useState(false);
 const preferences=view?.settings??{},toastTimer=useRef(null);
 useEffect(()=>{setUnlimited(preferences.dailyAutoPurchaseLimit==='unlimited');setCap(preferences.dailyAutoPurchaseLimit==='unlimited'?'':String(preferences.dailyAutoPurchaseLimit??''));},[preferences.dailyAutoPurchaseLimit]);
 useEffect(()=>()=>clearTimeout(toastTimer.current),[]);
 const act=async(name,args={})=>{if(pending)return false;setPending(true);setError('');try{await onAction(name,args);return true;}catch(cause){setError(cause.message??String(cause));return false;}finally{setPending(false);}};
 const save=async args=>{setSaved(false);if(await act('settings',args)){setSaved(true);clearTimeout(toastTimer.current);toastTimer.current=setTimeout(()=>setSaved(false),2400);}};
 const loadLedger=async page=>{if(pending)return;setPending(true);setError('');try{const result=await onAction('ledger',{page,pageSize:100});if(!result||!Array.isArray(result.rows))throw Error(t('积分流水返回格式无效'));setLedger(result);}catch(cause){setError(cause.message??String(cause));}finally{setPending(false);}};
 if(!view)return h('div',{className:'ws-page feed-page','aria-busy':true},h('div',{className:'feed-loading',role:'status'},h('span',{className:'ui-spinner','aria-hidden':true}),t('正在读取商店与背包…')));
 const catalog=view.catalog??[],active=!!view.activeScope&&!view.paused,inventory=view.inventory??{},hunger=roundedFullness(view),full=hunger!=null&&hunger>=100,balance=view.wallet?.balance??0;
 const owned=catalog.filter(food=>(inventory[food.id]??0)>0),ownedCount=owned.reduce((n,food)=>n+(inventory[food.id]??0),0);
 const reason=!view.activeScope?t('先在 Galgame 里选一位角色'):view.paused?t('进食计时暂停中'):null;
 const buy=async food=>{if(await act('buy',{foodId:food.id,packages:1,requestId:requestId()})){setBought({food,at:Date.now()});clearTimeout(toastTimer.current);toastTimer.current=setTimeout(()=>setBought(null),6000);}};
 const feed=food=>act('feed',{foodId:food.id,requestId:requestId()});
 const tabs=[['shop',t('商店'),'nav-shop'],['inventory',t('背包')+(ownedCount?' '+ownedCount:''),'nav-bag'],['settings',t('自动吃饭'),'clock'],['ledger',t('积分流水'),'coin']];
 const head=h('div',{className:'ws-page-head'},h('div',null,h('h2',{className:'ws-ptitle'},t('商店与背包')),h('p',{className:'ws-meta'},t('积分和食品库存由所有身份共用，角色读档不会回滚。'))),onPage&&h('div',{className:'ws-row-btns'},h('button',{type:'button',className:'ui-btn ghost',onClick:()=>onPage('galgame')},Icon('chats',{size:16}),t('返回聊天'))));
 const chips=food=>h('span',{className:'feed-chips'},h('span',{className:'feed-chip ok','aria-label':t('单份恢复')+' +'+food.restore,title:t('单份恢复')+' +'+food.restore},'+'+food.restore),h('span',{className:'feed-chip'},unitLabel(food)));
 let body;
 if(tab==='shop'){
  const shown=category==='all'?catalog:catalog.filter(food=>foodCategory(food)===category);
  const recent=[...new Map((view.meals??[]).filter(meal=>meal.scope?.characterId===view.activeScope?.characterId).slice(0,6).map(meal=>[meal.foodId,catalog.find(food=>food.id===meal.foodId)])).values()].filter(Boolean).slice(0,3);
  const stage=h('section',{className:'ws-card feed-stage'},h('div',{className:'feed-stage-art'},view.activeScope&&h('img',{className:'feed-port',src:'./'+themeAsset(view.activeScope.characterId,'portrait.webp'),alt:'',draggable:false})),
   h('div',{className:'feed-say',role:'status','aria-live':'polite'},stageLine(hunger,bought?.food)),
   recent.length>0&&h('div',{className:'feed-stage-foot'},h('small',null,t('她最近爱吃')),h('span',{className:'feed-row'},...recent.map(food=>h(FoodArt,{key:food.id,food,size:30})))));
  const card=food=>{const short=balance<food.price;return h('article',{className:'feed-food',key:food.id,'data-food':food.id},h(FoodArt,{food}),h('b',{className:'feed-food-n'},t(food.name)),chips(food),
   short?h('button',{type:'button',className:'ui-btn sm feed-price short',disabled:true,title:t('积分不够')},plural(food.price-balance,'还差 1 积分','还差 {n} 积分'))
    :h('button',{type:'button',className:'ui-btn sm feed-price',disabled:pending||!active,title:reason??undefined,'aria-label':t('购买一包')+' · '+t(food.name)+' · '+food.price+' '+pointWord(food.price),onClick:()=>buy(food)},Icon('coin',{size:14}),food.price));};
  body=h(React.Fragment,null,h('div',{className:'feed-grid'},stage,h('div',{className:'feed-col'},
   h('div',{className:'feed-cats',role:'group','aria-label':t('食物分类')},h('button',{type:'button',className:'ws-chip','aria-pressed':category==='all',onClick:()=>setCategory('all')},t('全部'),h('span',null,catalog.length)),...CATEGORIES.map(([key,label])=>h('button',{key,type:'button',className:'ws-chip','aria-pressed':category===key,onClick:()=>setCategory(key)},t(label),h('span',null,catalog.filter(food=>foodCategory(food)===key).length)))),
   reason&&h('div',{className:'ui-note',role:'status'},Icon('info',{size:16}),h('div',null,reason)),
   h('div',{className:'feed-foods'},...shown.map(card)))),
   bought&&h('div',{className:'feed-toast ui-toast',role:'status'},Icon('check',{size:18}),h('div',null,h('b',null,t('{food}放进背包了（{n}）').replace('{food}',t(bought.food.name)).replace('{n}',unitLabel(bought.food))),h('small',null,plural(bought.food.price,'−1 积分 · 剩 {b} 积分','−{n} 积分 · 剩 {b} 积分').replace('{b}',balance))),h('span',{className:'feed-delta','aria-hidden':true},'−'+bought.food.price),
    h('button',{type:'button',className:'ui-btn sm primary',disabled:pending||!active||full,onClick:async()=>{if(await feed(bought.food))setBought(null);}},t('现在喂她'))));
 }else if(tab==='inventory'){
  const current=picked&&owned.find(food=>food.id===picked)||owned[0];
  // view.meals is newest first (companion-economy-store view()); every pending meal of this life keeps its retry, as before.
  // 「今天吃过」 lists today's meals only, by the app time zone.
  const lifeMeals=(view.meals??[]).filter(meal=>meal.scope?.characterId===view.activeScope?.characterId&&meal.scope?.lifeId===view.activeScope?.lifeId),today=zoneDay(now,timeZone),todays=lifeMeals.filter(meal=>Number.isFinite(meal.at)&&zoneDay(meal.at,timeZone)===today),meals=todays.slice(0,8);
  const preview=current&&hunger!=null?Math.min(100,hunger+current.restore):null,foodName=meal=>{const food=catalog.find(row=>row.id===meal.foodId);return food?t(food.name):t('一份食物');};
  const side=h('aside',{className:'ws-card feed-side'},h('div',{className:'feed-row'},view.activeScope?face(view.activeScope.characterId):h('span',{className:'feed-face empty'},Icon('person',{size:20})),h('div',null,h('b',null,view.activeScope?t('喂给 {name}').replace('{name}',displayName(view)):t('还没有选角色')),h('small',null,t('只喂当前角色和当前人生')))),
   hunger!=null&&h('div',{className:'feed-sat'},h('span',{className:'ws-meter'},h('b',{style:{width:Math.min(100,hunger)+'%'}}),preview!=null&&preview>hunger&&h('i',{className:'feed-sat-add',style:{left:Math.min(100,hunger)+'%',width:(preview-hunger)+'%'}})),h('small',null,preview!=null&&preview>hunger?t('饱食 {a} → {b}').replace('{a}',hunger).replace('{b}',preview):t('饱食 {n} / 100').replace('{n}',hunger))),
   meals.length>0&&h(React.Fragment,null,h('h4',{className:'ws-sub-h'},t('今天吃过')),...meals.map(meal=>{const food=catalog.find(row=>row.id===meal.foodId),pend=meal.affectionState==='pending',restored=Number.isFinite(meal.restored)?meal.restored:food?.restore;return h('div',{key:meal.id,className:'feed-meal'+(pend?' pend':'')},h('small',{className:'feed-tnum'},clock(meal.at,timeZone)),food&&h(FoodArt,{food,size:30}),h('span',{className:'feed-trunc'},foodName(meal),restored!=null&&h(React.Fragment,null,' ',h('span',{className:'feed-ok'},'+'+restored))),h('span',{className:'feed-stamp'+(pend?' pend':'')},pend?t('好感结算中'):t('好感已结算')));}),
    todays.length>meals.length&&h('small',{className:'feed-more'},plural(todays.length-meals.length,'今天还有 1 餐没列出','今天还有 {n} 餐没列出'))),
   ...lifeMeals.filter(meal=>meal.affectionState==='pending').map(meal=>h('div',{key:'r'+meal.id,className:'ui-note',role:'status',title:meal.error?String(meal.error):undefined},Icon('clock',{size:16}),h('div',null,h('b',null,t('{food}已经吃下了，好感还没算上。').replace('{food}',foodName(meal))),' ',t('通常几秒内完成；连接恢复后会自动再试。'),' ',h('button',{type:'button',className:'ui-btn sm ghost',disabled:pending||!active,onClick:()=>act('retry-meal',{mealId:meal.id})},t('现在重试'))))));
  body=owned.length?h('div',{className:'feed-inv'},h('div',{className:'feed-foods inv'},...owned.map(food=>h('article',{key:food.id,className:'feed-food inv'+(current?.id===food.id?' sel':''),'data-food':food.id,onClick:()=>setPicked(food.id)},h('span',{className:'feed-badge'},'×'+inventory[food.id]),h(FoodArt,{food,size:80}),h('b',{className:'feed-food-n'},t(food.name)),h('span',{className:'feed-chips'},h('span',{className:'feed-chip ok','aria-label':t('单份恢复')+' +'+food.restore},'+'+food.restore)),
    h('button',{type:'button',className:'ui-btn sm'+(current?.id===food.id?' primary':''),disabled:pending||!active||full,title:reason??undefined,onClick:event=>{event.stopPropagation();void feed(food);}},Icon('heart',{size:14}),full?t('她吃饱了'):t('喂她一份'))))),side)
   :h('div',{className:'feed-inv'},h('div',{className:'ws-card'},h(EmptyState,{icon:'nav-bag',title:t('背包里还没有食物'),action:h('button',{type:'button',className:'ui-btn primary',onClick:()=>setTab('shop')},Icon('nav-shop',{size:16}),t('去商店'))},t('去商店买点什么，买到的会放在这里。'))),side);
 }else if(tab==='settings'){
  const allowed=new Set(preferences.allowedFoods??[]),setAllowed=list=>save({allowedFoods:[...new Set(list)]});
  const scale=h('div',{className:'feed-thr'},h('div',{className:'feed-thr-bar','aria-hidden':true},h('i',{className:'feed-thr-low',style:{width:'20%'}}),h('i',{className:'feed-thr-fill',style:{left:'20%',width:'50%'}}),hunger!=null&&h('b',{className:'feed-thr-now',style:{left:Math.min(100,hunger)+'%'}})),h('div',{className:'feed-thr-lbl'},h('span',{style:{left:'20%'}},'20 · '+t('开始吃')),h('span',{style:{left:'70%'}},'70 · '+t('吃到这里停')),hunger!=null&&h('span',{className:'feed-thr-cur',style:{left:Math.min(100,hunger)+'%'}},t('现在 {n}').replace('{n}',hunger))));
  const capValid=unlimited||cap!==''&&Number.isSafeInteger(Number(cap))&&Number(cap)>=0;
  const saveCap=()=>{if(capValid)void save({dailyAutoPurchaseLimit:unlimited?'unlimited':Number(cap)});};
  const session=view.autoSession,recheckBlocked=pending||!active||!preferences.autoEat;
  body=h('div',{className:'feed-set2'},h('article',{className:'ws-card ws-set'},h('h3',{className:'ws-sec'},t('自动吃饭')),
   h('div',{className:'ws-srow'},h('div',null,h('b',null,t('饿了自己吃')),h('small',null,t('饱食降到 20 或更低时开始吃，吃到至少 70；只吃下面允许的食物。'))),h(CheckSwitch,{checked:preferences.autoEat===true,disabled:pending,label:t('自动吃饭'),onChange:value=>save({autoEat:value})})),scale,
   h('div',{className:'ws-srow'},h('div',null,h('b',null,t('没有食物时自动买一碗米饭')),h('small',null,t('每次只买一碗，每碗 2 积分，不会透支；要先打开「饿了自己吃」并允许吃米饭。'))),h(CheckSwitch,{checked:preferences.autoBuyRice===true,disabled:pending,label:t('允许自动补买米饭'),onChange:value=>save({autoBuyRice:value})})),
   h('div',{className:'ws-srow'},h('div',null,h('b',null,t('每天自动买东西最多花')),h('small',null,t('只算自动采购，自己买的不算。'))),h('div',{className:'feed-row'},h(Segmented,{label:t('每日自动采购积分上限'),value:unlimited?'unlimited':'cap',disabled:pending,options:[['unlimited',t('不限')],['cap',L('最多','Up to')]],onChange:value=>{const next=value==='unlimited';setUnlimited(next);if(next)void save({dailyAutoPurchaseLimit:'unlimited'});}}),
    !unlimited&&h('label',{className:'ws-inp feed-num'},h('input',{type:'number',min:0,step:1,value:cap,'aria-label':t('每日自动采购积分上限'),disabled:pending,onChange:e=>setCap(e.target.value),onBlur:saveCap,onKeyDown:e=>{if(e.key==='Enter')saveCap();}}),h('span',null,pointWord(Number(cap)))))),
   (saved||!capValid)&&h('div',{className:'ws-srow ws-end'},saved&&h('span',{className:'ws-saved',role:'status'},Icon('check',{size:14}),t('已保存')),!capValid&&h('small',{className:'feed-err'},t('上限要是 0 或正整数')))),
  h('div',{className:'feed-col'},session?.state==='blocked'&&h('div',{className:'ui-alert warn',role:'status','data-feed-paused':session.reason??'',title:session.error?String(session.error):undefined},Icon('alert',{size:16}),h('div',null,h('b',null,t('这一餐暂停了')),h('p',null,autoPauseText(session,view)),
    h('div',{className:'ws-row-btns'},h('button',{type:'button',className:'ui-btn sm',disabled:recheckBlocked,title:!preferences.autoEat?t('先打开「饿了自己吃」'):reason??undefined,onClick:()=>act('auto')},Icon('refresh',{size:14}),t('重新检查这一餐'))))),
   h('article',{className:'ws-card ws-set'},h('div',{className:'feed-between'},h('h3',{className:'ws-sec'},t('允许自动吃的食物')),h('span',{className:'ws-tag'},t('已选 {n} / {m}').replace('{n}',catalog.filter(food=>allowed.has(food.id)).length).replace('{m}',catalog.length))),
    ...CATEGORIES.map(([key,label])=>{const foods=catalog.filter(food=>foodCategory(food)===key);return h('div',{key,className:'feed-allow'},h('div',{className:'feed-between'},h('b',null,t(label)),h('span',{className:'feed-row'},h('button',{type:'button',className:'ui-btn ghost sm',disabled:pending,onClick:()=>setAllowed([...allowed,...foods.map(food=>food.id)])},t('全选')),h('button',{type:'button',className:'ui-btn ghost sm',disabled:pending,onClick:()=>setAllowed([...allowed].filter(id=>!foods.some(food=>food.id===id)))},t('清空')))),
     h('div',{className:'feed-allow-g'},...foods.map(food=>h('button',{key:food.id,type:'button',className:'ws-chip feed-fchip','aria-pressed':allowed.has(food.id),disabled:pending,onClick:()=>setAllowed(allowed.has(food.id)?[...allowed].filter(id=>id!==food.id):[...allowed,food.id])},h(FoodArt,{food,size:22}),h('span',{className:'feed-trunc'},t(food.name))))));}))));
 }else{
  const data=ledger??{page:1,pageSize:100,total:view.ledgerTotal??view.ledger?.length??0,rows:view.ledger??[]},rows=data.rows;
  const KIND={'reward-revision':['sparkle',L('奖励','Reward'),'reward'],purchase:['nav-shop',L('购买','Purchase'),'purchase'],meal:['bowl',L('吃饭','Meal'),'meal']};
  const delta=(row,index)=>{if(row.kind==='purchase'&&row.cost!=null)return -row.cost;if(row.kind==='meal')return null;const next=rows[index+1];return row.wallet&&next?.wallet&&Number.isFinite(row.wallet.balance)&&Number.isFinite(next.wallet.balance)?row.wallet.balance-next.wallet.balance:null;};
  const visible=rows.map((row,index)=>({row,index})).filter(({row})=>(kind==='all'||KIND[row.kind]?.[2]===kind)&&(zero||!(row.kind==='reward-revision'&&!row.deltaUnits)));
  const hidden=rows.filter(row=>row.kind==='reward-revision'&&!row.deltaUnits).length;
  let day='';const body2=[];
  for(const {row,index} of visible){const d=dayLabel(row.at,timeZone,now);if(d!==day){day=d;body2.push(h('tr',{key:'d'+index,className:'feed-day'},h('td',{colSpan:5},d)));}
   const food=catalog.find(f=>f.id===row.foodId),k=KIND[row.kind],change=delta(row,index),name=food?t(food.name):row.foodId??'',packages=row.packages??1,tool=row.kind==='reward-revision'?rewardTool(row):null;
   const detail=row.kind==='purchase'?plural(packages,'{food} 1 包（{u}）','{food} {n} 包（{u}）').replace('{food}',name).replace('{u}',food?unitLabel(food,row.portions??food.portions*packages):'')
    :row.kind==='meal'?h(React.Fragment,null,row.scope?.characterId?t('{food} · 喂给 {name}').replace('{food}',name).replace('{name}',(row.scope.characterId===view.activeScope?.characterId?view.characterName:null)??characterName(row.scope.characterId)??t('当前角色')):name,' ',h('span',{className:'feed-ok'},t('饱食')+' +'+(row.restored??0)))
    :row.deltaUnits<0?t('用量修订：扣回多发的奖励'):h(React.Fragment,null,tool?t('{tool} 用量奖励').replace('{tool}',tool):t('用量奖励'),row.deltaUnits?h('small',{className:'feed-sub'},' · '+t('{n} 奖励量').replace('{n}',row.deltaUnits.toLocaleString(lang()))):null);
   body2.push(h('tr',{key:index},h('td',{className:'m feed-tnum'},clock(row.at,timeZone)),h('td',null,h('span',{className:'feed-kind '+(k?.[2]??'')},k&&Icon(k[0],{size:14}),k?k[1]:L('其他','Other')),row.automatic&&h('span',{className:'ws-tag'},t('自动'))),h('td',null,detail),h('td',{className:'r '+(change>0?'feed-ok':change<0?'feed-err':'m')},change==null?'—':(change>0?'+':'')+change),h('td',{className:'r feed-tnum'},row.wallet?.balance??'—')));}
  body=h(React.Fragment,null,h('div',{className:'feed-between'},h('div',{className:'feed-row',role:'group','aria-label':t('积分流水')},...[['all','全部'],['reward','奖励'],['purchase','购买'],['meal','吃饭']].map(([key,label])=>h('button',{key,type:'button',className:'ws-chip','aria-pressed':kind===key,onClick:()=>setKind(key)},t(label)))),h('label',{className:'feed-row feed-sm'},h(CheckSwitch,{checked:zero,label:t('显示 0 变动的用量修订'),onChange:setZero}),t('显示 0 变动的用量修订'))),
   h('article',{className:'ws-card feed-ledger'},h('div',{className:'feed-tw'},h('table',null,h('thead',null,h('tr',null,h('th',null,t('时间（{zone}）').replace('{zone}',zoneName(timeZone))),h('th',null,t('类型')),h('th',null,t('明细')),h('th',{className:'r'},t('积分变动')),h('th',{className:'r'},t('余额')))),h('tbody',null,...body2))),
    !visible.length&&h('p',{className:'feed-empty-row'},hidden&&!zero&&kind!=='purchase'&&kind!=='meal'?t('这一页只有 0 变动的用量修订，已经隐藏。'):t('这一页没有符合条件的记录。')),
    h('div',{className:'feed-pager'},h('small',null,plural(data.total,'共 1 条记录','共 {n} 条记录')+(hidden&&!zero?' · '+t('本页隐藏了 {n} 条 0 变动修订').replace('{n}',hidden):'')),h('span',{className:'feed-grow'}),h('button',{type:'button',className:'ui-icon-btn feed-prev','aria-label':t('上一页'),title:t('上一页'),disabled:pending||data.page<=1,onClick:()=>loadLedger(data.page-1)},Icon('chevron',{size:16})),h('span',{className:'feed-tnum'},data.page+' / '+Math.max(1,Math.ceil(data.total/data.pageSize))),h('button',{type:'button',className:'ui-icon-btn feed-next','aria-label':t('下一页'),title:t('下一页'),disabled:pending||data.page*data.pageSize>=data.total,onClick:()=>loadLedger(data.page+1)},Icon('chevron',{size:16})),h('button',{type:'button',className:'ui-icon-btn','aria-label':t('刷新'),title:t('刷新'),disabled:pending,onClick:()=>loadLedger(data.page)},Icon('refresh',{size:16})))));
 }
 return h('div',{className:'ws-page feed-page'},head,h(Wallet,{view,compact:tab==='settings'||tab==='ledger',spent:bought?{n:bought.food.price,at:bought.at}:null}),h(Notices,{view}),
  h(Tabs,{tabs,active:tab,onSelect:setTab,label:t('商店与背包'),idPrefix:'feed-tab'}),
  error&&h('div',{className:'ui-alert warn',role:'alert'},Icon('alert',{size:16}),h('div',null,error)),
  h('section',{className:'feed-panel',role:'tabpanel',id:'feed-tab-'+tab},body));
}
