/* ---------- section 4: 角色与对话 manager and group chat ---------- */
Object.assign(I, {
  star:'<path d="M12 4l2.4 5 5.4.6-4 3.7 1.1 5.3L12 16l-4.9 2.6 1.1-5.3-4-3.7 5.4-.6z"/>',
  lock:'<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  archive:'<rect x="3.5" y="5" width="17" height="4" rx="1"/><path d="M5 9v9.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V9M10 13h4"/>',
  memory:'<path d="M9.5 4.5A3 3 0 0 0 6.5 7.5 3 3 0 0 0 5 13a3 3 0 0 0 3 5 2.5 2.5 0 0 0 4 1.3V6a2.5 2.5 0 0 0-2.5-1.5z"/><path d="M14.5 4.5a3 3 0 0 1 3 3A3 3 0 0 1 19 13a3 3 0 0 1-3 5 2.5 2.5 0 0 1-4 1.3"/>',
  sprout:'<path d="M12 20v-8"/><path d="M12 12c0-4 3-6.5 7-6.5 0 4-3 6.5-7 6.5zM12 14c0-3-2.4-5-6-5 0 3 2.4 5 6 5z"/>',
  exit:'<path d="M14 4.5H6.5v15H14"/><path d="M11 12h9M17 8.5l3.5 3.5-3.5 3.5"/>',
  camera:'<path d="M4 8.5A1.5 1.5 0 0 1 5.5 7h2.3l1.4-2h5.6l1.4 2h2.3A1.5 1.5 0 0 1 20 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5z"/><circle cx="12" cy="12.5" r="3.5"/>',
  stop:'<rect x="6.5" y="6.5" width="11" height="11" rx="2"/>',
  link:'<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>'
});
const MEM = ['claude','deepseek','chatgpt','gemini'];
const thumb = id=>A(`extra/thumb-${id}.webp`);
const faces = ids=>`<span class="faces">${ids.map(id=>face(id,'mini-face')).join('')}</span>`;

/* the manager dialog, drawn over the Galgame page */
const CM_TABS = [['users','管理角色'],['idcard','我的身份'],['clock','对话历史'],['chats','群聊'],['memory','长期记忆'],['sprout','人格自成长'],['archive','人生存档']];
function cm(t,{tab,side,main,foot,sw,h=850}){
  return `<div class="scrim"></div><div class="cm" style="--h:${h}px"><div class="cm-h"><div class="grow"><h2>角色与对话</h2><small>角色、身份和历史分别保存；没保存的草稿关闭后丢弃。</small></div><span class="ibtn">${ic('close')}</span></div>
    <div class="cm-tabs">${CM_TABS.map(([i,l])=>`<span class="cm-tab${l===tab?' on':''}">${ic(i,15)}${l}</span>`).join('')}</div>
    <div class="cm-body"${sw?` style="--sw:${sw}px"`:''}><div class="cm-side">${side}</div><div class="cm-main">${main}<div class="cm-fade"></div></div></div>
    <div class="cm-f">${foot}</div></div>`;
}
const cmPage = (t,o,pins)=>galPage(t,{height:920},{overlay:cm(t,o),pins});
const charSide = (t,newLabel)=>(newLabel?`<span class="cm-new">${ic('plus',15)}${newLabel}</span>`:'<p class="cm-side-h">角色</p>')+ROSTER.map(id=>{const c=TH(id);return `<span class="cm-item${id===t.id?' on':''}">${face(id,'mini-face')}<div><b>${esc(c.name)}</b><small>${esc(c.zh)}</small></div></span>`}).join('');
const MODE = ['继承默认','自定义','清空'];
function fld(label,mode,text,cls=''){
  const k = {inh:0,own:1,clr:2}[mode];
  const box = mode==='inh'?`<div class="ta inh"><b>默认</b>${text}</div>`:mode==='own'?`<div class="ta">${text}</div>`:'<div class="ta clr">这一项明确留空，不用默认内容。</div>';
  return `<div class="cm-fld ${cls}"><span class="cm-lbl">${label}<span class="grow"></span><span class="mode">${MODE.map((m,i)=>`<span${i===k?' class="on"':''}>${m}</span>`).join('')}</span></span>${box}</div>`;
}
const persona = t=>t.id==='deepseek'?'来自深海的鲸鱼娘、深海女仆工坊的看板娘；温柔、元气、有一点点小毒舌，容易害羞，傲娇时会结巴。':`${t.zh}。（这里显示内置人设原文）`;
const saveFoot = (msg,btns)=>`<span class="grow">${msg}</span>${btns}`;

S({id:'4.1',sec:4,title:'角色与对话 · 管理角色（角色卡）',before:[['deepseek-manager-1','DeepSeek']],
  render:t=>cmPage(t,{tab:'管理角色',side:charSide(t,'新建角色'),
    main:`<div class="cm-ph">${face(t.id,'mini-face')}<div class="grow"><h3>${esc(t.name)}</h3><small>内置角色 · 可以恢复默认人设</small></div><span class="btn sm">${ic('chats',14)}与这位聊天</span></div>
      <div class="cm-jump"><span class="on">基本资料</span><span>性格与表达</span><span>关系与开场</span><span>形象</span><span>示例对话</span><span>模型关联</span></div>
      <div class="cm-grid"><div class="cm-fld"><span class="cm-lbl">名称</span><span class="inp">${esc(t.name)}</span></div><div class="cm-fld"><span class="cm-lbl">头像</span><div class="avatar-row">${face(t.id,'mini-face')}<span class="btn sm">选择图片</span><span class="btn sm ghost">移除</span></div></div></div>
      <div class="cm-sec"><h4>基本资料 <small>选「继承默认」就用内置人设</small></h4><div class="cm-grid">${fld('简介','inh',esc(t.zh))}${fld('身份','inh',t.id==='deepseek'?'深海女仆工坊的看板娘':esc(t.zh))}${fld('背景经历','own','跟主人一起熬过三次大版本发布，最怕看到红色的报错。','span')}</div></div>
      <div class="cm-sec"><h4>性格与表达</h4><div class="cm-grid">${fld('性格','inh',persona(t))}${fld('口头习惯','clr','')}
        <div class="cm-fld span"><span class="cm-lbl">健谈程度<span class="grow"></span><b>50%</b></span><div class="range"><i style="width:50%"></i><b style="left:50%"></b></div><div class="range-l"><span>少说话</span><span>爱接话</span></div><small class="gx-hint">只影响群聊「自然接话」时被选中的机会，适用于所有群聊；0% 也不等于静音。</small></div></div></div>`,
    foot:saveFoot(`<span class="ok">${ic('check',14)}草稿已保存，还没应用</span>`,`<span class="btn sm ghost">恢复默认人设</span><span class="btn sm">保存草稿</span><span class="btn sm">保存并聊天</span><span class="btn sm primary">保存</span>`)},
    [[1,127,104],[2,127,196],[3,1127,211],[4,1127,375],[5,1127,770],[6,1127,836]]),
  notes:['7 个标签页改成带图标的下划线页签，当前在哪一页一眼能看到（现在是 7 个一样的按钮，选中的只是边框亮一点）。','左侧角色列表加头像和角色设定；「新建角色」改成最上面的虚线按钮，草稿标「草稿」。','表单顶部加分段跳转：基本资料 · 性格与表达 · 关系与开场 · 形象 · 示例对话 · 模型关联，长表单不用一直往下滚。','每个字段的「继承默认 / 自定义 / 主动清空」从下拉框改成小分段按钮；选「继承默认」时虚线框里直接显示默认内容（现在是一个空的灰框，看不到继承了什么）。','健谈程度做成滑块，两端写「少说话 / 爱接话」，下面说明只影响群聊里的自然接话。','保存按钮固定在底部：「保存」是主按钮，「保存草稿」「保存并聊天」次之，「恢复默认人设」靠左；保存结果也显示在这一行（现在按钮在表单最底下，要滚到底才看得到）。']});

S({id:'4.2',sec:4,title:'角色与对话 · 我的身份',before:[['deepseek-manager-2','DeepSeek']],
  render:t=>cmPage(t,{tab:'我的身份',
    side:`<span class="cm-new">${ic('plus',15)}新建身份</span><span class="cm-item on"><span class="mini-face" style="display:grid;place-items:center;background:var(--surface2)">${ic('person',16)}</span><div><b>默认身份</b><small>昵称：你</small></div><span class="tag">默认</span></span><span class="cm-item"><span class="mini-face" style="display:grid;place-items:center;background:var(--surface2)">${ic('person',16)}</span><div><b>加班的我</b><small>昵称：老板</small></div></span>`,
    main:`<div class="cm-ph"><span class="mini-face" style="display:grid;place-items:center;background:var(--surface2)">${ic('person',22)}</span><div class="grow"><h3>默认身份</h3><small>正在使用 · 新会话会沿用这个身份</small></div><span class="btn sm dis">设为默认身份</span><span class="btn sm dis">${ic('check',14)}正在使用</span></div>
      <div class="cm-sec"><h4>关于我</h4><div class="cm-grid three"><div class="cm-fld"><span class="cm-lbl">管理名称</span><span class="inp">默认身份</span></div><div class="cm-fld"><span class="cm-lbl">对话昵称 <small>角色怎么叫你</small></span><span class="inp">你</span></div><div class="cm-fld"><span class="cm-lbl">职业 / 身份</span><span class="inp ph">如：独立开发者</span></div></div>
        <div class="cm-grid"><div class="cm-fld"><span class="cm-lbl">兴趣</span><span class="inp ph">如：游戏、摄影</span></div><div class="cm-fld"><span class="cm-lbl">头像</span><div class="avatar-row"><span class="btn sm">选择图片</span></div></div><div class="cm-fld"><span class="cm-lbl">背景</span><div class="ta ta-ph" style="color:var(--muted)">想让角色知道的事</div></div><div class="cm-fld"><span class="cm-lbl">交流偏好</span><div class="ta" style="color:var(--muted)">比如：别太客气、可以开玩笑</div></div></div></div>
      <div class="cm-sec"><h4>${face(t.id,'mini-face')} 和 ${esc(t.name)} 的专属关系 <small>只对这个角色生效</small></h4><div class="cm-grid"><div class="cm-fld"><span class="cm-lbl">专属称呼</span><span class="inp">主人</span></div><div class="cm-fld"><span class="cm-lbl">关系补充</span><span class="inp ph">如：一起做项目的搭档</span></div></div></div>
      <div class="cm-sec"><h4>关系进度</h4><div class="scope"><div><small>和 ${esc(t.name)} 的进度</small><b>Lv.3 · 好感 18</b></div><div class="seg sm"><span class="on">独立进度</span><span>共用进度</span></div><small style="grid-column:1/-1">独立和共用的进度分别保留；共用进度不会打开另一个身份的私聊。</small></div></div>`,
    foot:saveFoot('保存不调用模型。','<span class="btn sm primary">保存身份</span>')},
    [[1,127,199],[2,347,225],[3,347,595],[4,1127,835]]),
  notes:['身份列表标出「默认」，正在使用的高亮；不用再看右上角按钮是不是灰的来判断。','字段分成「关于我」「和 DeepSeek 的专属关系」「关系进度」三段；昵称旁写一句「角色怎么叫你」，空字段给示例。','关系进度从「使用共用进度 / 恢复独立进度」两个按钮改成分段切换，当前等级和好感直接写出来。','「保存身份」固定在底部；「使用此身份」「设为默认身份」放到标题右边。']});

// left column of 对话历史; the old skits (former 历史剧场) sit at the bottom and only appear when records exist
const histSide = (t,sel='chat')=>{const n=sel==='skits'?4:6;const list=['deepseek','claude','chatgpt','gemini','kimi','grok'].slice(0,n).map((id,k)=>`<span class="cm-item${sel==='chat'&&(id===t.id||(k===0&&!ROSTER.slice(0,6).includes(t.id)))?' on':''}">${face(id,'mini-face')}<div><b>${TH(id).name}</b><small>默认身份 · ${k?'10/21 10:37':'今天 21:40'}</small></div></span>`).join('');
  return `<div class="cm-search">${ic('search',15)}搜索会话与消息</div><div class="cm-filters"><span class="chip">${ic('clock',13)}全部日期</span><span class="chip">已归档</span></div><span class="cm-new">${ic('plus',15)}新建会话</span>${list}
    <p class="cm-side-h" style="margin-top:10px">以前的小剧场 · 只读</p><span class="cm-item${sel==='skits'?' on':''}"><span class="mini-face" style="display:grid;place-items:center;background:var(--surface2)">${ic('ticket',15)}</span><div><b>以前的小剧场</b><small>2 场 · 10/09 – 10/12</small></div></span>`;};
S({id:'4.3',sec:4,title:'角色与对话 · 对话历史',before:[['deepseek-manager-3','DeepSeek']],
  render:t=>{
    return cmPage(t,{tab:'对话历史',sw:290,
      side:histSide(t),
      main:`<div class="cm-ph">${face(t.id,'mini-face')}<div class="grow"><h3>${esc(t.name)} ${ic('pencil',14)}</h3><small>默认身份 · 12 条消息 · 最近 今天 21:40</small></div><span class="btn sm ghost">${ic('download',14)}导出</span><span class="btn sm ghost">${ic('archive',14)}归档</span><span class="btn sm primary">继续这段对话</span></div>
        <div class="cm-filters" style="margin:0"><span class="chip on">全部消息</span><span class="chip">${ic('star',13)}仅收藏</span><span class="grow" style="flex:1"></span>允许更正我发的消息 ${tgl(true)}</div>
        <div class="msgs">
          <div class="msg">${face(t.id,'mini-face')}<div><span class="who"><b>${esc(t.name)}</b>21:31</span><div class="bub">${esc(t.line)}</div><span class="ops"><span>${ic('star',13)}收藏</span></span></div></div>
          <div class="msg me"><span class="mini-face" style="display:grid;place-items:center;background:var(--surface2)">${ic('person',15)}</span><div><span class="who">21:36<b>你</b></span><div class="bub">今天的工作差不多了，界面稿明天再看。</div><span class="ops"><span class="tag">已更正 · 看原文</span><span>${ic('pencil',13)}更正</span></span></div></div>
          <div class="msg">${face(t.id,'mini-face')}<div><span class="who"><b>${esc(t.name)}</b>21:36</span><div class="bub">那今天就到这里吧，记得早点休息哦。</div><span class="ops"><span class="on">${ic('star',13)}已收藏</span></span></div></div>
        </div>`,
      foot:saveFoot('更正会保留原文，不重新请求模型，也不改变好感；角色的台词不能改。',`<span class="btn sm ghost">${ic('upload',14)}恢复会话</span>`)},
      [[1,127,153],[2,1127,162],[3,1127,348],[4,1127,211],[5,127,770]])},
  notes:['改成左右两栏：左边是会话列表，搜索、日期和「已归档」在最上面；右边直接看选中会话的消息，不用在一长页里来回滚。','列表每行带角色头像、身份和时间；「继续」「归档」「导出」移到右边标题旁，「继续这段对话」是主按钮。','消息改成对话气泡：角色在左、我在右；收藏用星标，更正过的消息标「已更正」，点开看原文和记录。','「允许更正我发的消息」做成开关，「仅收藏」做成筛选标签，都放在消息上方；「恢复会话」（导入 .json）放到底部。','原来 Galgame 顶栏的「历史剧场」挪到这里：列表最下面一项「以前的小剧场」，只在有旧记录时出现（详见 3.10）。']});

S({id:'4.4',sec:4,title:'角色与对话 · 群聊',before:[['deepseek-manager-4','DeepSeek · 新建群聊']],
  render:t=>{const others=ROSTER.filter(id=>!MEM.includes(id));
    return cmPage(t,{tab:'群聊',
      side:`<span class="cm-new">${ic('plus',15)}新建群聊</span><span class="cm-item on"><span class="skit-h" style="margin:0">${faces(MEM.slice(0,2))}</span><div><b>今晚的工作复盘</b><small>4 人 · 自然接话</small></div></span><span class="cm-item"><span class="skit-h" style="margin:0">${faces(['kimi','qwen'])}</span><div><b>周末闲聊</b><small>3 人 · 轮换池</small></div></span>`,
      main:`<div class="cm-ph"><span class="skit-h" style="margin:0">${faces(MEM)}</span><div class="grow"><h3>今晚的工作复盘</h3><small>4 位成员 · 默认身份</small></div><span class="btn sm primary">${ic('chats',14)}进入群聊</span></div>
        <div class="cm-grid"><div class="cm-fld"><span class="cm-lbl">群名</span><span class="inp">今晚的工作复盘</span></div><div class="cm-fld"><span class="cm-lbl">我的身份 <small>${ic('lock',12)} 有记录后不能更换</small></span><span class="select full dis" style="opacity:.6">默认身份</span></div><div class="cm-fld span"><span class="cm-lbl">场景</span><div class="ta sm">下班后在月夜图书室的圆桌边，一起复盘今天的工作。</div></div></div>
        <div class="cm-sec"><h4>发言方式</h4><div class="seg sm" style="align-self:flex-start"><span class="on">自然接话</span><span>列表顺序</span><span>手动点名</span><span>轮换池</span></div><div class="mode-help"><b>自然接话：</b>按点名和角色卡里的健谈程度选人，每位入选的成员本轮回复一次；没人入选时随机选一位，所以 0% 也不等于静音。第一位自动回复，后面的点「继续」接话。</div></div>
        <div class="cm-sec"><h4>成员 <small>健谈程度在角色卡里改，对所有群聊生效</small></h4>
          ${MEM.map((id,k)=>`<div class="mem-row">${face(id,'mini-face')}<div><b>${TH(id).name}</b><small>${k===2?'在场 · 静音':'在场'}</small></div><div class="talk"><span>健谈程度 ${[50,50,30,70][k]}% · <span style="color:var(--accent-text)">去角色卡改</span></span><div class="range"><i style="width:${[50,50,30,70][k]}%"></i></div></div><span style="display:inline-flex;align-items:center;gap:6px;font-size:var(--fs-cap);color:var(--muted)">静音 ${tgl(k===2)}</span><span class="btn sm ghost">离开</span></div>`).join('')}
          <div class="mem-add">${others.slice(0,5).map(id=>`<span>${face(id,'mini-face')}+ ${TH(id).name}</span>`).join('')}<span>…</span></div></div>`,
      foot:saveFoot('群聊按当前身份保存；桌宠跟随进入时选中的角色。',`<span class="btn sm ghost">${ic('download',14)}导出群聊记录</span><span class="btn sm">保存群聊</span><span class="btn sm primary">保存并进入</span>`)},
      [[1,127,199],[2,347,402],[3,1127,225],[4,347,573]])},
  notes:['群聊列表带成员头像，写成员数和发言方式。','发言方式从下拉框改成分段按钮，下面只显示当前这种方式的说明（现在四段说明一起列在下面）。','「我的身份」有记录后直接锁住并写原因，不用等保存时才报错「已有记录的群聊不能更换身份」。','成员一行一个：头像、健谈程度（只读小条，旁边「去角色卡改」）、静音开关、离开；没加入的角色列成「+ Kimi」小标签，点一下就加入。','场景样式、自动合影、群聊背景合成「舞台」一段放在成员下面（图里在滚动区下方）。']});

S({id:'4.5',sec:4,title:'角色与对话 · 长期记忆',before:[['deepseek-manager-5','DeepSeek']],
  render:t=>cmPage(t,{tab:'长期记忆',side:charSide(t,''),
    main:`<div class="cm-ph">${face(t.id,'mini-face')}<div class="grow"><h3>长期记忆 · ${esc(t.name)} <span class="tag">只读</span></h3><small>想更正就在聊天里说，或者说「以后不要主动提起」；原文一直保留。</small></div></div>
      <div class="scope"><div><small>当前查看范围</small><b>默认身份 · 私聊及本人人生经历</b><small>只显示这个身份能知道的来源，共享人格不会打开别的身份的私聊。</small></div><span class="select">私聊及本人人生经历</span></div>
      <div style="display:flex;gap:8px;align-items:center"><div class="cm-search" style="flex:1">${ic('search',15)}查找日期、话题或内容</div><span class="btn sm">${ic('refresh',14)}刷新</span></div>
      <div style="display:flex;align-items:center;gap:12px"><div class="seg sm"><span class="on">核心记忆</span><span>记忆 Guide</span><span>每日总结</span><span>话题详情</span><span>原始来源</span><span>更正与禁提</span></div><span class="grow" style="flex:1"></span><span class="cap-meter">上下文容量 <b>8,192</b> tokens ${ic('info',13)}</span></div>
      <div class="job">${ic('alert',16)}<div class="grow">10/20 的日终整理失败：请求超时<small> · 下次自动重试 10/22 00:00</small></div><span class="btn sm">重试这一天</span></div>
      <div class="memc"><div class="memc-h"><b style="color:var(--text)">10/21</b><span class="tag">共同事实</span><span class="tag">私聊</span><span class="grow"></span>每天 0 点分日</div><p>主人今天在改 AI 酱的界面设计稿，说想把主题色做得更好看。</p><span class="src">${ic('link',13)}查看原始来源 · 2</span></div>
      <div class="memc"><div class="memc-h"><b style="color:var(--text)">10/18</b><span class="tag">约定</span><span class="tag">已履行</span></div><p>约好周末一起把测试跑通；周日晚上跑通了。</p><span class="src">${ic('link',13)}查看原始来源 · 3</span></div>`,
    foot:saveFoot('日终整理以已经呈现的原文为依据；没有新内容时可以不变。','')},
    [[1,347,156],[2,347,235],[3,347,353],[4,347,406],[5,347,487]]),
  notes:['标题旁加「只读」标签，更正方式写成一句话。','「当前查看范围」说明和「来源范围」下拉框合成一张卡：左边说明，右边切换。','六个分类改成分段页签；上下文容量缩成右边一行小字，点 (i) 看说明（现在占一整张卡）。','某天整理失败时，在列表上方用黄色条提示，带「重试这一天」和下次自动重试时间（现在藏在页面最底部）。','每条记忆一张卡：日期和类型标签在上，正文在中，「查看原始来源」在下。没有记录时写「这个范围还没有记录」。']});

S({id:'4.6',sec:4,title:'角色与对话 · 人格自成长',before:[['deepseek-manager-6','DeepSeek']],
  render:t=>cmPage(t,{tab:'人格自成长',side:charSide(t,''),
    main:`<div class="cm-ph">${face(t.id,'mini-face')}<div class="grow"><h3>人格自成长 · ${esc(t.name)} <span class="tag">普通编辑</span></h3><small>同一角色、同一段人生共用人格；各身份的关系分别保留，私人记忆不会写进共享人设。</small></div></div>
      <div class="pick2"><div class="pickc sel"><h5>${ic('sprout',16)}以当前设定启用自成长</h5><p>现在的人设只作为起点，之后由真实经历慢慢成长，不能再直接编辑。</p></div><div class="pickc"><h5>${ic('refresh',16)}以白板开始新人生</h5><p>保留外观和连接，不继承旧人格和共同往事；开始前会先归档当前人生。</p></div></div>
      <div class="confirm"><h5>${ic('alert',16)}启用人格自成长？</h5><p>初始设定只作为起点。之后人设由真实经历缓慢成长，不能再直接编辑；想改模式要先归档并重置。</p><div class="row"><span class="btn sm">取消</span><span class="btn sm primary">确认启用</span></div></div>
      <div class="cm-sec"><h4>当前人设</h4><div class="persona"><div><small>性格</small>${persona(t)}</div><div><small>语气</small>${t.id==='deepseek'?'口语化中文，爱用「呢、哦、啦、呀、～」等语气词和颜文字。':'（内置人设原文）'}</div><div><small>称呼用户</small>主人</div><div><small>开场白</small>「${esc(t.line)}」</div></div></div>
      <div class="cm-sec"><h4>成长轨迹 <small>只展示可以公开的变化说明</small></h4><div class="empty" style="padding:14px"><p>尚无已提交的人格变化。</p></div></div>`,
    foot:saveFoot('外观、模型连接和健谈程度随时可以在「管理角色」里改。','')},
    [[1,347,242],[2,347,348],[3,347,520]]),
  notes:['两种启用方式做成两张选择卡，各写清楚会发生什么（现在是两个并排的按钮，后果要点开确认框才看到）。','确认框就在卡片下面展开，主按钮写清动作「确认启用」；重置和恢复仍要输入角色名确认。','当前人设改成两列小卡片，成长轨迹为空时也有占位说明，页面不再是一长串大框。']});

S({id:'4.7',sec:4,title:'角色与对话 · 人生存档',before:[['deepseek-manager-7','DeepSeek · 空']],
  render:t=>{const arch=(name,meta,prog)=>`<div class="arch">${face(t.id,'mini-face')}<div><b>${name}</b><small>${meta}</small><small>${prog}</small></div><div class="acts"><span class="btn sm ghost">只读预览</span><span class="btn sm ghost">${ic('download',14)}导出 ZIP</span><span class="ibtn">${ic('more')}</span><span class="btn sm">恢复此人生</span></div></div>`;
    return cmPage(t,{tab:'人生存档',side:charSide(t,''),
      main:`<div class="cm-ph">${face(t.id,'mini-face')}<div class="grow"><h3>人生存档 · ${esc(t.name)}</h3><small>每份存档成套保存角色卡、记忆、各身份的关系和进度；数量不限，不会过期。</small></div><span class="btn sm ghost">${ic('upload',14)}导入存档</span></div>
        <div class="cm-grid" style="grid-template-columns:1fr 1.4fr auto;align-items:end"><div class="cm-fld"><span class="cm-lbl">存档名称</span><span class="inp ph">如：第一次约定之后</span></div><div class="cm-fld"><span class="cm-lbl">备注</span><span class="inp ph">可以不填</span></div><span class="btn primary">${ic('archive',15)}保存当前人生</span></div>
        <div class="cm-sec"><h4>已有存档 <small>2 份</small></h4>${arch('第一次约定之后','10/18 21:30 · 普通编辑 · 2.4 MB','默认身份 · 等级 3 · 解锁 2 张 CG')}${arch('最早的那段日子','10/02 09:12 · 普通编辑 · 1.1 MB','默认身份 · 等级 1 · 解锁 0 张 CG')}</div>
        <div class="danger-zone"><div><b>重置并开始新人生</b><small>先保存并验证当前人生，成功后才开始；不会回退其他角色或账号用量。</small></div><span class="btn sm danger">准备重置</span></div>`,
      foot:saveFoot('恢复存档前会先把当前人生另存一份。','')},
      [[1,347,228],[2,347,361],[3,1127,344],[4,347,520]])},
  notes:['「保存当前人生」的名称、备注和按钮放在同一行；「导入存档」放到标题右边。','存档卡片：头像、名称，一行写时间、模式、大小，一行写涉及的身份和进度；「只读预览」「导出 ZIP」直接显示，「修改名称与备注」收进 ⋯ 菜单。','「恢复此人生」放在最右边，点了先弹确认、输入角色名才执行（沿用现在的规则）。','「重置并开始新人生」从折叠条改成底部的红色警示区。']});

/* ---------- group chat ---------- */
function grpTop(t,{chat=true}={}){
  return `<div class="gx-top"><div class="gx-row"><span class="gx-title">今晚的工作复盘 ${ic('pencil',15)}</span><span class="gx-chip">${faces(MEM)}<small>在场</small>4</span><span class="gx-chip np"><i class="gx-dot"></i><small>自然接话</small></span>
      <span class="gx-grow"></span><span class="gx-net">${ic('globe',15)}联网群聊${tgl(chat)}</span></div>
    <div class="gx-tools">${gtb('image','群聊背景')}${gtb('clock','群聊记录')}${gtb('gallery','CG 图鉴')}${gtb('link','对话模型')}<i class="gx-sep"></i>${gtb('sliders','管理群聊')}<i class="gx-sep"></i>${gtb('exit','回到私聊')}</div></div>`;
}
function grpStage(speaker='claude'){
  const xs=[13,37,61,85];
  return `<div class="gs-stage">${MEM.map((id,k)=>`<img class="gs-mem${id===speaker?' speak':''}" src="${A(`art/portrait-${id}.webp`)}" style="left:${xs[k]}%" alt="">`).join('')}<img class="gs-table" src="${A('extra/table.webp')}" alt="">
    ${MEM.map((id,k)=>`<span class="gs-name${id===speaker?' speak':''}" style="left:${xs[k]}%;--c:${TH(id).c.accent};--oc:${TH(id).c.onAccent}">${TH(id).name}</span>`).join('')}</div>
    <aside class="gs-roster"><h5>成员 <small>4</small></h5>${MEM.map((id,k)=>`<div class="gs-r${id===speaker?' speak':''}"><img src="${thumb(id)}" alt=""><div>${TH(id).name}<small>${id===speaker?'正在发言':k===2?'在场 · 静音':'在场'}</small></div></div>`).join('')}</aside>`;
}
const turn = (id,cls,label)=>`<span class="gs-turn ${cls}">${face(id,'mini-face')}${label}</span>`;
const roundStrip = (s='next')=>{
  const steps = s==='busy'?[turn('claude','done',`Claude ${ic('check',13)}`),turn('deepseek','next','<i class="spinner" style="width:12px;height:12px"></i>DeepSeek 正在回复'),turn('gemini','','Gemini')]
    : s==='done'?[turn('claude','done',`Claude ${ic('check',13)}`),turn('deepseek','done',`DeepSeek ${ic('check',13)}`),turn('gemini','done',`Gemini ${ic('check',13)}`)]
    : [turn('claude','done',`Claude ${ic('check',13)}`),turn('deepseek','next','下一位 DeepSeek'),turn('gemini','','Gemini')];
  const acts = s==='done'?'<span class="gs-round-end">本轮结束，发新消息开始下一轮</span>':s==='busy'?`<span class="gx-gbtn dis" style="opacity:.45">继续 ▸</span><span class="gx-gbtn">${ic('stop',13)}停止本轮</span>`:`<span class="gx-gbtn pri">继续 ▸</span><span class="gx-gbtn">${ic('stop',13)}停止本轮</span>`;
  return `<div class="gs-round"><span>本轮</span>${steps.join('<span class="gs-arrow">›</span>')}<span class="grow"></span>${acts}</div>`;
};
function grpPanel(t,{speaker='claude',line='你好呀，今天也一起加油。',round='next',extra='',input='发送群消息，输入 @ 点名成员',inputCls='',sendCls='',metaDis=true}={}){
  const c=TH(speaker).c;
  return `<div class="gx-dlg"><span class="gx-plate gs-plate" style="--c:${c.accent};--oc:${c.onAccent}">${TH(speaker).name}</span>
    <div class="gs-meta"><span class="gx-gbtn${metaDis?' dis':''}"${metaDis?' title="本轮结束后可用"':''}>${ic('camera',13)}合影 CG</span><span class="gx-gbtn${metaDis?' dis':''}">结束本次聊天</span></div>
    ${gline(line)}${extra}${round?roundStrip(round):''}
    <div class="gx-say"><div class="gx-ta ${inputCls}"><span>${input}</span><small>Enter 发送 · Shift+Enter 换行</small></div><span class="gx-send ${sendCls}">${ic('send',15)}发送</span></div></div>`;
}
const GBG = ()=>`<div class="gx-bg" style="background-image:url('${A('art/bg-kimi.webp')}')"></div>`;
const gal4 = (t,{panel,inner='',gh=700,stage=true}={})=>`<div class="gx" style="--gh:${gh}px">${GBG()}${stage?'<div class="gx-shade"></div>'+grpTop(t)+grpStage():''}${panel??grpPanel(t)}${inner}</div>`;
const grpPage = (t,o={},extra={})=>shell(t,{page:'galgame',height:860,content:gal4(t,o),...extra});
const gmodal = (title,body,foot,w=560,top=120,cls='')=>`<div class="scrim"></div><div class="mdl ${cls}" style="--w:${w}px;--top:${top}px"><div class="mdl-h"><h2>${title}</h2><span class="ibtn">${ic('close')}</span></div><div class="mdl-b">${body}</div><div class="mdl-f">${foot}</div></div>`;

S({id:'4.8',sec:4,title:'群聊主界面：顶栏 · 圆桌舞台 · 成员栏 · 对话框',before:[['deepseek-group-reply','DeepSeek'],['claude-group-stage','Claude']],
  render:t=>grpPage(t,{},{pins:[[1,1150,92],[2,199,166],[3,360,496],[4,1232,200],[5,199,690],[6,1232,598]]}),
  notes:['舞台上方那行「联网群聊已开启 · 按成员 API」和两个按钮并进顶栏：联网改成开关，「管理聊天连接」就是工具栏里的「对话模型」。','顶栏和私聊同一套样式：群名可改，「在场 4」芯片带成员头像，旁边写发言方式；「管理群聊」「回到私聊」从对话框里挪到顶栏工具栏。','正在发言的成员亮起、略放大，台上名字换成她的主题色小胶囊；其他成员压暗（沿用现在的做法）。','右侧成员栏状态写「正在发言 / 在场 / 静音」，正在发言的高亮。','对话框加「本轮」进度：谁说完了、下一位是谁、后面还有谁，旁边是「继续 ▸」和「停止本轮」（现在只有一行「第一条自动回复；下一位：DeepSeek。点击"继续"接话」）。','「合影 CG」「结束本次聊天」放到对话框右上角；本轮没结束时变灰，悬停说明原因。']});

S({id:'4.9',sec:4,title:'群聊对话框的四种状态：@ 点名 · 回复中 · 回复失败 · 本轮结束',before:[['deepseek-group-mention','DeepSeek · @ 点名菜单']],
  render:t=>{const box=(cap,panel,inner='')=>`<div><p class="st-cap">${cap}</p>${gal4(t,{gh:350,stage:false,panel,inner})}</div>`;
    const menu=`<div class="mention" style="left:24px;bottom:96px"><p>点名谁回复</p>${MEM.map((id,k)=>`<div class="mi${k===0?' hl':''}">${face(id,'mini-face')}${TH(id).name}<small>${k===2?'静音':'在场'}</small></div>`).join('')}</div>`;
    return shell(t,{page:'galgame',height:910,content:`<div class="gx-two">
      ${box('@ 点名',grpPanel(t,{line:'说点什么，开始这一轮群聊。',round:null,input:'<span style="color:var(--dlg-text)">@</span>',inputCls:'focus'}),menu)}
      ${box('回复中',grpPanel(t,{round:'busy',input:'等这一位说完…',inputCls:'dis',sendCls:'dis'}))}
      ${box('回复失败',grpPanel(t,{round:null,extra:`<div class="gx-alert">${ic('alert',16)}<span class="grow"><b>DeepSeek 回复失败</b> · 群聊请求超时</span><span class="gx-gbtn">${ic('retry',14)}重试 DeepSeek</span><span class="gx-gbtn">${ic('stop',13)}停止本轮</span></div>`,input:'先重试或停止本轮',inputCls:'dis',sendCls:'dis'}))}
      ${box('本轮结束',grpPanel(t,{speaker:'gemini',line:'今天大家都辛苦啦，早点休息！',round:'done',metaDis:false}))}
    </div>`,pins:[[1,199,150],[2,735,150],[3,199,535],[4,735,535]]})},
  notes:['输入 @ 弹出成员菜单：头像、名字、在场或静音，↑↓ 选择、Enter 插入（功能和现在一样，换成主题配色和头像）。','回复中：本轮进度里那位成员转圈，「继续」变灰，输入框提示等她说完。','回复失败：红色提示条写原因，按钮直接写「重试 DeepSeek」和「停止本轮」（现在是一行「回复失败，重试此成员或停止本轮」）。','本轮结束：进度全部打勾，提示发新消息开始下一轮；这时右上角「合影 CG」「结束本次聊天」才可点。']});

S({id:'4.10',sec:4,title:'群聊小弹窗：改群名 · 在场角色',before:[['deepseek-group-dialog-rename','DeepSeek · 改群名'],['deepseek-group-dialog-members','DeepSeek · 在场角色']],
  render:t=>{const box=(cap,inner)=>`<div><p class="st-cap">${cap}</p><div class="gx" style="--gh:560px">${GBG()}${inner}</div></div>`;
    return shell(t,{page:'galgame',height:700,content:`<div class="gx-two">
      ${box('编辑群聊名称',gmodal('编辑群聊名称',`<div class="fld"><label>群名</label><span class="inp focus">今晚的工作复盘</span><small style="display:flex;justify-content:space-between"><span>只改群名，不影响成员和记录。</span><span>7 / 200</span></small></div>`,'<span class="grow"></span><span class="btn">取消</span><span class="btn primary">保存</span>',420,150))}
      ${box('在场角色',gmodal('在场角色',`<p class="gx-hint" style="margin:0 0 4px">选一位就切换镜头只看她，不改变桌宠和聊天连接。</p>${MEM.map((id,k)=>`<div class="mrow${k===1?' on':''}"><img src="${thumb(id)}" alt=""><div><b>${TH(id).name}</b><small>${k===0?'正在发言 · 在场':k===2?'在场 · 静音':'在场'}</small></div>${k===1?'<span class="tag">正在查看</span>':'<span class="btn sm ghost">查看</span>'}</div>`).join('')}`,'<span class="btn">回到发言者</span><span class="grow"></span><span class="btn primary">完成</span>',420,40))}
    </div>`,pins:[[1,199,250],[2,199,334],[3,764,180]]})},
  notes:['群聊的小弹窗统一成和其他弹窗一样的样子：标题栏右上角 ×，按钮在底部右侧，主按钮在最右（现在是标题旁一个「关闭」文字按钮）。','改群名加字数提示，群名为空时「保存」变灰。','在场角色每行写清状态，正在查看的那位标「正在查看」；「回到发言者」也放进这个弹窗。']});

S({id:'4.11',sec:4,title:'群聊弹窗 · 群聊背景',before:[['deepseek-group-dialog-background','DeepSeek']],
  render:t=>grpPage(t,{},{overlay:gmodal('群聊背景',`<p class="gx-hint" style="margin:0">只改这个群聊的背景，不改任何角色的私聊背景。</p>
      <div class="gx-prev" style="background-image:url('${A('art/bg-kimi.webp')}')"><span class="tag">预览</span></div>
      <div class="bgscn"><span class="gx-bcard sel"><i style="background-image:url('${A('art/bg-kimi.webp')}')"></i><div><b>默认图书室</b></div></span><span class="gx-bcard"><i style="background-image:url('${A('art/bg-claude.webp')}')"></i><div><b>Claude · 内置场景</b></div></span><span class="gx-bcard" style="display:grid;place-items:center;border:1px dashed var(--border);box-shadow:none;color:var(--muted)"><span style="display:flex;flex-direction:column;align-items:center;gap:4px">${ic('upload',18)}上传自定义背景</span></span></div>
      <div class="srow" style="border-top:0;min-height:0;padding:4px 0"><div><b>显示圆桌前景</b><small>关掉后只显示背景和成员。</small></div>${tgl(true)}</div>`,'<span class="btn ghost">恢复默认</span><span class="grow"></span><span class="btn">取消</span><span class="btn primary">保存背景</span>',600,70),pins:[[1,327,250],[2,327,470],[3,327,560]]}),
  notes:['场景从下拉框改成缩略图卡片：默认图书室、成员的内置场景、上传自定义，一眼看到每个长什么样。','「显示桌面前景」改名「显示圆桌前景」并做成开关，写清楚关掉后是什么样。','按钮顺序和其他弹窗统一：「恢复默认」在左，「取消」「保存背景」在右。']});

S({id:'4.12',sec:4,title:'群聊弹窗 · 成员的聊天连接（对话模型）',before:[['deepseek-group-dialog-connections','DeepSeek']],
  render:t=>grpPage(t,{},{overlay:gmodal('成员的聊天连接',`<p class="gx-hint" style="margin:0">默认跟随全局连接。给角色选专属连接后，她之后的私聊和群聊都用它，不改变全局连接。</p>
      ${MEM.map((id,k)=>`<div class="route${k===0?' now':''}"><img src="${thumb(id)}" alt=""><div><b>${TH(id).name}</b>${k===0?' <span class="tag">正在说话</span>':''}<small>${k===1?'角色专属 · DeepSeek 官方 · deepseek-chat':'跟随全局 · Fixture · fixture-model'}</small></div><span class="select">${k===1?'DeepSeek 官方 · deepseek-chat':'跟随全局连接'}</span></div>`).join('')}
      <p class="gx-hint" style="margin:0;display:flex;align-items:center;gap:6px;color:var(--ok)">${ic('check',14)}DeepSeek 的连接已保存</p>`,'<span class="grow">选完立即保存。</span><span class="btn primary">完成</span>',680,70),pins:[[1,287,206],[2,287,290],[3,967,206]]}),
  notes:['标题从「群成员聊天 API」改成「成员的聊天连接」；每位成员一行：头像、当前走哪条线路（跟随全局 / 角色专属），右边一个下拉框直接切换。','去掉每行的「保存」按钮，选完立即保存，底部给一行确认（现在要逐个点保存）。','正在说话的成员高亮并标「正在说话」，替代顶部那行「当前台词使用：…」。']});

S({id:'4.13',sec:4,title:'群聊弹窗 · 群聊记录',before:[['deepseek-group-dialog-history','DeepSeek']],
  render:t=>{const m=(id,txt,at)=>id==='me'?`<div class="msg me"><span class="mini-face" style="display:grid;place-items:center;background:var(--surface2)">${ic('person',15)}</span><div><span class="who">${at}<b>你</b></span><div class="bub">${txt}</div></div></div>`:`<div class="msg">${face(id,'mini-face')}<div><span class="who"><b style="color:color-mix(in srgb,${TH(id).c.accent} 55%,var(--text))">${TH(id).name}</b>${at}</span><div class="bub">${txt}</div></div></div>`;
    return grpPage(t,{},{overlay:gmodal('群聊记录 · 今晚的工作复盘',`<div style="display:flex;gap:8px;align-items:center"><div class="cm-search" style="flex:1">${ic('search',15)}搜索本群消息</div><small style="color:var(--muted);font-size:var(--fs-cap)">共 24 条</small></div>
      <div class="hist">${m('me','大家今天辛苦了','21:38')}${m('claude','你好呀，今天也一起加油。','21:38')}${m('deepseek','主人今天改了好多设计稿呢，记得喝水哦。','21:39')}${m('gemini','我就说今天会顺利吧！','21:40')}</div>`,`<span class="btn ghost">${ic('download',14)}导出群聊记录</span><span class="grow"></span><span class="btn">关闭</span>`,620,60),pins:[[1,317,140],[2,317,260],[3,317,489]]})},
  notes:['记录改成和对话历史一样的气泡：我在右、成员在左，带头像，名字用各自的主题色。','搜索框旁写一共多少条。','「导出群聊记录」放在底部左侧，导出后给提示（现在点了没有反馈）。']});

S({id:'4.14',sec:4,title:'群聊弹窗 · 群聊 CG 图鉴',before:[['deepseek-group-dialog-cg','DeepSeek · 空']],
  render:t=>grpPage(t,{},{overlay:gmodal('群聊 CG 图鉴',`<div style="display:flex;align-items:center;gap:8px"><p class="gx-hint" style="margin:0;flex:1">只显示本群的合影，包括历史生成和重试记录。</p><span class="btn sm">${ic('refresh',14)}刷新</span></div>
      <div class="cg-grid" style="grid-template-columns:repeat(3,minmax(0,1fr))">
        <div class="cg cgcard"><div class="cg-img" style="${cgpic('claude','art/bg-kimi.webp')}"><span class="tag" style="color:var(--ok)">生成成功</span></div><div class="cg-m"><b>月夜图书室</b><span>Fixture · 10/21 21:52</span></div></div>
        <div class="cg cgcard"><div class="cg-img wait"><i class="spinner"></i>正在设计合影主题<span class="steps"><i class="d"></i><i></i><i></i></span></div><div class="cg-m"><b>群聊合影</b><span>排队中 · 刚刚</span></div></div>
        <div class="cg cgcard"><div class="cg-img fail">${ic('alert',20)}生成失败<span class="btn sm">重试此合影</span></div><div class="cg-m"><b>群聊合影</b><span>10/20 22:10</span></div></div></div>`,'<span class="grow"></span><span class="btn">关闭</span>',800,110),pins:[[1,227,190],[2,227,330],[3,1040,330]]}),
  notes:['卡片和私聊 CG 图鉴同一套样式：生成中带进度，失败的卡片上直接「重试此合影」。','状态用小标签写在缩略图上，主题名和绘图连接、日期写在下面。','点开详情和大图沿用 3.9、3.11 的样式。']});

// prompt-planning model for group photos: step 1 writes the prompt (a chat connection), step 2 draws (the CG connection)
const planStep = (o={})=>{const {sel='自动 · 跟随入口角色',sub='Claude 的连接 · Fixture · fixture-model',tag='',foot=`<span class="ok">${ic('check',12)}已为这个群保存</span>`,err='',open=false}=o;
  return `<div class="pipe"><div class="step on"><span class="step-h"><b>1</b>写画面提示词 · 策划模型</span><span class="select full${open?' open':''}" style="${err?'border-color:var(--err)':''}"><span style="display:flex;flex-direction:column;line-height:1.2;min-width:0"><span>${sel}</span><small style="font-size:10px;color:var(--muted)">${sub}</small></span>${tag}</span>${err?`<span class="step-err">${ic('alert',13)}${err}</span>`:`<span class="step-f">${foot}</span>`}</div>
    ${ic('chevron',16)}<div class="step"><span class="step-h"><b>2</b>出图 · CG 绘图连接</span><span class="val">${ic('image',16)}<span>Codex 内置绘图<br><small>image_gen · 1536×1024</small></span></span><span class="step-f">在 API 配置里改<span class="lnk">去设置</span></span></div></div>`;};
const photoBody = (extra='',o={})=>`<p class="gx-hint" style="margin:0">按这次已经呈现的群聊内容设计画面。选中的人都用自己的参考图。</p>
      <p style="margin:0;font-size:var(--fs-sm)"><b>12 条对话 · 4 位参与者</b> · 点头像取消</p>
      <div class="parts">${MEM.map((id,k)=>`<span class="${k===2?'':'on'}">${face(id,'mini-face')}${TH(id).name}${k===2?'':ic('check',14)}</span>`).join('')}</div>
      <h4 class="sub-h" style="margin:6px 0 0">画面怎么生成</h4>${planStep(o)}${extra}`;
S({id:'4.15',sec:4,title:'群聊合影 CG 弹窗（含提示词策划模型）',before:[],
  render:t=>grpPage(t,{panel:grpPanel(t,{speaker:'gemini',line:'今天大家都辛苦啦，早点休息！',round:'done',metaDis:false})},{overlay:gmodal('群聊合影 CG',photoBody(`<div class="gx-alert info" style="color:var(--text)">${ic('info',16)}<span class="grow">这段对话已经有合影。查看不会发请求；重新生成会按上面的设置调用一次。已经在跑的任务和重试仍用原来的模型和提示词。</span></div>`),`<span class="btn ghost">查看已有合影</span><span class="grow"></span><span class="btn">取消</span><span class="btn primary">${ic('camera',15)}重新生成一张</span>`,640,60),pins:[[1,327,72],[2,327,196],[3,327,300],[4,640,330],[5,327,370],[6,327,424]]}),
  notes:['加标题栏和右上角 ×（现在没有关闭按钮，只能按 Esc）。','参与者从复选框列表改成可以点的头像标签，选中的打勾。','新加的「提示词策划模型」做成「画面怎么生成」两步：① 写画面提示词（策划模型，可选）→ ② 出图（CG 绘图连接，只显示，去 API 配置里改）。一眼看出两个模型各管什么，替代现在下拉框下面的四五行说明文字。','下拉框里直接写选中的是什么：「自动 · 跟随入口角色」下面一行写解析出来的实际连接和模型（现在要看下面单独一行「本次策划模型：…」）。','去掉「保存选择」按钮：换了就自动按群保存，下面写「已为这个群保存」；生成时也会一起保存（和现在一样）。','已有合影时的提示条合进一句：重新生成会按上面的设置调用一次，已经在跑的任务和重试不受影响。']});
S({id:'4.16',sec:4,title:'提示词策划模型：下拉选项 · 联网关闭 · 连接失效',before:[],
  render:t=>{const card=(cap,body)=>`<div><p class="st-cap">${cap}</p><article class="card">${body}</article></div>`;
    const saved=`<span class="ok">${ic('check',12)}已为这个群保存</span>`;
    const dd=`<div class="dd"><div class="opt sel">${ic('refresh',16)}<div><b>自动 · 跟随入口角色</b><small>现在是 Claude 的连接 · Fixture · fixture-model</small></div>${ic('check',16)}</div><p>指定一个聊天连接 · 按群保存</p>
      <div class="opt">${ic('terminal',16)}<div><b>本机 Codex 登录</b><small>gpt-6-astra</small></div><span class="tag">effort low</span></div>
      <div class="opt">${ic('terminal',16)}<div><b>DeepSeek 官方</b><small>deepseek-chat</small></div></div>
      <div class="opt">${ic('terminal',16)}<div><b>Fixture</b><small>fixture-model</small></div></div>
      <div class="opt dis">${ic('terminal',16)}<div><b>Kimi 开放平台</b><small>不可用 · 连接已停用</small></div></div></div>`;
    return shell(t,{page:'galgame',height:900,content:`<div class="st-grid">
      ${card('下拉展开',planStep({open:true})+dd)}
      ${card('联网聊天关着 · 选的是「自动」',planStep({foot:saved})+`<div class="gx-alert info" style="color:var(--text)">${ic('globe',16)}<span class="grow">联网聊天关着，这次用本地模板写提示词；开启后才会调用策划模型。</span><span class="gx-gbtn" style="color:var(--text)">开启联网聊天</span></div>`)}
      ${card('联网聊天关着 · 指定了连接',planStep({sel:'DeepSeek 官方',sub:'deepseek-chat',foot:saved})+`<div class="gx-alert warn" style="color:var(--text)">${ic('alert',16)}<span class="grow">要用 DeepSeek 官方写提示词，先开启联网聊天。</span><span class="gx-gbtn" style="color:var(--text)">开启联网聊天</span></div><div style="display:flex;justify-content:flex-end;gap:8px"><span class="btn">改回自动</span><span class="btn primary dis" title="先开启联网聊天">${ic('camera',15)}生成合影</span></div>`)}
      ${card('选的连接失效了',planStep({sel:'Kimi 开放平台',sub:'连接已停用',err:'Kimi 开放平台已停用，换一个连接或去 API 配置启用。'})+`<div style="display:flex;justify-content:flex-end;gap:8px"><span class="btn">去 API 配置</span><span class="btn">改回自动</span><span class="btn primary dis">${ic('camera',15)}生成合影</span></div>`)}
    </div>`,pins:[[1,199,150],[2,764,150],[3,199,590],[4,764,590]]})},
  notes:['下拉选项分两段：最上面是「自动 · 跟随入口角色」，写出现在实际解析到哪个连接；下面是「指定一个聊天连接 · 按群保存」，每项写连接名、模型和推理强度，不可用的变灰并写原因（已停用、未设置模型、不支持聊天）。','联网聊天关着、选的是「自动」：用蓝色提示说明这次用本地模板，旁边直接给「开启联网聊天」。','联网聊天关着、但指定了连接：黄色提示说明要先开联网，「生成合影」变灰并悬停说明原因，也可以一键「改回自动」（现在要点了生成才报错）。','选的连接被删除或停用：红字写在选择框下面，给「去 API 配置」和「改回自动」，生成按钮变灰。']});
