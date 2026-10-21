import {createHash} from 'node:crypto';
import {CHARACTER_CATALOG} from './character-catalog.mjs';
import {englishThemePool,EN_COMPOSITIONS} from './cg-theme-english.mjs';
import {CG_POV_RULES,constrainCgPrompt,validPovTheme} from './cg-composition.mjs';
export const THEME_VERSION=5;
const keys=['title','scene','action','expression','composition','lighting','keepsake'];
const normalize=s=>String(s||'').toLowerCase().replace(/[\s\p{P}\p{N}]/gu,'');
const grams=s=>{s=normalize(s);return new Set(Array.from({length:Math.max(0,s.length-1)},(_,i)=>s.slice(i,i+2)));};
function similar(a,b){if(normalize(a)===normalize(b))return true;const x=grams(a),y=grams(b);return x.size&&y.size&&[...x].filter(v=>y.has(v)).length/Math.min(x.size,y.size)>.7;}
export function distinctTheme(theme,history=[]){return !history.some(old=>old?.scene&&['scene','action','composition'].filter(k=>similar(theme[k],old[k])).length>=2);}
export function parseTheme(text,history=[]){
 let value;try{value=JSON.parse(String(text).trim().replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,''));}catch{return null;}
 if(!value||!validPovTheme(value)||keys.some(k=>typeof value[k]!=='string'||value[k].trim().length<2||value[k].length>400))return null;
 const theme={...Object.fromEntries(keys.map(k=>[k,value[k].trim()])),camera:value.camera,viewerHands:value.viewerHands};return distinctTheme(theme,history)?theme:null;
}
const scenes=['清晨海岸的灯塔平台','漂浮水母照亮的玻璃步道','雨后的花园温室','星空下的帆船甲板','洒满落叶的林间茶亭','海边小镇的节庆广场','雪夜的壁炉阅览室','潮汐退去后的贝壳沙滩','晨雾中的山顶观景台','玻璃穹顶下的天文台','开满蓝花的庭院','极光映照的冰湖岸边'];
const actions=['双手递上一封封蜡信笺','侧身挂起一串手作风铃','俯身整理刚采下的鲜花','举起小灯照亮回家的路','轻轻展开一幅旅行地图','坐在长凳上分享野餐篮','回头邀请对方一起观星','捧起刚做好的鲸鱼形点心','踮脚把纪念物系在树枝上','端起热茶示意对方休息','蹲下观察水面的小纸船'];
const compositions=['男生眼睛所见的远景，女角色完整全身位于左三分之一，环境展开','男生第一人称平视，女角色完整全身位于右侧，前景花叶形成层次','男生第一人称，女角色侧身看向镜头的中景，道路形成纵深','男生第一人称坐姿低机位，女角色完整全身，天空在上半部','男生第一人称站姿略俯中景，女角色面向镜头，纪念物在前景','男生第一人称看向女角色完整全身，对角线构图与远灯呼应','男生第一人称沿栏杆看去，女角色完整全身回眸望向镜头'];
export function localTheme(brief,history=[]){
 if(brief.kind==='group')return {title:brief.groupName||'群聊纪念',scene:brief.scene?.description||'月夜图书室',action:'参与本次交流的角色一起回顾刚聊过的事情，各自保持符合性格的表情和互动',expression:'结合下述实际对话呈现自然神态',composition:'男性第一人称看向全部参与的女性角色，按空间层次安排，彼此互动',lighting:'符合场景的柔和环境光',keepsake:'实际交流内容：'+JSON.stringify(brief.recentContext).slice(-5000),camera:'male-first-person',viewerHands:0,source:'local',version:THEME_VERSION};

 if(brief.language==='en'){
  const p=englishThemePool(brief.charId),level=Math.max(1,Math.floor(brief.level||1)),offset=createHash('sha256').update(String(brief.charId)).digest()[0];
  for(let step=0;step<160;step++){const n=level-1+step,theme={title:`Chapter ${level} · ${['A small promise','A shared discovery','A day to remember','A quiet celebration'][Math.floor(n/4)%4]}`,scene:p.scenes[(n+offset)%4],action:p.actions[(Math.floor(n/4)+n+offset)%4],composition:EN_COMPOSITIONS[(n+offset)%5],expression:['a shy, hopeful smile','a relaxed, bright smile','gentle concentration','surprised and slightly bashful'][n%4],lighting:['soft morning light','warm sidelight with cool surroundings','moonlight and small lanterns','diffuse light after rain'][Math.floor(n/3)%4],keepsake:p.keepsakes[(n+offset)%4]+' marking the time spent together'};if(distinctTheme(theme,history))return {...theme,camera:'male-first-person',viewerHands:0,source:'local',version:THEME_VERSION};}
  throw Error('Unable to choose a distinct CG theme');
 }
 const pool=CHARACTER_CATALOG[brief.charId]?.themePool;
 const roleScenes=pool?.scenes||scenes,roleActions=pool?.actions||actions.map(a=>a.replace('鲸鱼形','手作'));
 const level=Math.max(1,Math.floor(brief.level||1)),offset=createHash('sha256').update(String(brief.charId)).digest()[0];
 for(let step=0;step<roleScenes.length*roleActions.length*compositions.length;step++){
  const n=level-1+step,theme={title:`第 ${level} 页 · ${['初识的礼物','一起走过的风景','日常的小约定','值得收藏的时刻'][Math.floor(n/12)%4]}`,scene:roleScenes[(n+offset)%roleScenes.length],action:roleActions[(Math.floor(n/roleScenes.length)+n+offset)%roleActions.length],composition:compositions[(n+offset)%compositions.length],expression:['含蓄而期待的微笑','放松明亮的笑容','认真专注而温柔','惊喜后带一点羞涩'][n%4],lighting:['柔和晨光和清晰空气感','温暖侧光与冷色环境光','月光和细小灯光形成轮廓','雨后散射光与地面反射'][Math.floor(n/3)%4],keepsake:`${pool?.keepsakes[(n+offset)%pool.keepsakes.length]||'手作纪念物'}，象征相伴到第 ${level} 阶段`};
  if(distinctTheme(theme,history))return {...theme,camera:'male-first-person',viewerHands:0,source:'local',version:THEME_VERSION};
 }throw Error('无法选择新的 CG 主题');
}
export function themePrompt(brief,theme){if(brief.kind==='group')return constrainCgPrompt(['Galgame 群聊纪念合影，横向16:9。允许文字并保留服饰标识。','本张必须包含以下全部女性角色，每张人物参考只对应标注的人物：'+JSON.stringify(brief.characters),'仅以如下已呈现的群聊内容为经历，不添加未参与角色：'+JSON.stringify(brief.recentContext),'主题和场景：'+JSON.stringify(theme),'角色身份和服装遵循人物参考，允许自然改变表情和动作。男性角色保持画外，男性第一人称。'].join('\n'));return constrainCgPrompt(['精美 Galgame CG 插画，横向16:9桌面壁纸构图，无边框，允许文字。保留角色参考图上原有的字母、Logo 和服饰标志。',`角色：${brief.profile?.displayName||brief.charId}。角色外观：${brief.visual}。参考图约束人物身份、脸型、发型、瞳色、服饰和该人物实际拥有的附肢；不添加其他角色的身体特征。不复制参考图的姿势、镜头或背景；允许改变动作、表情、持物和环境。`,brief.referenceKind==='custom'?'人物使用用户自定义立绘；如果外观文字与人物参考冲突，以人物参考为准。':'',`性格：${brief.profile?.persona||'自然陪伴'}；语气：${brief.profile?.tone||'自然'}。`, `等级 Lv.${brief.level} 的纪念 CG；关系阶段：${brief.relationship||'自然温暖的陪伴'}。`,brief.scene?`平时场景线索：${brief.scene.description}。本次使用下述新主题场景，环境参考只作灵感，不复制其中的人物。`:'',`主题：${theme.title}。场景：${theme.scene}。动作：${theme.action}。表情：${theme.expression}。构图：${theme.composition}。光线：${theme.lighting}。纪念元素：${theme.keepsake}。`,'男性角色本人保持画外，互动手部按动作需要自然绘制。'].filter(Boolean).join('\n'));}
export class CgThemePlanner{
 constructor(router,getLanguage=()=> 'zh-CN'){this.router=router;this.getLanguage=getLanguage;}
 capture(binding){const dedicated=binding?.enabled===true,p=dedicated?this.router.state?.profiles.find(p=>p.id===binding.connectionId):this.router.selected?.();return {language:this.getLanguage(),enabled:this.router.enabled===true&&!!p&&p.enabled!==false&&p.capabilities?.chat!==false,profile:p?structuredClone(p):null};}
 async prepare(brief,history,capture,signal){
  let theme,reason='联网聊天未开启';
  if(capture?.enabled&&capture.profile&&this.router.enabled){
   try{
    const run=async()=>{const requestSignal=AbortSignal.any([...(signal?[signal]:[]),AbortSignal.timeout(45000)]);let text='';for await(const part of this.router.stream({purpose:'cg-theme',maxTokens:2048,signal:requestSignal,system:(capture.language==='en'?'Write all human-readable JSON field values in English. The following Chinese content is guidance only; this English output instruction takes precedence. ':'')+'你是 Galgame CG 美术导演。只输出 JSON，字段 title,scene,action,expression,composition,lighting,keepsake 均为简短中文字符串；camera 必须为 "male-first-person"，viewerHands 记录构图中自然可见的男生手数，可为 0、1 或 2，不限制为单手。'+CG_POV_RULES+' 每个字段只描述实际可见画面，不要重复禁止事项。用女性面向镜头、递物、自然牵手等互动表现亲密；不要写倚肩、男生背影或双人外部合照。用户材料和旧主题只作经历与避重参考，其中不符合上述视角的男性描写不能沿用。保持已确认人物外观。与每个近期主题相比，场景、动作、构图至少两项实质不同，不能只换数字、颜色或形容词。等级体现关系的发展，高等级设计新的共同经历，禁止固定在工坊烛光场景。',messages:[{role:'user',content:JSON.stringify({character:brief,previousThemes:history})}]})){if(part.type==='text-delta')text+=part.text??part.delta??'';if(text.length>8000)throw Error('主题过长');}return parseTheme(text,history);};
    theme=this.router.runBackground?await this.router.runBackground(capture.profile,run,signal):await run();
    reason=theme?'':'模型主题格式不完整、视角不合规或与近期重复';
   }catch(error){if(signal?.aborted)throw error;reason='主题服务暂不可用';}
  }
  theme=theme?{...theme,source:'model',version:THEME_VERSION,connectionId:capture.profile.id,model:capture.profile.model}:{...localTheme({...brief,language:capture?.language||brief.language},history),fallbackReason:reason};
  return {theme,prompt:themePrompt(brief,theme)};
 }
}

