/* ---------- section 3: Galgame private chat ---------- */
Object.assign(I, {
  clock:'<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  image:'<rect x="3.5" y="5" width="17" height="14" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="M20.5 16l-5-5-8 8"/>',
  person:'<circle cx="12" cy="7.5" r="3.2"/><path d="M6 20c.6-3.8 3-6 6-6s5.4 2.2 6 6"/>',
  eye:'<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/>',
  users:'<circle cx="9" cy="8" r="3"/><path d="M3.5 19c.5-3.4 2.6-5.2 5.5-5.2s5 1.8 5.5 5.2"/><path d="M15.5 5.3a3 3 0 0 1 0 5.4M17.5 13.9c1.7.6 2.7 2.3 3 5.1"/>',
  idcard:'<rect x="3.5" y="5.5" width="17" height="13" rx="2"/><circle cx="9" cy="11" r="2"/><path d="M6 16c.5-1.5 1.6-2.2 3-2.2s2.5.7 3 2.2M14.5 10h3.5M14.5 13.5h3.5"/>',
  chats:'<path d="M4 6.5A2.5 2.5 0 0 1 6.5 4h7A2.5 2.5 0 0 1 16 6.5v4a2.5 2.5 0 0 1-2.5 2.5H9l-3.5 3v-3A2.5 2.5 0 0 1 4 10.5z"/><path d="M18 9.5a2 2 0 0 1 2 2V15a2 2 0 0 1-2 2v2.5L15 17h-3"/>',
  gallery:'<rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.5"/>',
  ticket:'<path d="M4 7.5A1.5 1.5 0 0 1 5.5 6h13A1.5 1.5 0 0 1 20 7.5V10a2 2 0 0 0 0 4v2.5a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 16.5V14a2 2 0 0 0 0-4z"/><path d="M14 7v2M14 11v2M14 15v2"/>',
  paw:'<circle cx="7.5" cy="10" r="1.7"/><circle cx="11" cy="6.8" r="1.7"/><circle cx="15" cy="7" r="1.7"/><circle cx="18" cy="10.5" r="1.7"/><path d="M8.5 17c0-2.6 2-4.6 4.2-4.6s3.8 2 3.8 4.3c0 1.5-1.2 2.3-2.4 2.3-.7 0-1-.4-1.5-.4s-.9.4-1.6.4c-1.3 0-2.5-.7-2.5-2z"/>',
  pencil:'<path d="M14.5 5.5l4 4L9 19H5v-4z"/><path d="M13 7l4 4"/>',
  jump:'<path d="M8 16L16 8M9.5 8H16v6.5"/>',
  send:'<path d="M4.5 11.5L19.5 5l-5 14-3-5.5z"/><path d="M11.5 13.5l8-8.5"/>',
  check:'<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  trash:'<path d="M5 7h14M10 4h4M7 7l1 12.5h8L17 7"/>',
  undo:'<path d="M9 6L5 10l4 4"/><path d="M5 10h9.5a4.5 4.5 0 0 1 0 9H11"/>',
  zin:'<circle cx="11" cy="11" r="6"/><path d="M20 20l-4.2-4.2M8.5 11h5M11 8.5v5"/>',
  zout:'<circle cx="11" cy="11" r="6"/><path d="M20 20l-4.2-4.2M8.5 11h5"/>',
  fit:'<path d="M4 9V5h4M20 9V5h-4M4 15v4h4M20 15v4h-4"/>',
  gift:'<rect x="4" y="9" width="16" height="11" rx="1.5"/><path d="M3 9h18M12 9v11M12 9c-1.6-3.6-5.2-4-5.2-1.6S12 9 12 9zM12 9c1.6-3.6 5.2-4 5.2-1.6S12 9 12 9z"/>',
  upload:'<path d="M12 16V5M7 9.5l5-5 5 5M5 20h14"/>',
  brush:'<path d="M5 19l9-9"/><path d="M14.5 4.5l.9 2 2 .9-2 .9-.9 2-.9-2-2-.9 2-.9zM18.5 11.5l.6 1.3 1.3.6-1.3.6-.6 1.3-.6-1.3-1.3-.6 1.3-.6z"/>',
  power:'<path d="M12 4v8"/><path d="M7.5 6.8a7 7 0 1 0 9 0"/>',
  globe:'<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.3 2.4 3.4 5.2 3.4 8.5s-1.1 6.1-3.4 8.5c-2.3-2.4-3.4-5.2-3.4-8.5s1.1-6.1 3.4-8.5z"/>'
});
const TH = id=>THEMES.find(x=>x.id===id);
const ROSTER = ['deepseek','claude','chatgpt','gemini','kimi','grok','seed','qwen','minimax','glm','hunyuan'];
const CHOICES = ['再聊一会吧','我先忙一下','说说今天吧'];
const gtb = (ic_,label,cls='')=>`<span class="gx-tb ${cls}">${ic(ic_,15)}${label}</span>`;
function galTop(t,{open='',chat=true,cgCount=4}={}){
  return `<div class="gx-top">
    <div class="gx-row"><span class="gx-title">与${esc(t.name)}的galgame ${ic('pencil',15)}</span>
      <span class="gx-chip${open==='char'?' open':''}">${face(t.id,'mini-face')}<small>角色来源</small>${esc(t.name)}${ic('chevron',14)}</span>
      <span class="gx-chip np"><i class="gx-dot${chat?'':' off'}"></i><small>实际对话</small>${chat?'Fixture · fixture-model':'离线'}${ic('jump',14)}</span>
      <span class="gx-grow"></span>
      <span class="gx-net">${ic('globe',15)}联网聊天${tgl(chat)}</span></div>
    <div class="gx-tools">${gtb('image','背景图',open==='bg'?'open':'')}${gtb('person','角色立绘',open==='sprite'?'open':'')}${gtb('eye','立绘','on')}<i class="gx-sep"></i>${gtb('users','管理角色')}${gtb('idcard','我的身份 · 默认身份')}${gtb('clock','对话历史')}<i class="gx-sep"></i>${gtb('chats','群聊')}<i class="gx-sep"></i>${gtb('gallery',`CG 图鉴 <span class="gx-cnt">${cgCount}</span>`,open==='cg'?'open':'')}<i class="gx-sep"></i>${gtb('paw','桌宠')}<span class="gx-tb only" title="重新开始">${ic('retry',15)}</span></div>
  </div>`;
}
function galDlg(t,{line=t.line,plate=t.name,user=false,choices=CHOICES,hl=-1,extra='',input=`回复 ${t.name} …`,inputCls='',send=`${ic('send',15)}回复`,sendCls='',lvl=[3,18]}={}){
  return `<div class="gx-dlg"><span class="gx-plate${user?' user':''}">${esc(plate)}${user?'':'<i class="acc" aria-hidden="true"></i>'}</span>
    <div class="gx-lvl">Lv.<b>${lvl[0]}</b> · 好感度 <b>${lvl[1]}</b>/30<i><s style="width:${(lvl[1]/30*100).toFixed(0)}%"></s></i></div>
    ${line}${extra}
    ${choices?`<div class="gx-choices">${choices.map((c,k)=>`<span class="gx-choice${k===hl?' hl':''}"><kbd>${k+1}</kbd>${c}</span>`).join('')}</div>`:''}
    <div class="gx-say"><div class="gx-ta ${inputCls}"><span>${input}</span><small>Enter 发送 · Shift+Enter 换行</small></div><span class="gx-send ${sendCls}">${send}</span></div></div>`;
}
const gline = (s,cls='')=>`<p class="gx-line ${cls}">${s}</p>`;
function gal(t,{gh=700,top=true,stand=true,dlg=null,inner='',open='',chat=true}={}){
  return `<div class="gx" style="--gh:${gh}px"><div class="gx-bg" style="background-image:url('${A(`art/bg-${t.id}.webp`)}')"></div>${top?'<div class="gx-shade"></div>'+galTop(t,{open,chat}):''}
    ${stand?`<img class="gx-stand" src="${A(`art/portrait-${t.id}.webp`)}" alt="">`:''}${dlg===null?galDlg(t,{line:gline(esc(t.line))}):dlg}${inner}</div>`;
}
const galPage = (t,o={},extra={})=>shell(t,{page:'galgame',height:o.height||860,content:gal(t,o),...extra});

S({id:'3.1',sec:3,title:'Galgame 主界面：顶栏 · 立绘舞台 · 对话框',before:[['deepseek-galgame-reply','DeepSeek'],['claude-galgame-private','Claude'],['deepseek-model-chip-click','点「实际对话」芯片后：直接跳到通用设置']],
  render:t=>galPage(t,{},{pins:[[1,1150,92],[2,886,124],[3,199,166],[4,1232,166],[5,199,585],[6,199,673],[7,199,732],[8,1232,250]]}),
  notes:['舞台上方那行「联网聊天已开启 · Fixture · fixture-model」和「关闭联网聊天」「配置模型」两个按钮并进顶栏：模型名放在「实际对话」芯片里，联网改成右上角的开关。','「实际对话」芯片点了会跳到通用设置，所以把下拉三角换成跳转箭头，悬停写「在通用设置里换模型」（现在看着像下拉框，点了却换页）。','按钮分成 5 组，用细竖线隔开：画面（背景图 · 角色立绘 · 立绘）｜角色（管理角色 · 我的身份 · 对话历史）｜群聊｜CG 图鉴｜桌宠 · 重新开始，每个按钮前加图标。「历史剧场」按钮去掉：小剧场已由群聊接替，旧记录挪进「对话历史」（见 3.10）。','开关类按钮（立绘、桌宠）不再把状态写进文字（「立绘：显示」「桌宠 · 关」），改成按下 / 抬起两种样子。「↺ 重新开始」收成图标，点了弹小气泡二次确认，不再把按钮文字变成「确认?」。','名牌用主题色，右上角带立绘小装饰；好感度条换成主题色渐变，数字加粗。','三个选项前加序号 1 / 2 / 3，输入框为空时可以直接按数字选。','输入框高一点，右下角写「Enter 发送 · Shift+Enter 换行」；「回复」按钮加图标，用主题色。','顶栏下面压一层渐变暗角，浅色背景图上的标题和芯片也看得清。']});

S({id:'3.2',sec:3,title:'对话框的四种状态：回复中 · 调用失败 · 备用台词 · 离线',before:[['deepseek-galgame-offline','DeepSeek · 离线模式（现在对话框和平时一模一样）']],
  render:t=>{const box=(cap,dlg)=>`<div><p class="st-cap">${cap}</p>${gal(t,{gh:300,top:false,stand:false,dlg})}</div>`;
    return shell(t,{page:'galgame',height:820,content:`<div class="gx-two">
      ${box('回复中',galDlg(t,{line:`<p class="gx-line"><span class="gx-typing">${esc(t.name)} 正在回复<span><i></i><i></i><i></i></span></span></p>`,choices:null,input:`等 ${esc(t.name)} 说完…`,inputCls:'dis',send:'<i class="spinner"></i>回复中',sendCls:'dis'}))}
      ${box('调用失败',galDlg(t,{line:gline(esc(t.line),'muted'),extra:`<div class="gx-alert">${ic('alert',16)}<span class="grow"><b>没连上模型</b> · 401 Unauthorized：API Key 无效</span><span class="gx-gbtn">${ic('retry',14)}重试</span><span class="gx-gbtn">去设置</span></div>`,choices:null,input:'今天的工作差不多了',inputCls:'typed'}))}
      ${box('备用台词',galDlg(t,{line:gline('（摸摸头）今天辛苦啦，先休息一下吧。'),extra:`<div class="gx-alert warn">${ic('info',16)}<span class="grow"><b>这句是备用台词</b> · 模型 30 秒没回应 · 目标模型 fixture-model</span><span class="gx-gbtn">${ic('retry',14)}重新生成</span></div>`,choices:null}))}
      ${box('离线模式',galDlg(t,{line:gline(esc(t.line)),extra:`<div class="gx-alert info">${ic('globe',16)}<span class="grow">联网聊天已关闭，现在只能翻看之前的对话。</span><span class="gx-gbtn pri">开启联网聊天</span></div>`,choices:null,input:'开启联网聊天后就能回复',inputCls:'dis',sendCls:'dis'}))}
    </div>`,pins:[[1,199,150],[2,764,150],[3,199,476],[4,764,476]]})},
  notes:['回复中：对话框里显示「DeepSeek 正在回复」和跳动的三个点，「回复」按钮转圈（现在只是把输入框和选项变半透明，看不出是不是卡住了）。','调用失败：红色提示条写清楚原因，后面跟「重试」和「去设置」；刚才输入的话留在输入框里，不用重打（现在只有一行红字原文）。','备用台词：用黄色提示条说明这句是备用台词、为什么、目标模型是谁，可以「重新生成」（现在是括号里的一行小黄字）。','离线模式：对话框里直接写「联网聊天已关闭」并给开启按钮；输入框提前变灰，不用发出去才报「当前为离线模式」。']});

S({id:'3.3',sec:3,title:'选择器 · 出场角色',before:[['deepseek-picker-character','DeepSeek']],
  render:t=>galPage(t,{open:'char',inner:`<div class="gx-pop" style="--pw:400px;left:208px;top:52px"><div class="gx-pop-h">出场角色<small>12 个</small></div>
      <div class="gx-pop-b"><div class="gx-follow">${ic('refresh',16)}<div><b>跟随工作区</b><small>按当前工作区的模型自动换角色 · 现在是 gpt-5.5-codex</small></div></div>
      <div class="gx-cgrid">${ROSTER.map(id=>{const c=TH(id);return `<span class="gx-copt${id===t.id?' sel':''}">${face(id,'mini-face')}<div><b>${esc(c.name)}</b><small>${esc(c.zh)}</small></div>${id===t.id?ic('check',16):''}</span>`}).join('')}</div></div>
      <div class="gx-pop-f">点角色就切换，聊天记录按角色分开保存<span class="grow"></span><span class="btn sm">${ic('users',14)}管理角色</span></div></div>`},
    {pins:[[1,419,170],[2,419,210],[3,419,359],[4,419,570]]}),
  notes:['标题从英文「CHARACTER SOURCE」改成中文「出场角色」，数量写在旁边。','「跟随工作区」单独放在最上面，说明它会跟着工作区模型自动换角色，以及现在跟的是哪个模型。','角色两列排列，每个前面有头像、下面一行写角色设定（深海女仆等），当前角色打勾；12 个角色不用滚动。','「管理角色」做成底部按钮，旁边写一句切换会发生什么。']});

S({id:'3.4',sec:3,title:'选择器 · 背景图',before:[['deepseek-picker-background','DeepSeek']],
  render:t=>{const names=t.id==='deepseek'?['深海宫殿','海边书房']:['默认背景','内置背景 2'];
    return galPage(t,{open:'bg',inner:`<div class="gx-pop" style="--pw:400px;left:16px;top:96px"><div class="gx-pop-h">背景图<small>${esc(t.name)} 专用</small><span class="grow"></span><span class="tag">角色背景</span></div>
      <div class="gx-pop-b"><div class="gx-prev" style="background-image:url('${A(`art/bg-${t.id}.webp`)}')"><span class="tag">正在使用</span></div>
      <p class="gx-sec">内置背景</p><div class="gx-bgrid"><span class="gx-bcard sel"><i style="background-image:url('${A(`art/bg-${t.id}.webp`)}')"></i><div><b>${names[0]}</b><span class="tag">默认</span></div></span><span class="gx-bcard"><i style="background-image:url('${A(`gen/web/${t.id}-bg.webp`)}')"></i><div><b>${names[1]}</b></div></span></div>
      <p class="gx-hint">上传的图片和 CG 背景只用在 ${esc(t.name)} 身上，换角色不影响别人。支持 PNG、JPG、WebP、AVIF，12 MB 以内。</p></div>
      <div class="gx-pop-f"><span class="btn sm">${ic('upload',14)}上传图片</span><span class="grow"></span><span class="btn sm dis">恢复默认</span></div></div>`},{pins:[[1,227,213],[2,227,336],[3,227,550],[4,227,684]]})},
  notes:['标题改成中文，右边标出当前是「角色背景」「自定义图片」还是「CG 覆盖」。','顶部大图预览当前背景；点下面的内置背景会先在舞台上预览，再点「应用」才保存。','内置背景卡片标「默认」，选中的描边；正被 CG 或自定义图片覆盖时，在这里多一行提示和「恢复默认」。','说明文字写清楚支持的格式和大小（现在要上传失败才知道）；「上传图片」和「恢复默认」固定在底部。']});

S({id:'3.5',sec:3,title:'选择器 · 角色立绘',before:[['deepseek-picker-sprite','DeepSeek']],
  render:t=>galPage(t,{open:'sprite',inner:`<div class="gx-pop" style="--pw:340px;left:104px;top:96px"><div class="gx-pop-h">角色立绘<small>${esc(t.name)}</small><span class="grow"></span><span class="tag">默认</span></div>
      <div class="gx-pop-b"><div class="gx-checker"><img src="${A(`art/portrait-${t.id}.webp`)}" alt=""></div>
      <p class="gx-hint">立绘按角色保存，所有工作区共用。建议用透明背景的竖图。</p></div>
      <div class="gx-pop-f"><span class="btn sm">${ic('upload',14)}上传图片</span><span class="grow"></span><span class="btn sm dis">恢复默认</span></div></div>`},{pins:[[1,315,213],[2,315,382],[3,315,560]]}),
  notes:['标题改中文，标出现在用的是默认立绘还是自己上传的。','透明格底预览不变，高度收一点，弹层不再盖住半个舞台。','底部按钮和背景图选择器统一：「上传图片」在左、「恢复默认」在右，去掉多余的「取消」（点外面或按 Esc 关闭）。']});

S({id:'3.6',sec:3,title:'升级奖励 · 特殊 CG 弹窗',before:[],
  render:t=>galPage(t,{inner:`<div class="gx-veil"></div><div class="gx-gift"><div class="gx-big" style="${cgpic(t.id,`gen/web/${t.id}-bg.webp`)}"><span class="zoom">${ic('zin',14)}点击看大图</span></div>
      <div class="gx-gift-b">${face(t.id,'mini-face')}<div class="grow"><h4>升级啦 · ${esc(t.name)} 送你一张特殊 CG</h4><p>Lv.3 纪念 · 已收进 CG 图鉴</p></div><span class="btn">${ic('image',15)}设为 Galgame 背景</span><span class="btn primary">收下</span></div></div>`},{pins:[[1,387,658],[2,387,400],[3,1067,658]]}),
  notes:['标题去掉 🎁 表情，改成角色头像加一句「升级啦 · DeepSeek 送你一张特殊 CG」，下面写是几级的纪念、已经收进图鉴。','图片可以点开看大图（右下角提示）。','两个按钮分主次：「收下」是主按钮；「设为 Galgame 背景」是次按钮，设好后变成「恢复默认背景」。读取失败时这里换成「重新读取」和「先关闭」。']});

S({id:'3.7',sec:3,title:'CG 生成进度提示条（四种状态）',before:[],
  render:t=>galPage(t,{inner:`<div class="gx-toasts">
      <p class="gx-cap">① 设计主题</p><div class="gx-toast"><i class="spinner"></i><div><b>正在设计纪念 CG 的主题…</b><span class="steps"><i class="n"></i><i></i><i></i></span><small>第 1 步 / 共 3 步 · ${esc(t.name)} Lv.3</small></div></div>
      <p class="gx-cap">② 排队</p><div class="gx-toast"><i class="spinner"></i><div><b>CG 已排队</b><span class="steps"><i class="d"></i><i class="n"></i><i></i></span><small>第 2 步 / 共 3 步 · 前面还有 1 张</small></div></div>
      <p class="gx-cap">③ 绘制</p><div class="gx-toast"><i class="spinner"></i><div><b>正在绘制纪念 CG…</b><span class="steps"><i class="d"></i><i class="d"></i><i class="n"></i></span><small>第 3 步 / 共 3 步 · 已用 38 秒</small></div></div>
      <p class="gx-cap">④ 失败</p><div class="gx-toast err">${ic('alert',18)}<div><b>CG 生成失败</b><small>绘图接口返回 429：请求太频繁，稍后再试。</small><span class="row"><span class="btn sm primary">重试</span><span class="btn sm">关闭</span></span></div></div></div>`},{pins:[[1,877,370],[2,877,486],[3,877,730]]}),
  notes:['进度提示条加三段进度：设计主题 → 排队 → 绘制，写明第几步、等了多久（现在只有一行文字在变）。','提示条用和弹层一样的面板样式，左边转圈，不再是一条深色小字条。','失败时给出原因和「重试」「关闭」两个按钮（现在要「点击关闭」整条提示，重试得去图鉴里找）。']});

const cgpic=(pid,bg)=>`background-image:url('${A(`art/portrait-${pid}.webp`)}'),url('${A(bg)}');background-size:auto 118%,cover;background-position:50% 4%,center;background-repeat:no-repeat`;
const CGS = t=>[[cgpic(t.id,`gen/web/${t.id}-bg.webp`),3,'深夜的书房','10/21 21:40',true],[cgpic(t.id,`art/bg-${t.id}.webp`),2,'第一次约定','10/18 13:05',false]];
function drawer(t,{kick,title,tabs='',acts='',body,dw=460}){
  return `<div class="gx-scrim"></div><aside class="gx-drawer" style="--dw:${dw}px"><div class="gx-dh"><span class="kick">${kick}</span><h3>${title}</h3><span class="ibtn">${ic('close')}</span>${tabs||acts?`<div class="gx-dh-row">${tabs}<span class="grow"></span>${acts}</div>`:''}</div><div class="gx-db">${body}</div></aside>`;
}
S({id:'3.8',sec:3,title:'CG 图鉴抽屉：图鉴 · 生成中 · 失败 · 右键菜单 · 撤销',before:[['deepseek-archive-cg','DeepSeek · 空图鉴']],
  render:t=>{const [a,b]=CGS(t);
    const card=([src,lv,name,at,bgNow],hl)=>`<div class="cg${hl?' hl':''}"><div class="cg-img" style="${src}">${bgNow?'<span class="tag">当前背景</span>':''}</div><div class="cg-m"><b>Lv.${lv}</b><span>${name} · ${at}</span></div></div>`;
    const body=`<div class="cg-grid">${card(a)}
      <div class="cg"><div class="cg-img fail">${ic('alert',20)}生成失败<span class="btn sm">重试</span></div><div class="cg-m"><b>Lv.1</b><span>${esc(t.name)} · 10/15 09:12</span></div></div><div class="cg"><div class="cg-img wait"><i class="spinner"></i>正在绘制<span class="steps"><i class="d"></i><i class="d"></i><i></i></span></div><div class="cg-m"><b>Lv.4</b><span>${esc(t.name)} · 刚刚</span></div></div>
      ${card(b,true)}</div>
      <div class="menu" style="left:236px;top:300px;min-width:180px"><div class="mi">${ic('zin')}查看大图</div><div class="mi">${ic('image')}设为 Galgame 背景</div><div class="msep"></div><div class="mi" style="color:var(--err)">${ic('trash')}移入回收站</div></div>
      <div class="gx-snack">${ic('trash',16)}已移入回收站<span class="grow"></span><span class="lnk">${ic('undo',14)} 撤销</span><span style="opacity:.6">8 秒</span></div>`;
    return galPage(t,{inner:drawer(t,{kick:'4 张 · 按角色分开收藏',title:'CG 图鉴',tabs:'<div class="seg sm"><span class="on">图鉴 4</span><span>回收站 1</span></div>',acts:`<span class="btn sm primary">${ic('brush',14)}生成纪念 CG</span>`,body})},{pins:[[1,783,124],[2,783,201],[3,783,330],[4,1219,531],[5,783,763]]})},
  notes:['抽屉跟随主题配色；标题旁写一共几张。去掉竖排的「DEEP-SEA ARCHIVE」书脊和英文编号（只在深海主题下合理，其他十套主题会显得突兀）。','「图鉴 / 回收站」改成分段切换，带数量；「生成纪念 CG」是主按钮，没有绘图连接时换成「配置 CG 绘图连接」。','正在生成和失败的卡片原地显示状态：生成中带三段进度，失败有「重试」。正在当背景的那张标「当前背景」。','右键菜单从一项扩成三项：查看大图、设为 Galgame 背景、移入回收站（红字）；也能用菜单键或 Shift+F10 打开。','移入回收站后底部出现「已移入回收站 · 撤销」提示，8 秒倒计时写出来。','空图鉴时写清楚怎么获得：「提升等级后，角色会送你特殊 CG，按角色分开收在这里」。（缩略图是用立绘和背景拼的示意图。）']});

S({id:'3.9',sec:3,title:'CG 详情（图鉴里点开一张）',before:[],
  render:t=>{const [a]=CGS(t);
    const body=`<span class="gx-back">${ic('chevron',14)}返回图鉴</span><div class="gx-big" style="${a[0]}"><span class="zoom">${ic('zin',14)}点击看大图</span></div>
      <div class="gx-meta"><b>Lv.3 · 深夜的书房</b><small>${esc(t.name)} · 10/21 21:40 · 主题由模型设计</small></div>
      <div class="gx-acts"><span class="btn sm dis">${ic('check',14)}已是 Galgame 背景</span><span class="btn sm">${ic('trash',14)}移入回收站</span></div>
      <details class="details"><summary style="color:var(--text)">${ic('chevron')}画面描述（生成时用的提示词）</summary></details>
      <p class="gx-hint">在回收站里打开时，这里的按钮换成「恢复到图鉴」。</p>`;
    return galPage(t,{inner:drawer(t,{kick:'CG 图鉴 · 第 1 张 / 共 4 张',title:'深夜的书房',body})},{pins:[[1,783,159],[2,783,359],[3,783,521],[4,783,579]]})},
  notes:['详情页标题直接用这张 CG 的主题名，上面写是第几张；「← 返回图鉴」放在图片上方。','大图点开进入查看器，右下角有提示。','等级、角色、时间、主题来源合成一行说明，不再分三行小字。','「设为 Galgame 背景」设好后变成「已是 Galgame 背景」不可点；提示词收进可展开的一行，平时不占地方。']});

S({id:'3.10',sec:3,title:'以前的小剧场（原「历史剧场」，挪进对话历史）',before:[['deepseek-archive-theater','DeepSeek · 现在点顶栏「历史剧场」打开的抽屉']],
  render:t=>{const sk=(ids,at,seed,lines,foot)=>`<div class="skit"><div class="skit-h"><span class="faces">${ids.map(id=>face(id,'mini-face')).join('')}</span><b>${ids.map(id=>TH(id).name).join('、')}</b><span class="grow"></span>${at}</div><p class="seed">${seed}</p>${lines.map(([id,s])=>`<p><em style="color:color-mix(in srgb,${TH(id).c.accent} 55%,var(--text))">${TH(id).name}</em>${s}</p>`).join('')}<div class="skit-f">${foot}</div></div>`;
    const other=t.id==='claude'?'chatgpt':'claude';
    const main=`<div class="cm-ph"><span class="mini-face" style="display:grid;place-items:center;background:var(--surface2);width:46px;height:46px">${ic('ticket',22)}</span><div class="grow"><h3>以前的小剧场 <span class="tag">只读</span></h3><small>2 场 · 10/09 – 10/12</small></div><span class="btn sm">${ic('chats',14)}去群聊</span></div>
      <div class="note">${ic('info')}<div><b>小剧场已经由群聊接替。</b>这里只保留以前演过的场次，不能再新建；想让几位角色一起聊，请用群聊。</div></div>
      ${sk([t.id,other],'10/12 20:12','主人在改一个很长的配置文件。',[[t.id,'这一段我帮主人记好了，等下提醒他喝水。'],[other,'那我负责盯着他别熬夜。'],[t.id,'……那你先别熬夜。']],`<span class="grow">一场 · 3 句</span><span class="btn sm ghost">${ic('brush',14)}补一张合影 CG</span>`)}
      ${sk([t.id,'gemini'],'10/09 23:40','主人终于把测试跑通了。',[['gemini','我就说今天会顺利吧！'],[t.id,'嗯，明天也要这样。']],`<span class="grow">一场 · 2 句</span><span class="gx-back">${ic('gallery',14)}合影已生成 · 在图鉴里</span>`)}`;
    return cmPage(t,{tab:'对话历史',sw:290,side:histSide(t,'skits'),main,foot:'<span class="grow">旧记录原样保留，没有删除。</span>'},[[1,1127,152],[2,127,488],[3,1127,212],[4,1127,360]])},
  notes:['小剧场和群聊不是同一个功能。小剧场是 2–3 位角色自己演的短剧，每场最多 10 句；群聊是你参与的持续多人对话，有成员、发言方式、继续接话和合影。1.9.0 起小剧场不能再新建，由群聊接替，以前演过的场次还保存着，只能回看。','所以 Galgame 顶栏的「历史剧场」按钮去掉，不再占一个常驻位置；旧记录挪到「角色与对话 › 对话历史」列表最下面的「以前的小剧场」，没有旧记录的人看不到这一项。','打开后顶部写清楚「小剧场已经由群聊接替」，旁边给「去群聊」。现在点「历史剧场」不会自动读取记录（代码里只给 CG 图鉴做了自动读取），先看到的是「还没有演过小剧场。等主人忙点什么，她们就有话题了。」，像是还会自动演新的。','每场一张卡：参演角色头像、时间、起因一句，台词前的名字用各自的主题色。旧场次仍可以补生成合影（现有功能），按钮用不抢眼的次要样式；已生成的写「合影已生成 · 在图鉴里」。']});

S({id:'3.11',sec:3,title:'CG 大图查看器',before:[],
  render:t=>galPage(t,{},{overlay:`<div class="cgv"><div class="cgv-h"><b>深夜的书房</b><small>${esc(t.name)} · Lv.3 · 10/21 21:40</small><span class="grow"></span>
      <span class="cgv-ctl"><span class="dim">${ic('zout',16)}</span><span>100%</span><span>${ic('zin',16)}</span><span class="lbl">${ic('fit',15)}适应窗口</span></span><span class="cgv-x">${ic('close',18)}</span></div>
      <div class="cgv-v"><i style="${cgpic(t.id,`gen/web/${t.id}-bg.webp`)}"></i></div>
      <div class="cgv-f"><span><kbd>滚轮</kbd>缩放</span><span><kbd>拖动</kbd>放大后移动</span><span><kbd>双击</kbd>复位 / 放大</span><span><kbd>Esc</kbd>关闭</span></div></div>`,pins:[[1,20,44],[2,990,13],[3,438,826]]}),
  notes:['顶栏写 CG 的主题名和角色、等级、时间（现在只有「DeepSeek的特殊CG」）。','缩放按钮换成图标，和「适应窗口」放进同一个按钮组；到上下限时变灰。','底部的操作说明改成按键样式，一眼能扫完。背景从灰蓝改成接近黑，图片颜色更准。']});

S({id:'3.12',sec:3,title:'编辑 Galgame 标题',before:[['deepseek-dialog-title','DeepSeek']],
  render:t=>galPage(t,{},{overlay:`<div class="scrim"></div><div class="mdl" style="--w:480px;--top:260px"><div class="mdl-h"><h2>编辑 Galgame 标题</h2><span class="ibtn">${ic('close')}</span></div>
      <div class="mdl-b"><div class="fld"><label>标题</label><span class="inp focus">与${esc(t.name)}的galgame</span><small style="display:flex;justify-content:space-between"><span>只改当前角色的界面标题，不改角色名、人设或群名。</span><span>${('与'+t.name+'的galgame').length} / 80</span></small></div></div>
      <div class="mdl-f"><span class="btn ghost">恢复默认</span><span class="grow"></span><span class="btn">取消</span><span class="btn primary">保存</span></div></div>`,pins:[[1,384,326],[2,384,386],[3,384,456]]}),
  notes:['弹窗换成和其他弹窗一样的标题栏和右上角关闭按钮。','输入框加标签，说明文字放到输入框下面，右边显示字数（如「17 / 80」）。','按钮排序统一：「恢复默认」放左边，「取消」「保存」在右边，「保存」是主按钮；标题为空时「保存」变灰。']});

S({id:'3.13',sec:3,title:'整页状态：连接中 · 连接失败 · Galgame 已关闭',before:[],
  render:t=>{const st=(cap,card)=>`<div><p class="st-cap">${cap}</p>${gal(t,{gh:420,top:false,stand:false,dlg:'',inner:`<div class="gx-full">${card}</div>`})}</div>`;
    return shell(t,{page:'galgame',height:600,content:`<div class="gx-three">
      ${st('连接中',`<div class="gx-fcard"><i class="spinner"></i><h4>正在连接 Galgame…</h4><p>通常几秒钟就好。</p></div>`)}
      ${st('连接失败',`<div class="gx-fcard err">${ic('alert',28)}<h4>Galgame 服务没有就绪</h4><p>本地服务启动失败：端口被占用。</p><span class="btn sm primary">${ic('retry',14)}重新连接</span></div>`)}
      ${st('已关闭',`<div class="gx-fcard">${ic('power',28)}<h4>AI 娘 Galgame 已关闭</h4><p>在通用设置里打开 Galgame 后就能继续。</p><span class="btn sm">去通用设置</span></div>`)}
    </div>`,pins:[[1,199,170],[2,580,170],[3,924,170]]})},
  notes:['连接中：居中卡片加转圈，替代右下角的小字提示「连接 galgame 服务中…」。','连接失败：写清原因，给「重新连接」按钮（现在只有「⚠️ galgame 服务未就绪：…」一行字）。','已关闭：保留原文案，加「去通用设置」按钮，不用自己去侧栏找。']});
