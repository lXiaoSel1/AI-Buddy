/* ---------- section 5: desktop pet ---------- */
Object.assign(I, {
  moon:'<path d="M19 14.5A7.5 7.5 0 0 1 9.5 5a7.5 7.5 0 1 0 9.5 9.5z"/>',
  hand:'<path d="M8 13V6.5a1.5 1.5 0 0 1 3 0V12M11 11V5a1.5 1.5 0 0 1 3 0v6M14 11V6a1.5 1.5 0 0 1 3 0v7M17 12.5V9.5a1.5 1.5 0 0 1 3 0v5.5a6 6 0 0 1-6 6h-2a6 6 0 0 1-4.6-2.1L5 15.5a1.5 1.5 0 0 1 2.3-1.9L8 14.5"/>'
});
// the stage for pet surfaces: no app window, just desktops; pins are placed like shell() does
const p5 = (t,html,pins=[])=>`<div class="p5 tscope" data-t="${t.id}" data-o="gen" data-mode="${t.mode}">${html}${pins.map(([n,x,y])=>`<b class="pin" style="left:${x}px;top:${y}px">${n}</b>`).join('')}</div>`;
const pw = (t,{badge='',bubble='',cls='',extra=''}={})=>`<div class="pw ${cls}${bubble?' bub':''}">${bubble}${extra}<img class="pw-sprite" src="${A(`art/pet-${t.id}.webp`)}" alt="">${badge}</div>`;
const pb = (inner,cls='')=>`<span class="pb ${cls}">${inner}</span>`;
const cell = (cap,body)=>`<div class="cell">${body}<p>${cap}</p></div>`;
const BADGES = [
  ['平时',pb('<i class="d"></i>AI 酱<small>· 陪着你</small>')],
  ['有会话在跑',pb('<i class="d ok"></i>工作中<small>· 2 个会话</small>')],
  ['等你回应',pb('<i class="d warn"></i>等你回应<small>· Codex</small>')],
  ['整理本地记录',pb('<i class="spinner"></i>正在整理本地记录')],
  ['悬停：可点、可关',pb(`<i class="d ok"></i>工作中<small>· 2 个会话</small><span class="pb-x" title="关闭状态条">${ic('close',12)}</span>`,'hover')]
];
S({id:'5.1',sec:5,title:'桌宠状态条（深色和浅色桌面）',before:[['pet-now','DeepSeek 和 Claude · 平时']],
  render:t=>p5(t,`<div class="desk" style="--n:5"><span class="desk-cap">深色桌面</span>${BADGES.map(([c,b])=>cell(c,pw(t,{badge:b}))).join('')}</div>
    <div class="desk light" style="--n:5"><span class="desk-cap">浅色桌面</span>${BADGES.map(([c,b])=>cell(c,pw(t,{badge:b}))).join('')}</div>
    <div class="desk" style="--n:5;margin-top:12px"><span class="desk-cap">现在的样子（DeepSeek 写死配色示意；右边的 × 是刚加的，一直显示）</span>${[['平时','AI 酱 · 离线陪伴'],['有会话在跑','工作中 · 2 个会话'],['等你回应','等待你的回应'],['整理本地记录','正在整理本地记录'],['演示动作','演示 · 睡眠']].map(([c,s])=>cell(c,pw(t,{badge:pb(s+'<span class="pb-x old">×</span>','old')}))).join('')}</div>`,
    [[1,24,236],[2,268,236],[3,1222,236],[4,24,520],[5,1222,520]]),
  notes:['状态条跟随当前主题配色，并在深色和浅色桌面上都清楚（现在 DeepSeek 是写死的深蓝，其他角色只换色相）。','左边加状态点：平时是灰点，有会话在跑是主题色点，等你回应是黄点，整理记录时转圈；文字缩短成「工作中 · 2 个会话」「等你回应 · Codex」。','状态条现在鼠标放上去是手形、点了却没反应。改成点一下打开工作空间，悬停时描边提示可点。','「AI 酱 · 离线陪伴」改成「AI 酱 · 陪着你」：「离线」容易被理解成程序没在工作。','新加的关闭按钮 × 保留，改成鼠标移到状态条上才在右边出现（和可点的描边一起），悬停写「关闭状态条」。现在的 × 一直显示，两边各留 29px，短的状态也被撑成一整条。关掉后弹一次提示告诉你怎么找回来（见 5.2），右键菜单里也能直接重新打开（见 5.5）。']});

S({id:'5.2',sec:5,title:'桌宠提示气泡',before:[],
  render:t=>p5(t,`<div class="desk" style="--n:5"><span class="desk-cap">深色桌面</span>
    ${cell('任务完成',pw(t,{bubble:`<div class="pbub">${ic('check',16)}<div><b>Codex 完成任务啦</b><small>辛苦了～</small></div></div>`,badge:pb('<i class="d"></i>AI 酱<small>· 陪着你</small>')}))}
    ${cell('多个任务一起完成',pw(t,{bubble:`<div class="pbub">${ic('check',16)}<div><b>Codex 有 3 个任务完成啦</b><small>辛苦了～</small></div></div>`,badge:pb('<i class="d"></i>AI 酱<small>· 陪着你</small>')}))}
    ${cell('日志里有错误',pw(t,{bubble:`<div class="pbub err">${ic('alert',16)}<div><b>Claude Code 的日志有 2 条错误</b><span class="lnk">点我查看 ›</span></div></div>`,badge:pb('<i class="d ok"></i>工作中<small>· 1 个会话</small>')}))}
    ${cell('聊天失败',pw(t,{bubble:`<div class="pbub err">${ic('alert',16)}<div><b>聊天暂时失败</b><small>稍后再试，或去 Galgame 看原因。</small></div></div>`}))}
    ${cell('角色说话',pw(t,{bubble:`<div class="pbub say"><b>${esc(t.name)}</b>${esc(t.line).slice(0,40)}</div>`}))}</div>
    <div class="desk light" style="--n:5"><span class="desk-cap">浅色桌面</span>
    ${cell('任务完成',pw(t,{bubble:`<div class="pbub">${ic('check',16)}<div><b>Codex 完成任务啦</b><small>辛苦了～</small></div></div>`}))}
    ${cell('日志里有错误',pw(t,{bubble:`<div class="pbub err">${ic('alert',16)}<div><b>Claude Code 的日志有 2 条错误</b><span class="lnk">点我查看 ›</span></div></div>`}))}
    ${cell('角色说话',pw(t,{bubble:`<div class="pbub say"><b>${esc(t.name)}</b>${esc(t.line).slice(0,40)}</div>`}))}
    ${cell('关掉状态条后',pw(t,{bubble:`<div class="pbub">${ic('info',16)}<div><b>状态条已隐藏<span class="undo">撤销</span></b><small>右键桌宠，或在通用设置 › 桌宠里重新打开。</small></div></div>`}))}<div></div></div>`,
    [[1,24,40],[2,500,40],[3,740,40],[4,980,40],[5,740,330]]),
  notes:['气泡加一个指向角色的小尾巴，跟随主题配色；完成用对勾图标，出错用红色描边和警告图标。','文案拆成两行：粗体写谁、发生了什么，第二行写补充，比「Codex完成任务啦，辛苦了～」一整句更好扫。','出错气泡写着「点我查看」，但现在点了没反应。改成点一下打开工作空间里的 Token 检测，看是哪条日志。','角色说话的气泡单独一种样式：上面一行小字写角色名，正文最多 40 字（沿用现在的截断规则）。','点状态条的 × 关掉后，弹一次气泡：「状态条已隐藏」，可以直接撤销，并说明去哪里重新打开（现在关掉就没了，只有设置页里一句说明）。']});

S({id:'5.3',sec:5,title:'睡眠 · 拖动 · 飞行 · 落地时的状态',before:[],
  render:t=>p5(t,`<div class="desk" style="--n:5"><span class="desk-cap">深色桌面</span>
    ${cell('睡着了<small>5 分钟没动静</small>',pw(t,{cls:'sleep',extra:'<span class="zz">Z<i>z</i>z</span>',badge:pb(`${ic('moon',14)}睡着了<small>· 点一下叫醒</small>`)}))}
    ${cell('左键拖动<small>走路</small>',pw(t,{cls:'drag',badge:pb(`${ic('hand',14)}拖着走<small>· 松开放下</small>`)}))}
    ${cell('右键拖动<small>准备抛出</small>',pw(t,{cls:'drag',badge:pb(`${ic('hand',14)}按住左键蓄力<small>· Esc 取消</small>`)}))}
    ${cell('飞行中<small>状态条先藏起来</small>',pw(t,{cls:'fly',extra:'<span class="speed"></span>'}))}
    ${cell('落地<small>站稳后状态条回来</small>',pw(t,{extra:'<span class="dust"></span>',badge:pb('<i class="d"></i>AI 酱<small>· 陪着你</small>')}))}</div>`,
    [[1,24,40],[2,268,40],[3,500,40],[4,740,40]]),
  notes:['睡着时状态条写「睡着了 · 点一下叫醒」，头上有 Zz（现在睡着和醒着时状态条一样，看不出来为什么不动了）。','左键拖动时提示「拖着走 · 松开放下」。','右键拖动时提示操作方法「按住左键蓄力 · Esc 取消」，替代设置页里那段很长的说明。','飞行中先隐藏状态条，免得它跟着角色乱飞；落地站稳后再出现。']});

const gloveSvg = (state,cuff,stroke='#40576d')=>{const p=state==='open'?'<path d="M12 17V6q0-3 3-3t3 3v9h1V4q0-3 3-2t2 3v11h1V7q0-3 3-2t2 3v12q0-1 2-1 4 0 1 6l-4 7q-1 2-3 2H14q-3 0-5-3l-5-7q-2-4 1-5 2-1 4 2l3 3z"/>':state==='grab'?'<path d="M9 18v-7q0-4 4-3l1 7V9q0-4 4-3l2 8V9q1-4 5-2l1 9 2-3q3-3 5 1l-4 12-3 7H13l-2-7-6-3q-4-3-1-6 2-2 5 1z"/><path fill="none" d="M13 17l6 2 6-1"/>':'<path d="M9 16v-3q0-4 4-3 0-5 5-3 2-4 6-1 5-1 6 4l1 9q0 2-2 5l-2 7H13l-2-5-5-5q-3-4 0-6 2-1 3 1z"/>';
  return `<svg viewBox="0 0 40 40" aria-hidden="true"><g fill="#fffdf8" stroke="${stroke}" stroke-width="1.6" stroke-linejoin="round">${p}<path fill="${cuff}" d="M13 31h15v5H13z"/></g></svg>`;};
S({id:'5.4',sec:5,title:'手套光标和抛掷轨迹',before:[],
  render:t=>{const P=[[300,262],[0,0]];const pts=[];for(let k=0;k<=12;k++){const u=k/12,x=(1-u)*(1-u)*300+2*(1-u)*u*560+u*u*860,y=(1-u)*(1-u)*262+2*(1-u)*u*10+u*u*330;pts.push([x,y])}
    return p5(t,`<div class="p5-two"><div>
      <p class="g-cap">改后：袖口用主题色</p><div class="glove-row">${['open','closed','grab'].map((s,k)=>`<div class="glove">${gloveSvg(s,'var(--accent)')}${['悬停','按下','拖动 / 蓄力'][k]}</div>`).join('')}</div>
      <p class="g-cap" style="margin-top:22px">现在：所有主题都是灰蓝袖口</p><div class="glove-row">${['open','closed','grab'].map((s,k)=>`<div class="glove">${gloveSvg(s,'#e3ecf5')}${['悬停','按下','拖动 / 蓄力'][k]}</div>`).join('')}</div>
      <p class="gx-hint" style="margin-top:22px;color:var(--pg-muted)">手套是原创矢量图，形状不变，只换袖口颜色。</p></div>
      <div class="traj"><svg class="lines" viewBox="0 0 900 420" preserveAspectRatio="none">
        <line x1="300" y1="262" x2="190" y2="352" stroke="var(--a2)" stroke-width="2.5" stroke-dasharray="6 5" stroke-linecap="round"/>
        ${pts.slice(1).map(([x,y],k)=>`<circle cx="${x.toFixed(0)}" cy="${y.toFixed(0)}" r="${(5-k*0.25).toFixed(1)}" fill="var(--bar-end)" opacity="${(1-k*0.065).toFixed(2)}"/>`).join('')}
        <ellipse cx="860" cy="372" rx="34" ry="8" fill="none" stroke="var(--bar-end)" stroke-width="2" stroke-dasharray="4 4" opacity=".8"/></svg>
        ${pw(t,{cls:'drag'}).replace('class="pw drag"','class="pw drag" style="left:180px;top:150px"')}
        <span class="glv" style="left:166px;top:330px">${gloveSvg('grab','var(--accent)')}</span>
        <span class="str" style="left:236px;top:368px">标准力度<i><s></s></i>72%</span></div></div>`,
      [[1,20,40],[2,560,40],[3,880,330],[4,560,380]])},
  notes:['手套光标形状不变，袖口换成当前主题的主色（现在所有主题都是灰蓝色）。','拖拽皮筋（虚线）和预测轨迹跟随主题配色：皮筋用主题的第二色，轨迹用渐变尾色。','预测轨迹改成由大到小、由实到淡的圆点，终点画一个落点圈，看得出会落在哪（现在是一根细实线，没有落点）。','蓄力时在手边显示力度条和百分比，「标准力度」跟着设置里的抛掷力度。']});

S({id:'5.5',sec:5,title:'托盘菜单和右键菜单（系统原生）',before:[],
  render:t=>{const tray=dark=>`<div class="nmenu${dark?' dark':''}"><div class="it"><span class="ck"></span>工作概览</div><div class="it"><span class="ck"></span>通用设置</div><div class="it"><span class="ck"></span>动作展示</div><div class="it"><span class="ck"></span>打开 Galgame</div><div class="sep"></div><div class="it"><span class="ck">✓</span>显示桌宠</div><div class="it"><span class="ck">✓</span>拖动模式（整个窗口可拖动）</div><div class="sep"></div><div class="it"><span class="ck"></span>退出</div></div>`;
    const ctx=dark=>`<div class="nmenu${dark?' dark':''}"><div class="it"><span class="ck"></span>打开工作空间</div><div class="it new"><span class="ck"></span>打开 Galgame<span class="tag">新增</span></div><div class="sep"></div><div class="it new"><span class="ck"></span>让她睡一会儿<span class="tag">新增</span></div><div class="it new"><span class="ck">✓</span>显示状态条<span class="tag">新增</span></div><div class="it new"><span class="ck"></span>隐藏桌宠<span class="tag">新增</span></div></div>`;
    return p5(t,`<div class="nm-wrap">
      <div class="nm-col"><h5>右键菜单 · 浅色系统</h5>${ctx(false)}<small>现在只有「打开工作空间」一项。建议加上常用的几项；睡着时「让她睡一会儿」变成「叫醒她」。「显示状态条」可以勾选，关掉状态条后从这里就能找回来。</small></div>
      <div class="nm-col"><h5>右键菜单 · 深色系统</h5>${ctx(true)}</div>
      <div class="nm-col"><h5>托盘菜单 · 浅色系统</h5>${tray(false)}<small>页面入口和开关之间加一条分隔线，其余不变。</small></div>
      <div class="nm-col"><h5>托盘菜单 · 深色系统</h5>${tray(true)}</div></div>
      <p class="gx-hint" style="margin-top:20px;color:var(--pg-muted)">这两个菜单是 Windows 系统原生的，外观跟随系统浅色 / 深色，没办法套用 AI 酱的主题，只能改里面的内容。</p>`,
      [[1,6,372],[2,20,112],[3,530,112]])},
  notes:['托盘菜单和右键菜单是 Windows 原生菜单，样式跟系统走，不跟主题走；这里只调整内容。','右键菜单从一项扩成五项：打开工作空间、打开 Galgame、让她睡一会儿（睡着时变成「叫醒她」）、显示状态条（可勾选，用来找回点 × 关掉的状态条）、隐藏桌宠。','托盘菜单在页面入口和两个开关之间加一条分隔线。']});
