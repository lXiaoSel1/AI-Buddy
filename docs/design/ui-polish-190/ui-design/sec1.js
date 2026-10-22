/* ---------- section 1 addendum: avatars follow the current pet, centred crops, taskbar and tray icons ---------- */
const faceOld = id=>`<span class="face-old"><img src="${A(`art/pet-${id}.webp`)}" alt=""></span>`;
const tbIcon = (id,cls='')=>`<span class="tb-ico ${cls}"><img src="${A(`extra/head-${id}.webp`)}" alt=""></span>`;
const taskbar = (t,dark)=>`<div class="tb${dark?' dark':''}"><span class="tb-app"><i style="--c:#0067c0;border-radius:3px;width:18px;height:18px"></i></span><span class="tb-app"><i style="--c:#e8a33d"></i></span><span class="tb-app"><i style="--c:#2f9e44"></i></span><span class="tb-app on">${tbIcon(t.id)}</span><span class="tb-app"><i style="--c:#7048e8"></i></span>
  <span class="grow"></span><span class="tb-tray hl">${tbIcon(t.id,'sm')}<span style="opacity:.6">⌃</span></span><span class="tb-clock"><span>21:40</span><span>2026/10/21</span></span></div>`;
S({id:'1.12',sec:1,title:'头像跟随当前桌宠 · 任务栏和托盘图标',before:[['avatar-now','Claude 主题下：侧栏、标题栏仍是 DeepSeek 全身小图；右边是任务栏现在的图标']],
  render:t=>{const other=t.id==='claude'?'chatgpt':'claude';
    return `<div class="win tscope" data-t="${t.id}" data-o="gen" data-mode="${t.mode}" style="height:auto"><div class="av-wrap">
    <div class="av-card"><h4>侧栏和标题栏<small>当前桌宠 · ${esc(t.name)}</small></h4>
      <div class="av-mini"><div class="win-bar">${face(t.id)}<span>AI 酱 · 本地工作监控</span>${CAPTION}</div><div class="logo"><span class="ava">${face(t.id)}</span><div><b>AI 酱</b><small>AI Buddy</small></div></div></div>
      <div class="av-swap">换桌宠角色后一起换：${face(other,'mini-face')}<b>${TH(other).name}</b>${ic('chevron',14)}</div>
      <h4 style="margin-top:8px">各尺寸<small>同一张头像裁剪</small></h4>
      <div class="av-sizes">${[16,24,32,40,64].map(s=>`<span><span class="mini-face" style="width:${s}px;height:${s}px;box-shadow:0 0 0 1px var(--border);background:var(--surface2)"><img class="hd" src="${A(`extra/head-${t.id}.webp`)}" alt=""></span>${s}px</span>`).join('')}</div></div>
    <div style="display:flex;flex-direction:column;gap:20px;min-width:0">
      <div class="av-card"><h4>11 个角色的头像<small>改后按每个角色眼睛的位置单独裁剪</small></h4>
        <div class="av-grid"><span class="rh">现在<small>统一裁剪</small></span>${ROSTER.map(id=>faceOld(id)).join('')}
          <span class="rh">改后<small>脸在正中</small></span>${ROSTER.map(id=>face(id,'mini-face')).join('')}
          <span></span>${ROSTER.map(id=>`<span class="nm">${TH(id).name}</span>`).join('')}</div></div>
      <div class="av-card" style="position:relative"><h4>Windows 任务栏<small>任务栏按钮 + 右下角托盘图标</small></h4>
        ${taskbar(t,false)}${taskbar(t,true)}
        <span class="tb-tip" style="right:120px;top:4px">AI 酱 · ${esc(t.name)} 陪着你</span></div>
    </div></div>${[[1,8,24],[2,452,24],[3,452,236],[4,1150,296]].map(([n,x,y])=>`<b class="pin" style="left:${x}px;top:${y}px">${n}</b>`).join('')}</div>`;},
  notes:['侧栏头像和标题栏小图标改成当前桌宠的头像，换桌宠角色时一起换（现在固定是 DeepSeek 的全身小图，换成 Claude 主题也一样）。','头像按每个角色眼睛的位置单独裁剪，脸正好在圆圈中间（现在所有角色共用一个裁剪点：左右居中、往下 14%，Claude、GPT、Seed、Qwen 明显偏）。主题芯片、角色列表、群聊成员等所有用到头像的地方一起换成这套裁剪。','任务栏上的程序按钮和右下角托盘图标换成当前桌宠的圆形头像，切换桌宠后跟着换；托盘悬停提示写「AI 酱 · DeepSeek 陪着你」这类当前角色。','有一处 Windows 限制：如果把 AI 酱「固定到任务栏」，固定的按钮可能仍显示安装时的默认图标；桌面、开始菜单快捷方式和安装包也一直是默认图标。实现时先在这台电脑上实测，做不到的地方会如实告诉你，托盘图标不受这个限制。']});
