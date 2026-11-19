// Stage rules and icon paths adapted from the approved Galgame prototype (ui.css / index.html).
export const GALGAME_REDESIGN_STYLE = `
@font-face{font-family:"Galgame Noto Serif SC";src:url("./assets/galgame-fonts/noto-serif-sc.woff2") format("woff2");font-style:normal;font-weight:400 700;font-display:swap}
@font-face{font-family:"Galgame Cormorant Garamond";src:url("./assets/galgame-fonts/cormorant-garamond-italic.woff2") format("woff2");font-style:italic;font-weight:500;font-display:swap}
:where(.gx-redesign),.gx-paper-dialog,.gx-paper,.gx-settings-dialog,.gx-gift-paper{
 --dlg-bg:var(--buddy-dlg-bg);--dlg-text:var(--buddy-dlg-text);--dlg-muted:var(--buddy-dlg-muted);--dlg-border:var(--buddy-dlg-border);--choice-bg:var(--buddy-choice-bg);--acc:var(--buddy-accent);--acc-t:var(--buddy-accent-text);--on-acc:var(--buddy-on-accent);--ok:var(--buddy-ok);--warn:var(--buddy-warn);--err:var(--buddy-err);--bar-end:var(--buddy-bar-end);--r:var(--buddy-r-dlg);--rb:var(--buddy-r-btn);--rc:var(--buddy-r-card);--orn:var(--buddy-orn-image);--sans:var(--buddy-f-ui,system-ui);--serif:"Galgame Noto Serif SC","Source Han Serif SC","SimSun",serif;--latin:"Galgame Cormorant Garamond",Georgia,serif;

 --glass:color-mix(in srgb,var(--dlg-bg) 78%,transparent);--gline:var(--dlg-border);--shade:color-mix(in srgb,var(--dlg-bg) 90%,transparent);--veil:color-mix(in srgb,var(--dlg-bg) 76%,transparent);--sheetbg:color-mix(in srgb,var(--dlg-bg) 96%,transparent);--dim:color-mix(in srgb,var(--dlg-text) 74%,transparent);--tsh:0 1px 3px rgba(0,0,0,.6);--hov:rgba(255,255,255,.1)
}
html[data-scheme="light"] .gx-redesign[data-stage-scheme="dark"]{
 --dlg-bg:color-mix(in srgb,var(--acc) 10%,#0D0F14);--dlg-text:#F5F2EE;--dlg-muted:color-mix(in srgb,var(--acc) 12%,#C9C3BC);--dlg-border:rgba(255,255,255,.2);--choice-bg:color-mix(in srgb,var(--acc) 16%,#15171D);--acc-t:color-mix(in srgb,var(--acc) 55%,#FFFFFF)
}
html[data-scheme="dark"] .gx-redesign[data-stage-scheme="light"]{
 --dlg-bg:color-mix(in srgb,var(--acc) 6%,#FBFAF7);--dlg-text:color-mix(in srgb,var(--acc) 10%,#15171C);--dlg-muted:color-mix(in srgb,var(--acc) 18%,#4E5260);--dlg-border:rgba(20,22,28,.14);--choice-bg:color-mix(in srgb,var(--acc) 8%,#F3F1EC);--acc-t:color-mix(in srgb,var(--acc) 62%,#000000)
}
.gx-redesign[data-stage-scheme="light"]{
 --glass:color-mix(in srgb,var(--dlg-bg) 95%,transparent);--veil:color-mix(in srgb,var(--dlg-bg) 92%,transparent);--shade:color-mix(in srgb,var(--dlg-bg) 95%,transparent);--tsh:0 0 6px rgba(255,255,255,.95),0 0 2px rgba(255,255,255,.9);--hov:rgba(0,0,0,.06)
}
html[data-scheme="light"] :is(.gx-paper-dialog,.gx-paper,.gx-settings-dialog,.gx-gift-paper){--hov:rgba(0,0,0,.06)}
.gx-redesign{
 color:var(--dlg-text);isolation:isolate;container-type:inline-size;
 .ic{width:17px;height:17px;flex:none}
 .spr{position:absolute;left:50%;top:36px;height:864px;transform:translateX(-50%)}
 .spr img{height:100%;width:auto;display:block;filter:drop-shadow(0 9px 14px rgba(0,0,0,.25))}
.bub{position:absolute;left:58%;top:18px;width:66px;height:66px;opacity:0;pointer-events:none}
.bub svg{width:100%;height:100%;overflow:visible}
.bub.on{animation:gx-redesign-pop 1.4s ease-out both}
.bub.still{opacity:1}
@keyframes gx-redesign-pop{0%{opacity:0;transform:translateY(7px) scale(.4)}14%{opacity:1;transform:translateY(-4px) scale(1.12)}24%{transform:none}78%{opacity:1;transform:translateY(-9px)}100%{opacity:0;transform:translateY(-17px) scale(.96)}}
.m-hop{animation:gx-redesign-hop .38s ease-out}.m-hop2{animation:gx-redesign-hop2 .62s ease-out}.m-shake{animation:gx-redesign-shake .45s ease-in-out}.m-shiver{animation:gx-redesign-shiver .5s linear}.m-back{animation:gx-redesign-back .42s ease-out}.m-closer{animation:gx-redesign-closer 1.6s ease-in-out}.m-sink{animation:gx-redesign-sink .8s ease-in-out}
@keyframes gx-redesign-hop{0%,100%{transform:translateX(-50%)}40%{transform:translateX(-50%) translateY(-23px)}}
@keyframes gx-redesign-hop2{0%,50%,100%{transform:translateX(-50%)}20%,72%{transform:translateX(-50%) translateY(-19px)}}
@keyframes gx-redesign-shake{0%,100%{transform:translateX(-50%)}20%{transform:translateX(calc(-50% - 15px))}40%{transform:translateX(calc(-50% + 14px))}60%{transform:translateX(calc(-50% - 10px))}80%{transform:translateX(calc(-50% + 6px))}}
@keyframes gx-redesign-shiver{0%,100%{transform:translateX(-50%)}10%,30%,50%,70%,90%{transform:translateX(calc(-50% - 4px))}20%,40%,60%,80%{transform:translateX(calc(-50% + 4px))}}
@keyframes gx-redesign-back{0%,100%{transform:translateX(-50%) scale(1)}45%{transform:translateX(-50%) translateY(9px) scale(.965)}}
@keyframes gx-redesign-closer{0%,100%{transform:translateX(-50%) scale(1)}35%,70%{transform:translateX(-50%) translateY(7px) scale(1.06)}}
@keyframes gx-redesign-sink{0%,100%{transform:translateX(-50%)}45%,60%{transform:translateX(-50%) translateY(22px)}}
@media (prefers-reduced-motion:reduce){.spr[class*="m-"],.bub.on,.sheet,.cursor,.caret{animation:none}}

.shade{position:absolute;inset:0;background:linear-gradient(to bottom,transparent 45%,var(--shade) 100%);pointer-events:none}
.textcard{position:absolute;left:50%;top:150px;transform:translateX(-50%);width:300px;padding:26px 24px;text-align:center;background:var(--glass);border:1px solid var(--gline);border-radius:var(--r);backdrop-filter:blur(8px)}
.textcard .av{width:72px;height:72px;border-radius:50%;margin:0 auto 10px;background:var(--acc);display:grid;place-items:center;color:var(--on-acc);font:700 30px var(--serif)}
.textcard b{display:block;font:700 20px var(--serif);letter-spacing:.2em}
.textcard span{font-size:13.5px;color:var(--dlg-muted)}

/* corners */
.corner{position:absolute;display:flex;gap:8px;align-items:center;z-index:2}
.tl{left:23px;top:17px}.tr{right:23px;top:17px;flex-direction:column;align-items:flex-end;gap:9px}.br{right:23px;bottom:22px}
.glass{display:flex;align-items:center;gap:2px;background:var(--glass);border:1px solid var(--gline);border-radius:13px;backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);padding:3px 5px}
.gb{display:flex;align-items:center;gap:6px;font-size:13px!important;background:transparent;border:0;border-radius:9px;padding:5px 9px;cursor:pointer;white-space:nowrap;color:var(--dlg-text)}
.gb:hover{background:var(--hov)}
.gb.on{color:var(--dlg-text);background:color-mix(in srgb,var(--acc) 22%,transparent)}
.gb.warn{color:var(--warn)}
.gb.bad{color:var(--err)}
.gb.mute{color:var(--dlg-muted)}
.gb .badge{font-size:11px;background:var(--acc);color:var(--on-acc);border-radius:999px;padding:0 6px;line-height:16px}
.gs{width:1px;height:19px;background:var(--gline)}
.dot{width:7px;height:7px;border-radius:50%;background:var(--ok);flex:none}
.dot.off{background:var(--dlg-muted)}.dot.mood{background:var(--acc-t)}.dot.busy{background:var(--warn);animation:gx-redesign-blink 1s steps(2,start) infinite}
.hd{width:24px;height:24px;border-radius:50%;background:center/cover;flex:none;border:1px solid var(--gline)}
&.hidden-ui .corner,&.hidden-ui .say,&.hidden-ui .bottom,&.hidden-ui .choices,&.hidden-ui .grail,&.hidden-ui .gcap{opacity:0;pointer-events:none}
&.hidden-ui .shade{opacity:0}
.hidehint{position:absolute;left:50%;bottom:18px;transform:translateX(-50%);font-size:12px;color:var(--dlg-text);letter-spacing:.2em;background:var(--glass);border:1px solid var(--gline);border-radius:999px;padding:3px 14px;backdrop-filter:blur(14px)}


.say{position:absolute;left:17.421875%;width:57.03125%;bottom:94px;z-index:1}
.nm{display:flex;align-items:center;gap:8px;font:700 clamp(14px,1.484375cqw,20px) var(--serif);letter-spacing:.32em;text-shadow:var(--tsh)}
.nm .ic{color:var(--acc-t);width:18px;height:18px}
.nm .rule{flex:1;height:1px;background:linear-gradient(to right,color-mix(in srgb,var(--dlg-text) 50%,transparent),transparent);margin-left:6px}
.nm .lv{font:500 11.5px var(--sans);letter-spacing:.04em;color:var(--dlg-muted);display:flex;align-items:center;gap:6px}
.nm .lv i{display:block;width:54px;height:3px;border-radius:2px;background:color-mix(in srgb,var(--dlg-text) 18%,transparent);position:relative;overflow:hidden}
.nm .lv i::after{content:"";position:absolute;inset:0;width:var(--p,50%);background:linear-gradient(90deg,var(--acc),var(--bar-end))}
.tx{font-family:var(--serif);font-size:clamp(15px,calc(1.71875cqw * var(--gx-font-scale,1)),26px);line-height:1.62;letter-spacing:.06em;margin-top:9px;text-shadow:var(--tsh);min-height:1.6em}
.tx .past{color:var(--dim)}
.tx .narr{color:var(--dlg-muted);font-size:20px}
.caret{display:inline-block;margin-left:8px;font-size:.7em;animation:gx-redesign-blink 1.1s steps(2,start) infinite}
.cursor{display:inline-block;width:2px;height:1em;background:currentColor;vertical-align:-3px;margin-left:3px;animation:gx-redesign-blink 1s steps(2,start) infinite}
@keyframes gx-redesign-blink{to{visibility:hidden}}
.st{font-size:12.5px;color:var(--dlg-muted);margin-top:6px;display:flex;gap:10px;align-items:center;flex-wrap:wrap;text-shadow:var(--tsh)}
.st a,.lnk{color:var(--acc-t);cursor:pointer;text-decoration:underline;text-underline-offset:3px}
.thinking i{display:inline-block;width:7px;height:7px;border-radius:50%;background:currentColor;margin-right:5px;animation:gx-redesign-dots 1.2s infinite}
.thinking i:nth-child(2){animation-delay:.2s}.thinking i:nth-child(3){animation-delay:.4s}
@keyframes gx-redesign-dots{0%,80%,100%{opacity:.25}40%{opacity:1}}
.errbox{margin-top:10px;padding:12px 14px;border-radius:10px;background:color-mix(in srgb,var(--err) 14%,var(--glass));border:1px solid color-mix(in srgb,var(--err) 45%,transparent);font-size:14px;text-shadow:none}
.errbox b{color:var(--err);font-family:var(--serif);font-size:16px;letter-spacing:.1em}
.notebox{margin-top:10px;padding:10px 14px;border-radius:10px;background:var(--glass);border:1px solid var(--gline);font-size:13.5px;text-shadow:none;display:flex;gap:12px;align-items:center;flex-wrap:wrap}
.acts{display:flex;gap:8px;margin-top:8px;flex-wrap:wrap}
.b{font-size:13px!important;border-radius:var(--rb);padding:6px 14px;border:1px solid var(--gline);background:var(--glass);cursor:pointer;color:var(--dlg-text)}
.b.pri{background:var(--acc);border-color:var(--acc);color:var(--on-acc);font-weight:700}
.b.dng{background:var(--err);border-color:var(--err);color:#fff;font-weight:700}
.b[disabled]{opacity:.45;cursor:not-allowed}
.nm .orn{display:none;width:30px;height:22px;background:var(--orn) center/contain no-repeat;margin:-6px 0 -6px -4px}

/* bottom: choices / line / bar */
.choices{position:absolute;left:50%;transform:translateX(-50%);bottom:max(58px,8%);display:flex;gap:10px;z-index:1}

.ch{font-size:14px!important;background:color-mix(in srgb,var(--choice-bg) 96%,transparent);border:1px solid var(--gline);border-radius:999px;padding:7px 18px;cursor:pointer;backdrop-filter:blur(8px);white-space:nowrap;color:var(--dlg-text)}
.ch b{display:inline-grid;place-items:center;width:19px;height:19px;border-radius:50%;background:var(--acc);color:var(--on-acc);font-size:11.5px;margin-right:8px;vertical-align:1px}
.ch[disabled]{opacity:.5}
.bottom{position:absolute;left:0;right:0;bottom:0;height:0;z-index:1}
.iline{position:absolute;left:50%;transform:translateX(-50%);bottom:23px;font-size:13px!important;color:var(--dim);letter-spacing:.18em;padding:4px 38px;background:transparent;border:0;border-bottom:1px solid color-mix(in srgb,var(--dlg-text) 30%,transparent);cursor:text;text-shadow:var(--tsh);white-space:nowrap}
.iline:hover{color:var(--dlg-text)}
.ibar{position:absolute;left:50%;transform:translateX(-50%);bottom:19px;width:min(794px,calc(100% - 42px));display:flex;gap:8px;align-items:center;background:color-mix(in srgb,var(--dlg-bg) 84%,transparent);border:1px solid var(--gline);border-radius:15px;padding:6px;backdrop-filter:blur(10px)}
.ibar .fld{flex:1;min-width:0;font-size:15px;padding:6px 6px;color:var(--dlg-text);background:transparent;border:0;outline:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ibar .ph{color:var(--dim)}
.ib{display:flex;align-items:center;gap:5px;font-size:13px!important;border:1px solid var(--gline);background:color-mix(in srgb,var(--dlg-text) 7%,transparent);border-radius:10px;padding:6px 11px;cursor:pointer;white-space:nowrap;color:var(--dlg-text)}
.ib.pri{background:var(--acc);border-color:var(--acc);color:var(--on-acc);font-weight:700}
.ib.rec{background:color-mix(in srgb,var(--err) 20%,transparent);border-color:color-mix(in srgb,var(--err) 55%,transparent)}
.ibar .tag{font-size:11.5px;color:var(--acc-t);border:1px solid color-mix(in srgb,var(--acc-t) 45%,transparent);border-radius:6px;padding:1px 7px;white-space:nowrap}
.ihelp{position:absolute;left:max(21px,calc((100% - 794px) / 2));bottom:calc(25px + var(--gx-composer-height,0px));font-size:11.5px;color:var(--dlg-text);padding:1px 10px;border-radius:999px;background:var(--glass);backdrop-filter:blur(10px)}
.recdot{width:10px;height:10px;border-radius:50%;background:var(--err);animation:gx-redesign-blink 1s steps(2,start) infinite;flex:none}
.live{position:absolute;left:223px;width:730px;bottom:70px;z-index:1}
.phases{display:flex;gap:6px;margin-top:12px}
.phases span{font-size:13px;padding:4px 14px;border-radius:999px;border:1px solid var(--gline);background:var(--glass);color:var(--dlg-muted)}
.phases span.now{background:var(--acc);border-color:var(--acc);color:var(--on-acc);font-weight:700}
.phases span.done{color:var(--dlg-text)}


.menu{position:absolute;right:23px;top:63px;width:250px;z-index:5;padding:6px 0;border-radius:var(--r);background:var(--sheetbg);border:1px solid var(--dlg-border);box-shadow:0 14px 34px rgba(0,0,0,.35);backdrop-filter:blur(10px);font-size:14px}
.menu .mi{display:flex;align-items:center;gap:10px;width:100%;text-align:left;border:0;background:transparent;padding:7px 16px;cursor:pointer;color:var(--dlg-text)}
.menu .mi:hover{background:var(--hov)}
.menu .mi .r{margin-left:auto;font-size:12px;color:var(--dlg-muted)}
.menu .mh{padding:6px 16px 4px;font:700 14px var(--serif);letter-spacing:.08em;display:flex;align-items:center;gap:8px;cursor:pointer}
.menu .mh .ic{width:14px;height:14px;color:var(--dlg-muted)}
.menu .mi.dng{color:var(--err)}
.gx-model-info{position:absolute;z-index:5;left:min(180px,max(8px,calc(100% - 318px)));top:63px;width:min(310px,calc(100% - 16px));box-sizing:border-box;background:var(--sheetbg);color:var(--dlg-text);border:1px solid var(--dlg-border);border-radius:var(--r);box-shadow:0 14px 34px rgba(0,0,0,.35);padding:14px 16px;font-size:13.5px;backdrop-filter:blur(10px)}
.gx-model-info h5{margin:0 0 4px;font:700 15px var(--serif);letter-spacing:.12em;display:flex;align-items:center;gap:8px}
.gx-model-info .sub{font-size:12.5px;color:var(--dlg-muted)}
.gx-model-info .row{display:flex;align-items:center;gap:10px;padding:6px 0}
.gx-model-info .grow{flex:1;min-width:0;overflow-wrap:anywhere}
.veil{position:absolute;inset:0;z-index:6;display:flex;align-items:center;justify-content:center;background:rgba(6,10,20,.32);backdrop-filter:blur(7px);-webkit-backdrop-filter:blur(7px)}
.sheet{width:min(998px,calc(100% - 36px));height:min(605px,calc(100% - 36px));border-radius:13px;box-shadow:0 14px 44px rgba(0,0,0,.4);display:flex;flex-direction:column;overflow:hidden;background:var(--sheetbg);color:var(--dlg-text);border:1px solid var(--dlg-border);animation:gx-redesign-rise .32s ease-out}
.sheet.sm{width:min(520px,calc(100% - 36px));height:auto;max-height:605px}
.sheet.md{width:min(760px,calc(100% - 36px));height:auto;max-height:605px}
@keyframes gx-redesign-rise{from{transform:translateY(18px);opacity:0}to{transform:none;opacity:1}}
.shh{display:flex;align-items:center;gap:12px;padding:18px 26px 12px;border-bottom:1px solid var(--dlg-border)}
.shh .orn{width:34px;height:26px;background:var(--orn) center/contain no-repeat;flex:none}
.shh h4{margin:0;font:700 22px var(--serif);letter-spacing:.3em}
.shh .sub{font-family:var(--latin);font-style:italic;font-size:16px;color:var(--dlg-muted)}
.shh .crumb{font-size:12px;color:var(--dlg-muted);margin-left:auto}
.shh .x{font-size:12.5px!important;background:transparent;border:1px solid var(--dlg-border);border-radius:6px;padding:3px 9px;cursor:pointer;color:var(--dlg-text)}
.shb{flex:1;overflow:auto;padding:14px 26px 18px;font-size:14px}
.shf{display:flex;gap:8px;justify-content:flex-end;align-items:center;padding:12px 26px;border-top:1px solid var(--dlg-border)}
.shf .fnote{margin-right:auto;font-size:12.5px;color:var(--dlg-muted)}
.tabs{display:flex;gap:4px;padding:0 26px;border-bottom:1px solid var(--dlg-border)}
.tabs span{font-size:13.5px;padding:8px 12px;border-bottom:2px solid transparent;color:var(--dlg-muted);white-space:nowrap}
.tabs span.on{border-color:var(--acc);color:var(--dlg-text);font-weight:700}
.tabs .cnt{font-size:11px;margin-left:4px;color:var(--dlg-muted)}

.say,.live{isolation:isolate}
.gx-undo-toast{position:absolute;left:50%;top:17px;transform:translateX(-50%);z-index:7;display:flex;gap:12px;align-items:center;background:var(--sheetbg);border:1px solid var(--dlg-border);border-radius:999px;padding:8px 10px 8px 18px;font-size:13.5px;box-shadow:0 10px 28px rgba(0,0,0,.3)}
.whg-toast.gx-toast.gx-stage-cg-toast{position:absolute;left:50%;right:auto;top:17px;bottom:auto;transform:translateX(-50%);z-index:7;display:flex;gap:12px;align-items:center;width:max-content;max-width:calc(100% - 36px);background:var(--sheetbg);color:var(--dlg-text);border:1px solid var(--dlg-border);border-radius:999px;padding:8px 10px 8px 18px;font-size:13.5px;box-shadow:0 10px 28px rgba(0,0,0,.3)}
.whg-toast.gx-toast.gx-stage-cg-toast.err{border-color:var(--err)}
.gx-stage-cg-toast>div,.gx-stage-cg-toast .gx-row-btns{display:flex;align-items:center;gap:12px;flex-direction:row;flex-wrap:wrap}
.gx-stage-cg-toast small{color:var(--dlg-text)}
.say::before,.live::before{content:"";position:absolute;inset:-30px -72px -24px -72px;z-index:-1;pointer-events:none;background:var(--veil);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);
 -webkit-mask-image:linear-gradient(to right,transparent,#000 72px,#000 calc(100% - 72px),transparent),linear-gradient(to bottom,transparent,#000 30px,#000 calc(100% - 20px),transparent);-webkit-mask-composite:source-in;
 mask-image:linear-gradient(to right,transparent,#000 72px,#000 calc(100% - 72px),transparent),linear-gradient(to bottom,transparent,#000 30px,#000 calc(100% - 20px),transparent);mask-composite:intersect}
.iline{background:linear-gradient(to bottom,transparent,var(--veil) 40%);border-radius:10px 10px 0 0;color:var(--dlg-text)}

/* group stage: shared scene layer + three variants (see app.js groupHTML) */
.gscene{position:absolute;inset:0;z-index:0}
.gclip{position:absolute;left:0;right:0;top:0;overflow:hidden;z-index:1}
.gf{position:absolute;transform:translateX(-50%);transform-origin:50% 0;filter:brightness(.55);transition:filter .4s ease,transform .4s cubic-bezier(.2,.8,.2,1)}
.gf img{height:100%;width:auto;display:block;filter:drop-shadow(0 8px 14px rgba(0,0,0,.28))}
.gf.spk{filter:none;z-index:2;transform:translateX(-50%) scale(1.04)}
.gf.gx-figure-back{filter:brightness(.55) blur(1.4px);z-index:1}
.gf.gx-figure-hero{filter:none;z-index:3;transform:translateX(-50%)}
.gf.front{z-index:4}
.gtable2{position:absolute;z-index:3;height:auto;max-width:none;pointer-events:none;filter:drop-shadow(0 -4px 8px rgba(0,0,0,.35))}
.gtable2.soft{z-index:4;filter:blur(2.5px) brightness(.85)}
.gcap{position:absolute;z-index:6;transform:translateX(-50%);font-size:12px;letter-spacing:.14em;padding:1px 10px 1px 11px;border-radius:999px;color:var(--dlg-text);background:color-mix(in srgb,var(--dlg-bg) 72%,transparent);backdrop-filter:blur(8px);white-space:nowrap}
.gcap.spk{font-weight:700;box-shadow:inset 0 -2px 0 var(--acc)}
.grail{position:absolute;right:23px;top:50%;transform:translateY(-50%);z-index:3;display:flex;flex-direction:column;align-items:center;gap:8px;padding:9px 7px;background:var(--glass);border:1px solid var(--gline);border-radius:13px;backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);cursor:pointer;color:var(--dlg-text)}
.grail img{width:38px;height:38px;border-radius:50%;object-fit:cover;background:color-mix(in srgb,var(--dlg-text) 10%,transparent);border:2px solid transparent;filter:brightness(.8)}
.grail img.spk{border-color:var(--acc);filter:none}
.grail img.mute{opacity:.5}
.grail span{font-size:11px}
&:not(.classic){
 --gx-stage-center:50%;
 --gx-top-inset:17px;
 --gx-corner-inset:23px;
 &[data-gx-narrow]{--gx-corner-inset:10px;--gx-top-inset:12px}
 .corner.tr{right:var(--gx-corner-inset);top:var(--gx-top-inset)}
 --gx-history-top:calc(var(--gx-primary-height,37px) + var(--gx-top-inset) + 9px);
 --gx-history-height:var(--gx-history-measured-height,35px);
 --gx-bottom-edge:19px;
 --gx-composer-top:calc(var(--gx-bottom-edge) + var(--gx-composer-height,0px));
 --gx-choice-bottom:calc(var(--gx-composer-top) + 10px);
 &:has(.grail:not(.bc-small-rail)){--gx-stage-center:calc(50% - 45px)}
 .tr > .glass:nth-child(2){position:absolute;right:0;top:calc(100% + 9px)}
 .tr:has(.vx-chat-pop-wrap > .vx-popat,.r95-net-pop > .r95-pop){z-index:7}
 .corner.br{top:calc(var(--gx-history-top) + var(--gx-history-height) / 2);right:calc(var(--gx-corner-inset) + 9px + var(--gx-history-width,45px));bottom:auto;transform:translateY(-50%);z-index:4}
 .grail{top:calc(var(--gx-history-top) + (var(--gx-history-height) + max(var(--gx-history-height),var(--gx-br-height,0px))) / 2 + 10px);transform:none}
 .br .r95-pop{top:calc(100% + 8px);bottom:auto;max-height:calc(var(--gx-stage-h,480px) - var(--gx-history-top) - var(--gx-br-height,40px) - 20px);overflow:auto}
 .br .r95-mood-pop button > span:last-child{min-width:0;max-width:9.5em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
 .br .glass{position:relative}
 .br .r95-pop-wrap{position:static}
 .br .r95-pop{right:calc(-9px - var(--gx-history-width,45px));left:auto;width:min(380px,calc(100cqw - 48px))}
 .corner.tl{max-width:calc(100% - var(--gx-primary-width,190px) - 58px)}
 .corner.tl .glass{min-width:0;max-width:100%}
 .corner.tl .gb:has(.gx-group-title){min-width:0}
 .corner.tl .gb:has(.gx-group-title) > .gx-group-title{min-width:0}
 &:is([data-gx-compact],:lang(en)[data-gx-short]:has(.say .gx-dub-failure)){
  .say .nm{letter-spacing:.18em;line-height:18px}
  .say .tx{margin-top:3px}
  .say .st{margin-top:2px;column-gap:6px;row-gap:1px;font-size:12px;line-height:16px}
  .say .st .gx-foot-st{font-size:inherit;line-height:inherit}
  .say .st .ic{width:12px;height:12px}
  .say .st .gx-foot{min-height:0;column-gap:6px;row-gap:1px}
  .say .st .buddy-full-message-control{min-height:0}
  .say .st [data-view-full-message]{height:auto;min-height:0;padding:0 7px;font-size:12px;line-height:16px}
 }
 &[data-gx-compact]{
  --gx-bottom-edge:15px;
  .say .gx-stage-details{display:flex;flex-wrap:wrap;align-items:center;gap:0 8px}
  .say .gx-stage-details .gx-round-actions{flex:1 1 auto}
  .say .gx-stage-details .gx-group-round-controls{gap:4px}
  .say .gx-stage-details .gx-group-round-controls :is(.b,.gx-gbtn){padding-block:2px;min-height:0}
  .say .gx-round-actions:has(> [data-auto-strip]){min-width:0;max-width:100%;overflow:visible}
  .say [data-auto-strip]{position:relative;box-sizing:border-box;min-width:0;max-width:100%;flex-wrap:nowrap}
  .say [data-auto-strip] > .r95-err{flex:1 1 3em;min-width:1.75em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;pointer-events:auto}
  .say [data-auto-strip] > .r95-err:focus-visible{outline:2px solid var(--acc-t);outline-offset:1px}
  .say [data-auto-strip] :is(.r95-auto-detail,.r95-auto-state>span:not(.ui-spinner),.ws-tag){min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .say [data-auto-strip] .r95-auto-detail{flex-basis:0}
  .say [data-auto-strip]>.buddy-progress{flex:none;order:0}
  .say [data-auto-strip]>.buddy-progress>.buddy-progress-body{position:absolute;bottom:calc(100% + 6px);inset-inline:0;z-index:3;border:1px solid var(--gline);border-radius:10px;pointer-events:auto}
  .say .gx-stage-details .r95-roundstrip .ui-btn{height:22px}
  .say .gx-round-actions{margin-top:3px}
  .say .gx-round-actions .r95-roundstrip{gap:4px;padding:4px 6px}
  .choices{gap:2px 5px}
  .choices .ch{padding:0 8px;line-height:19px}
  .choices .ch kbd{width:16px;height:16px;vertical-align:0}
 }
}
&[data-stage-scheme="light"] .shade{background:linear-gradient(to bottom,transparent 58%,var(--shade) 100%)}
&.grp .nm .lv{color:color-mix(in srgb,var(--dlg-text) 84%,transparent)}


 /* Preserve legacy interaction elements and layout only inside the new stage. */
 .corner .whg-chip-wrap{display:flex;max-width:none;min-width:0}
 .corner .hd{overflow:hidden;display:grid;place-items:center}
 .corner .hd img{width:100%;height:100%;object-fit:cover;display:block}
 .corner .gx-model .gb{max-width:min(320px,24cqw);overflow:hidden;text-overflow:ellipsis;display:block}
 .corner .gx-model .dot{display:inline-block;margin-right:6px}
 .corner .vx-vchip,.corner .r95-chip{display:flex;align-items:center;gap:6px;font-size:13px;background:transparent;border:0;border-radius:9px;padding:5px 9px;box-shadow:none;color:var(--dlg-text);white-space:nowrap}
 .corner .vx-vchip:hover,.corner .r95-chip:hover{background:var(--hov)}
 .corner .vx-vchip.on{color:var(--dlg-text);background:color-mix(in srgb,var(--acc) 22%,transparent)}
 .corner :is(.vx-vst:not(.err),[data-r95-auto-menu] .r95-chip:not(.on) .r95-chip-st){color:var(--dlg-muted)}
 .corner .vx-vchip.on .vx-vst{color:inherit}
 .tr .r95-chip-st{display:none}
 .tr .r95-pop,.tr .vx-popat{right:0;left:auto}
 &:not(.classic) .bc-galgame-pop{width:min(312px,calc(100cqw - 42px));padding:0;border:1px solid var(--gline);border-radius:13px;background:var(--sheetbg);color:var(--dlg-text);backdrop-filter:blur(14px);box-shadow:0 18px 40px -16px rgba(0,0,0,.65);font-size:13px;line-height:1.5}
 &:not(.classic) .bc-galgame-pop .ws-srow{padding:11px 14px}
 &:not(.classic) .bc-galgame-pop .ws-srow small,&:not(.classic) .bc-galgame-pop .bc-voice-members small{color:var(--dlg-muted);font-size:12px}
 &:not(.classic) .bc-galgame-pop .vx-pop-f{margin:0;padding:8px 10px;border-color:var(--gline)}
 &:not(.classic) .bc-galgame-pop .bc-voice-members{padding:10px 14px 12px;border-color:var(--gline)}
 &:not(.classic) .bc-galgame-pop .bc-voice-members li.missing small{color:var(--warn)}
 &:not(.classic) .bc-galgame-pop .bc-cloud-issue{margin:0 12px 12px;padding:10px 12px;border-radius:10px;background:color-mix(in srgb,var(--err) 13%,var(--dlg-bg));border:1px solid color-mix(in srgb,var(--err) 40%,transparent)}
 &:not(.classic) .bc-galgame-pop .bc-cloud-issue.warn{background:color-mix(in srgb,var(--warn) 11%,var(--dlg-bg));border-color:color-mix(in srgb,var(--warn) 38%,transparent)}
 .ibar .bc-asr-slot>.vx-mic{width:32px;height:32px}
 .ibar .bc-asr-tip{background:var(--sheetbg);border-color:var(--gline);color:var(--dlg-text);backdrop-filter:blur(14px)}
 .ibar .bc-asr-tip::after{background:var(--sheetbg);border-color:var(--gline)}
 .ibar .bc-asr-title small,.ibar .bc-asr-note{color:var(--dlg-muted)}
 .tr .vx-vchip>span:nth-of-type(1),.tr .vx-vchip>svg:last-child,.tr .r95-net-pop button>svg:last-child{display:none}
 .corner .gx-group-title{font-family:var(--serif);letter-spacing:.12em;max-width:20cqw;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
 .corner .gb:has(.gx-group-title){min-width:0}
 .gx-stage-chrome{display:contents}
 .gx-stage-chrome[inert] :is(.gx-group-stage-controls,.gx-group-stage-notices,.menu){opacity:0}
 .textcard{z-index:2}
 .gx-settings-dialog{width:100%;height:100%;max-width:none;max-height:none;inset:0;margin:0;padding:0;border:0;background:none;color:var(--dlg-text);overflow:hidden}
 .gx-settings-dialog[open]{display:grid;place-items:center}
 .gx-settings-dialog::backdrop{background:rgba(6,10,20,.32);backdrop-filter:blur(7px)}

 .gx-paper-picker-dialog .gx-picker-paper-body{position:static;inset:auto;margin:0;width:100%;max-width:none;max-height:none;border:0;border-radius:0;background:none;box-shadow:none;padding:0;display:flex;flex-direction:column;flex:1;min-height:0;overflow:hidden}
 .gx-paper-picker-dialog .gx-pop-h{padding:8px 26px;background:none;border:0;color:var(--dlg-muted)}
 .gx-paper-picker-dialog .gx-pop-b{display:grid;align-content:start;gap:10px 18px;padding:6px 26px 18px;overflow:auto;flex:1;min-height:0}
 .gx-paper-picker-dialog .whg-bg-picker .gx-pop-b{grid-template-columns:minmax(0,1.3fr) minmax(0,1fr)}
 .gx-paper-picker-dialog .whg-bg-builtins{margin:0;padding:0;border:0;background:none}
 .gx-paper-picker-dialog .gx-prev .whg-bg-preview{width:100%;max-height:none;aspect-ratio:16/9;object-fit:cover}
 .gx-paper-picker-dialog .whg-bg-builtins-grid{grid-template-columns:repeat(3,minmax(0,1fr))}
 .gx-paper-picker-dialog .whg-bg-builtin{min-width:0}
 .gx-paper-picker-dialog .whg-sprite-picker .gx-pop-b{grid-template-columns:minmax(0,300px) minmax(0,1fr);gap:20px}
 .gx-paper-picker-dialog .whg-sprite-preview-shell{height:430px;max-height:none;overflow:hidden;display:flex;align-items:flex-end;justify-content:center}
 .gx-paper-picker-dialog .whg-sprite-preview{height:560px;max-height:none;max-width:none;width:auto;margin-bottom:-160px;object-fit:contain}
 .gx-picker-preview-column,.gx-picker-description{min-width:0}
 .gx-picker-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}
 .gx-picker-actions .b{display:inline-flex;align-items:center;gap:5px}
 .gx-paper-picker-dialog .gx-hint{margin:8px 0;font-size:12.5px;color:var(--dlg-muted)}
 .gx-paper-picker-dialog .gx-pop-f .grow{flex:1;min-width:0}
 .gx-paper-picker-dialog .gx-pop-f .b{white-space:nowrap}
 .gx-paper-picker-dialog .gx-pop-f{padding:12px 26px;border-top:1px solid var(--dlg-border);background:none;flex-wrap:wrap}
 @media(max-width:620px){
  .gx-paper-picker-dialog .whg-bg-picker .gx-pop-b,.gx-paper-picker-dialog .whg-sprite-picker .gx-pop-b{grid-template-columns:minmax(0,1fr)}
  .gx-paper-picker-dialog .whg-sprite-preview-shell{height:min(360px,45vh)}
 }
 .gx-settings-dialog .gx-setting-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
 .gx-settings-dialog .shb>.row{display:flex;align-items:center;gap:10px;padding:6px 0;min-height:41px;margin:0}
 .gx-settings-dialog .shb>.row>.grow{flex:1;min-width:0}
 .gx-settings-dialog .shb>.row .setting-label{display:block;flex:0 0 150px}
 .gx-settings-dialog .shb>.row .seg{display:inline-flex;align-items:stretch;border:1px solid var(--dlg-border);border-radius:var(--rb);overflow:hidden}
 .gx-settings-dialog .shb>.row .seg>button{border-radius:0;min-height:29px}
 .gx-settings-dialog .shb>.row .b{min-height:36px}
 .gx-settings-dialog .shb>hr{border:1px inset;color:revert;margin:8px 0 7px}
 .gx-settings-dialog .setting-reset .sub{font-size:14px;color:var(--dlg-text)}
 .gx-settings-dialog .setting-reset .b{color:var(--err)}

 .corner .gx-net,.corner .r95-toolbar,.corner .vx-chat-pop-wrap{margin:0;min-width:0}
 .corner .vx-chip,.corner .r95-net-btn,.corner .r95-mood,.corner .r95-auto-btn,.corner .vx-btn,
 .corner .gx-stop,.corner .gx-gbtn{display:flex;align-items:center;gap:6px;font-size:13px;background:transparent;border:0;border-radius:9px;padding:5px 9px;box-shadow:none;color:var(--dlg-text);white-space:nowrap}
 .corner .r95-net-btn:hover,.corner .vx-chip:hover,.corner .vx-btn:hover,.corner .gx-stop:hover{background:var(--hov)}
 .br .r95-pop{top:auto;bottom:calc(100% + 8px);left:auto;right:0}
 &:where(.classic) .corner.br:has([data-chat-mood] button[aria-expanded="true"]){z-index:6}
 &:not(.classic) .corner.br:has([data-chat-mood] button[aria-expanded="true"]){z-index:6}
 .whg-scene .whg-bg,.whg-bg{object-position:var(--buddy-bg-position,center);filter:none}
 .shade{z-index:1}
 .spr{--gx-portrait-width:min(100cqw,var(--gx-portrait-width-natural,630px));width:var(--gx-portrait-width);z-index:0;pointer-events:none}
 .spr img{margin:auto;object-fit:contain;object-position:center top}
 .spr canvas,.gf canvas{filter:drop-shadow(0 9px 14px rgba(0,0,0,.25))}
 .spr .whg-sprite-custom{width:auto;max-width:100%}
 .spr .bub,.gf .bub{left:58%;top:18px}
 .bub{z-index:1;left:calc(50% + var(--gx-portrait-width,620px) * .08)}
 .dialogue-shell{position:absolute;inset:0;z-index:2;pointer-events:none}
 .dialogue-shell :is(.say,.live,.choices,.bottom) :is(button,input,textarea,summary,a,select),.dialogue-shell :is(.tx,.st,.gx-alert,.vx-livebar,.vx-record-row){pointer-events:auto}
 :is(.dialogue-shell .say,.gx-classic-content) .gx-alert:not(:is(.buddy-dialog,.gx-paper-dialog) *),
 :is(.dialogue-shell .say,.gx-classic-content) .gx-alert:not(:is(.buddy-dialog,.gx-paper-dialog) *)>.grow>b{color:var(--dlg-text)}
 .dialogue-shell :is(.say,.ibar,.live,.iline){left:var(--gx-stage-center);right:auto;transform:translateX(-50%)}
 .dialogue-shell :is(.say,.ibar,.live){width:68%;box-sizing:border-box}
 .dialogue-shell .say{bottom:calc(var(--gx-choice-bottom) + var(--gx-choices-h,0px) + 14px)}
 .dialogue-shell .say > .tx{font:500 calc(clamp(15px,1.5vw,20px) * var(--gx-font-scale,1))/1.55 var(--sans);letter-spacing:0;min-height:0;max-height:var(--gx-line-room,4.65em);overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;user-select:text;overscroll-behavior:contain;overflow-anchor:none}
 .dialogue-shell .say > .tx[data-scroll-more]{mask-image:linear-gradient(#000 calc(100% - .65em),transparent)}
 .dialogue-shell .gx-stage-details:has(.gx-group-round-controls,[data-auto-ended]){display:flex;flex-wrap:wrap;align-items:center;column-gap:10px}
 .dialogue-shell .say .gx-round-actions{margin-top:4px}
 .dialogue-shell .say .gx-group-round-controls .b{padding-block:3px}
 .dialogue-shell .st [data-view-full-message]{min-height:0;padding-block:3px}
 .dialogue-shell .st:empty,.dialogue-shell .gx-round-actions:empty{display:none}
 .dialogue-shell .st .gx-foot{display:contents}
 .dialogue-shell .st .gx-foot > .grow{display:none}
 .dialogue-shell .st .gx-dub-failure{display:inline-flex;align-items:center;column-gap:4px;flex-wrap:wrap;color:var(--dlg-text)}
 .dialogue-shell .st .gx-dub-failure.warn{color:var(--warn)}
 .dialogue-shell .st .gx-dub-failure.err{color:var(--err)}
 .dialogue-shell .st .gx-dub-failure button{color:var(--acc-t);font:inherit;background:none;border:0;padding:0;text-decoration:underline;text-underline-offset:3px;cursor:pointer}
 .dialogue-shell .tx .whg-line-now{font:inherit;color:inherit;line-height:inherit;padding:0;animation:none;max-height:none;overflow:visible}
 .dialogue-shell .vx-past{color:var(--dim)}
 .dialogue-shell .st .gx-foot{margin:0}
 .dialogue-shell .st .gx-foot .r95-src-pop{z-index:5}
 .dialogue-shell .live{bottom:70px}
 .dialogue-shell .live .vx-live{display:grid;grid-template-columns:minmax(0,1fr);justify-items:start;gap:0;margin:0;padding:0;border-radius:0;background:none;box-shadow:none}
 .dialogue-shell .live .vx-orb{display:none}
 .dialogue-shell .live .vx-live-m{display:contents}
 .dialogue-shell .live .vx-live-m b{grid-row:1;margin-top:9px;color:var(--dlg-text);font:400 clamp(15px,calc(1.71875cqw * var(--gx-font-scale,1)),26px)/1.62 var(--serif);letter-spacing:.06em;text-shadow:var(--tsh)}
 .dialogue-shell .live .vx-phases{grid-row:2;flex-wrap:wrap;gap:6px;margin-top:12px}
 .dialogue-shell .live .vx-phases li{font-size:13px;padding:4px 14px;border-radius:999px;border:1px solid var(--gline);background:var(--glass);color:var(--dlg-muted)}
 .dialogue-shell .live .vx-phases li.on{background:var(--acc);border-color:var(--acc);color:var(--on-acc);font-weight:700}
 .dialogue-shell .live .vx-phases li.done{color:var(--dlg-text)}
 .dialogue-shell .live .vx-live-m :is(.ws-muted,.vx-partial){grid-row:3;margin-top:6px;color:var(--dlg-muted);font-size:12.5px;text-shadow:var(--tsh)}
 .dialogue-shell .live .vx-live-m .ws-muted:empty{display:none}
 .dialogue-shell .live .vx-partial{max-width:100%}
 .dialogue-shell .live .vx-live-end{grid-row:4;margin-top:8px;height:36px;padding:6px 14px;border:1px solid var(--gline);border-radius:var(--rb);background:var(--glass);color:var(--dlg-text);font-size:13px}
 .dialogue-shell .live .vx-live-end:not(:disabled):hover{background:var(--hov)}
 .dialogue-shell .live .vx-live-end svg{display:none}
 .dialogue-shell .live .vx-livealert{flex-wrap:wrap}
 .dialogue-shell .choices{bottom:var(--gx-choice-bottom);width:max-content;max-width:calc(100% - 48px);max-height:max(42px,calc(var(--gx-stage-h) * .12));overflow:auto;flex-wrap:wrap;justify-content:center;pointer-events:auto}
 .dialogue-shell .choices .ch{min-width:0;max-width:100%}
 .dialogue-shell .ch{overflow:hidden;text-overflow:ellipsis}
 .dialogue-shell .stage-capsules{display:flex;gap:10px;flex-wrap:wrap}
 .dialogue-shell .stage-capsules .ch{pointer-events:auto}
 .dialogue-shell .gx-speech-actions{align-items:center;font-size:var(--buddy-fs-sm);color:var(--dlg-muted)}
 .dialogue-shell .gx-speech-actions .r95-speech-opts{justify-content:center}
 .dialogue-shell .gx-speech-actions :is(.r95-speech-pet,.r95-err){flex-basis:100%;justify-content:center;text-align:center;margin:0}
 .dialogue-shell .ch kbd{display:inline-grid;place-items:center;width:19px;height:19px;border-radius:50%;background:var(--acc);color:var(--on-acc);font:600 11.5px var(--sans);margin-right:8px;vertical-align:1px}
 .dialogue-shell .choices .ch span{overflow:hidden;text-overflow:ellipsis}
 .dialogue-shell .bottom :is(.ibar,.iline){bottom:var(--gx-bottom-edge)}
 .dialogue-shell .bottom .ibar{pointer-events:auto;min-height:44px;padding:5px}
 .dialogue-shell .ibar.vx-ginput :is(.vx-mic,.vx-livebtn,.gx-send){height:32px;min-height:32px;align-self:center}
 .dialogue-shell .ibar.vx-ginput .vx-mic{width:32px;padding:0;justify-content:center;border-radius:50%}
 .dialogue-shell .ibar .gx-send{align-self:center}
 .dialogue-shell .ibar .gx-ta{margin:0;display:flex;flex:1;min-width:0;min-height:0;background:transparent;box-shadow:none;border:0;padding:0}
 .dialogue-shell .ibar .gx-ta .whg-input{font-size:15px;padding:6px;color:var(--dlg-text);background:transparent;border:0;outline:0;box-shadow:none;box-sizing:border-box;min-height:32px;line-height:20px;field-sizing:content;resize:none;max-height:max(32px,calc(var(--gx-stage-h) * .18 - var(--gx-choices-h,0px) - 12px))}
 .dialogue-shell .bottom .ihelp{left:var(--gx-stage-center);transform:translateX(-50%);bottom:1px;padding:0 8px;max-width:68%;line-height:13px;white-space:nowrap;pointer-events:none}
 .dialogue-shell .ibar .gx-ta .gx-keyboard-hint{display:none}
 .dialogue-shell .ibar>.gx-draft-source{flex:none;max-width:30%;font-size:11px;color:var(--dlg-text);padding:1px 6px;border-radius:6px;background:var(--dlg-bg)}
 .dialogue-shell .ibar>.gx-draft-source .ws-tag{background:none;color:inherit;padding:0}
 .dialogue-shell .ibar .gx-send{min-height:30px}
 .dialogue-shell .ibar .vx-mic,.dialogue-shell .ibar .vx-livebtn{display:flex;align-items:center;gap:5px;font-size:13px!important;border:1px solid var(--gline);background:color-mix(in srgb,var(--dlg-text) 7%,transparent);border-radius:10px;padding:6px 11px;cursor:pointer;white-space:nowrap;color:var(--dlg-text);width:auto;height:auto}
 .dialogue-shell .ibar .vx-mic:disabled,.dialogue-shell .ibar .vx-livebtn:disabled{opacity:.45;cursor:not-allowed}
 .dialogue-shell .bottom > :not(.iline,.ihelp,.ibar){position:absolute;bottom:var(--gx-bottom-edge);left:var(--gx-stage-center);transform:translateX(-50%);width:68%;pointer-events:auto}
 .dialogue-shell .bottom > .vx-live{margin:0;flex-wrap:wrap}
 .menu{max-height:calc(100% - 85px);overflow:auto;z-index:8}
 .menu .mh>button{display:flex;align-items:center;gap:8px;border:0;background:none;font:inherit;color:inherit;text-align:left;cursor:pointer}
 .menu .mi[disabled]{opacity:.45;cursor:not-allowed}
 .gx-members-pop{position:absolute;z-index:8;width:min(330px,calc(100% - 24px));max-height:calc(100% - 24px);overflow:auto;box-sizing:border-box;background:var(--sheetbg);color:var(--dlg-text);border:1px solid var(--dlg-border);border-radius:var(--r);box-shadow:0 14px 34px rgba(0,0,0,.35);padding:14px 16px;font-size:13.5px;backdrop-filter:blur(10px)}
 .gx-members-pop h5{margin:0 0 4px;font:700 15px var(--serif);letter-spacing:.12em}
 .gx-members-pop .sub{font-size:12.5px;color:var(--dlg-muted)}
 .gx-members-pop hr{border:0;border-top:1px solid var(--dlg-border);margin:8px 0}
 .gx-members-pop .row,.gx-members-search,.gx-members-pop .acts{display:flex;gap:8px;align-items:center}
 .gx-members-pop .row{padding:5px 0}
 .gx-members-pop .grow{flex:1;min-width:0;overflow-wrap:anywhere}
 .gx-members-pop .acts{justify-content:flex-end;flex-wrap:wrap}
 .gx-members-pop .hd{overflow:hidden;flex:none}
 .gx-members-pop .hd img{width:100%;height:100%;object-fit:cover}
 .gx-members-search{min-height:33px;margin:6px 0;padding:4px 8px;border:1px solid var(--dlg-border);border-radius:var(--rb)}
 .gx-members-search input{width:100%;min-width:0;border:0;background:transparent;color:inherit;font:inherit}
 &.hidden-ui .gx-members-pop{display:none}
 .gx-mode-pop{position:absolute;z-index:8;left:clamp(12px,calc(100% - 312px),200px);top:63px;width:min(300px,calc(100% - 24px));max-height:calc(100% - 85px);overflow:auto;background:var(--sheetbg);color:var(--dlg-text);border:1px solid var(--dlg-border);border-radius:var(--r);box-shadow:0 14px 34px rgba(0,0,0,.35);padding:14px 16px;font-size:13.5px;backdrop-filter:blur(10px)}
 .gx-mode-pop h5{margin:0 0 4px;font:700 15px var(--serif);letter-spacing:.12em}
 .gx-mode-pop button{display:flex;align-items:center;gap:10px;width:100%;padding:6px 8px;border:0;border-radius:8px;text-align:left;background:none;color:inherit;cursor:pointer}
 .gx-mode-pop button[aria-pressed=true]{background:color-mix(in srgb,var(--acc) 18%,transparent)}
 .gx-mode-pop button:hover:not(:disabled){background:var(--hov)}
 .gx-mode-pop button:disabled{cursor:default}
 .gx-mode-pop .gx-mode-label{flex:1;min-width:0}
 .gx-mode-pop small,.gx-mode-pop .gx-mode-note{display:block;color:var(--dlg-muted);font-size:12.5px}
 .gx-mode-pop [role=alert]{color:var(--err)}
 .menu .mi:focus-visible,.corner .gb:focus-visible,.iline:focus-visible{outline:2px solid var(--acc-t);outline-offset:2px}
 .shb>hr{border:0;border-top:1px solid var(--dlg-border);margin:8px 0}
 .setting-label{width:150px;font-family:var(--serif);font-weight:700;letter-spacing:.12em}
 .setting-reset .setting-label,.setting-reset button{color:var(--err)}
 .seg>button{font-size:12.5px;padding:4px 11px;border:0;border-right:1px solid var(--dlg-border);white-space:nowrap;background:transparent;color:inherit;cursor:pointer}
 .seg>button:last-child{border-right:0}
 .seg>button[aria-pressed=true]{background:var(--acc);color:var(--on-acc);font-weight:700}
 .hidehint{z-index:8}
 .corner,.dialogue-shell,.gx-classic-content,.shade,.grail,.gcap{transition:opacity .25s ease}
 &.hidden-ui .dialogue-shell,&.hidden-ui .gx-classic-content{opacity:0;pointer-events:none}
 &.hidden-ui .dialogue-shell *{pointer-events:none!important}
 &.grp .gf{--gx-portrait-width:min(100cqw,var(--gx-portrait-width-natural,630px));width:var(--gx-portrait-width)}

 &.grp .gf img{margin:auto}
 &.grp .grail{pointer-events:auto;max-height:calc(100% - 190px);overflow:auto}
 &.grp .grail .grail-faces{display:flex;flex-direction:column;gap:8px;min-height:0;overflow:auto}
 &.grp .gscene{pointer-events:none}
 .gx-group-stage-controls{position:absolute;top:70px;left:23px;z-index:2;color:var(--dlg-text);display:flex;gap:8px;align-items:center}
 .gx-group-stage-controls:empty{display:none}
 .gx-group-stage-controls .buddy-viewing{background:var(--glass);color:var(--dlg-text);border-radius:9px;padding:5px 9px}
 .gx-group-feedback{position:absolute;left:23px;bottom:46px;z-index:4;pointer-events:auto}
 &:not(.classic){
  .gx-group-stage-notices{position:absolute;top:max(122px,calc(var(--gx-history-top) + (var(--gx-history-height) + max(var(--gx-br-height,0px),var(--gx-history-height))) / 2 + 8px));left:var(--gx-corner-inset);display:grid;justify-items:start;gap:6px;max-width:calc(100% - 2 * var(--gx-corner-inset) - 95px);z-index:4}
  .gx-group-stage-notices:empty{display:none}
  .gx-group-stage-controls,.gx-group-feedback{position:static;margin:0;max-width:100%}
  .gx-group-stage-controls .buddy-viewing{flex:1 1 auto;min-width:0;box-sizing:border-box;padding-block:0;color:var(--dlg-text)}
  .gx-group-stage-controls .whg-btn{flex:none}
  .gx-group-feedback{overflow-wrap:anywhere}
 }
 .gx-round-meta{white-space:nowrap}
 .gx-round-actions{max-height:min(28vh,196px);overflow:auto}
 .grail .spk img{border-color:var(--acc);filter:none}
 .grail .mute img{opacity:.5}
 .grail .grail-faces span{display:grid;place-items:center;width:38px;height:38px;flex:none;border-radius:50%;background:color-mix(in srgb,var(--dlg-text) 10%,transparent)}
 .gx-paper .whg-archive.gx-drawer>.gx-dh{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:12px;padding:18px 26px 12px;border-color:var(--dlg-border);background:transparent;flex-shrink:0}
 .gx-paper .gx-dh h3{padding:0}
 .gx-paper .gx-dh-row{margin:0;padding:6px 26px;border-bottom:1px solid var(--dlg-border);min-height:51px}
 .gx-paper .gx-dh-row .ui-seg{background:transparent;border:none;box-shadow:none;padding:0;gap:4px}
 .gx-paper .gx-dh-row .ui-seg>button{min-height:34px;padding:0 12px;box-shadow:none;border-radius:0;background:transparent;border-bottom:2px solid transparent}
 .gx-paper .gx-dh-row .ui-seg>button[aria-selected=true]{border-color:var(--acc);color:var(--dlg-text)}
 .gx-paper .gx-cg-card{background:color-mix(in srgb,var(--dlg-text) 5%,transparent);border-radius:var(--rc)}
 .gx-paper .gx-cg-img{aspect-ratio:16/9}
 .gx-paper .gx-cg-img>img{margin:0;min-width:0;min-height:0}
 .gx-paper .gx-cg-m{display:grid;gap:2px;padding:6px 9px}
 .gx-paper .gx-cg-m b{color:var(--dlg-text)}

 .gx-paper .whg-archive.gx-drawer>.gx-dh>.gx-paper-caption{min-width:0;flex-wrap:wrap}
 .gx-paper .gx-paper-caption .kick{margin-left:auto}
 .gx-paper .whg-archive.gx-drawer>.gx-dh>.gx-dh-x{position:static;justify-self:end;white-space:nowrap}
 .gx-paper .gx-dh-x.x{font-size:12.5px;background:transparent;border:1px solid var(--dlg-border);border-radius:6px;padding:3px 9px;color:var(--dlg-text);cursor:pointer}

 .gx-round-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
 .gx-group-round-controls{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
 .gx-group-round-controls .buddy-progress>summary.b{display:block;padding:6px 14px;border-radius:var(--rb);color:var(--dlg-text)}
 .gx-group-round-controls .buddy-progress>summary::-webkit-details-marker{display:none}
 .gx-group-round-controls .buddy-progress[open]{flex-basis:100%}
 .gx-group-round-controls .b,.q-roundpop .b{pointer-events:auto;border-color:var(--dlg-border);background:var(--dlg-bg);color:var(--dlg-text)}
 .gx-group-round-controls .b.pri,.q-roundpop .b.pri{background:var(--choice-bg);color:var(--dlg-text)}
 .gx-group-round-controls .b:hover:not(:disabled),.q-roundpop .b:hover:not(:disabled){background:color-mix(in srgb,var(--dlg-text) 7%,var(--dlg-bg))}
 .q-roundpop{box-sizing:border-box;position:absolute;z-index:4;left:0;bottom:0;width:min(420px,100%);max-height:min(65vh,480px);overflow:auto;pointer-events:auto;padding:14px 16px;border:1px solid var(--dlg-border);border-radius:var(--r);background:var(--sheetbg);color:var(--dlg-text);box-shadow:0 14px 34px color-mix(in srgb,var(--buddy-scrim) 75%,transparent);backdrop-filter:blur(10px);font:13.5px var(--sans)}
 .q-roundpop h5{display:flex;align-items:center;gap:8px;margin:0 0 4px;font:700 15px var(--serif);letter-spacing:.12em}
 .q-roundpop h5 span,.q-round-state{color:var(--dlg-muted);font:500 12.5px var(--sans);letter-spacing:normal}
 .q-roundpop ul{list-style:none;padding:0;margin:0}
 .q-roundpop li{display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--dlg-border)}
 .q-round-name{flex:1;min-width:0;overflow-wrap:anywhere}
 .q-round-state{flex:none}
 .gx-round-actions .r95-roundstrip{width:100%}
 .gx-round-actions .r95-roundstrip:is([data-auto-strip],[data-auto-ended]){background:color-mix(in srgb,var(--acc) 6%,var(--dlg-bg))}
 .gx-round-actions [data-auto-ended]>span{color:var(--dlg-text)}
 .gx-round-actions [data-auto-ended]>small{color:var(--dlg-muted)}
 &.grp .dialogue-shell [data-view-full-message]{
  color:var(--dlg-text);background:color-mix(in srgb,var(--dlg-text) 8%,var(--dlg-bg))
 }
 &.grp .dialogue-shell [data-view-full-message]:is(:hover,:focus-visible){
  background:color-mix(in srgb,var(--dlg-text) 15%,var(--dlg-bg))
 }
 &.grp .dialogue-shell .r95-auto-state,&.grp .gx-classic-content .r95-auto-state{color:var(--dlg-text)}
 &.grp :is(.dialogue-shell,.gx-classic-content) .r95-auto-state b{color:inherit}
 &.grp .gx-round-actions .r95-roundstrip .buddy-progress>summary{color:var(--dlg-text);background:var(--dlg-bg);border-color:var(--dlg-border)}
 &.grp .gx-round-actions .r95-roundstrip .buddy-progress-body{color:var(--dlg-text);background:var(--sheetbg);border-color:var(--dlg-border)}
 &.grp .gx-round-actions .r95-roundstrip .buddy-auto-member{color:var(--dlg-muted);background:var(--dlg-bg);border-color:var(--dlg-border)}
 &.grp .gx-round-actions .r95-roundstrip .buddy-auto-member b{color:var(--dlg-text)}
 &.grp .dialogue-shell .r95-queued{color:var(--dlg-muted)}
 &.grp .corner.br:has([data-r95-auto]){z-index:5}
 &.grp .dialogue-shell .buddy-group-hint,&.grp .gx-round-actions [data-auto-strip] .r95-auto-detail{color:var(--dlg-muted)}
 &.grp .corner.br [data-r95-auto-menu] .r95-chip-st{background:color-mix(in srgb,var(--acc) 12%,var(--dlg-bg))}
 &.grp .corner.br [data-r95-auto-menu] .r95-chip.on .r95-chip-st{color:var(--dlg-text)}
 &.grp .corner.br .r95-auto-pop .r95-pop{background:var(--dlg-bg);color:var(--dlg-text)}
 &.grp .corner.br .r95-auto-pop :is(.r95-cap,.ui-seg>button){color:var(--dlg-muted)}
 &.grp .corner.br .r95-auto-pop :is(.r95-pop-h,.ws-fld>span,.ui-seg>button[aria-checked="true"],input){color:var(--dlg-text)}
 &.grp .corner.br .r95-auto-pop :is(.ui-seg,input){background:var(--choice-bg);box-shadow:inset 0 0 0 1px var(--dlg-border)}
 &.grp .corner.br .r95-auto-pop .ui-seg>button[aria-checked="true"]{background:var(--dlg-bg);box-shadow:inset 0 0 0 1px var(--dlg-border)}
 .gx-round-actions .r95-roundstrip>.ui-btn:not(:disabled){background:var(--dlg-bg);border-color:var(--gline);color:var(--dlg-text)}
 .gx-round-actions .r95-roundstrip>.ui-btn:not(:disabled):hover{background:color-mix(in srgb,var(--dlg-text) 6%,var(--dlg-bg))}
 .whg-archive-scrim.gx-paper{display:grid;grid-template:minmax(0,1fr)/minmax(0,1fr);place-items:center;justify-content:stretch;background:rgba(6,10,20,.32);backdrop-filter:blur(7px);z-index:10}
 .whg-archive-scrim.gx-paper .whg-archive.gx-drawer{position:relative;inset:auto;transform:none;width:min(998px,calc(100% - 36px));height:min(605px,calc(100% - 36px));max-width:none;border:1px solid var(--dlg-border);border-radius:13px;box-shadow:0 14px 44px rgba(0,0,0,.4);background:var(--sheetbg);color:var(--dlg-text);animation:gx-redesign-rise .32s ease-out}
 .gx-paper .whg-archive-title{font:700 22px var(--serif);letter-spacing:.3em}
 .gx-paper .gx-cg-grid{grid-template-columns:repeat(4,minmax(0,1fr));gap:14px}
 .gx-paper .whg-archive-spine{display:none}
 .gx-paper .whg-archive-head{padding:18px 26px 12px}
 .gx-paper .whg-archive-body{padding:14px 26px 18px}
 .gx-classic-content{z-index:2}
 .gx-classic-content .whg-line-now{animation:none}
 .gx-classic-content{font-size:calc(var(--buddy-fs-body) * var(--gx-font-scale,1))}
 &.classic{
  --gx-classic-inset:23px;
  --gx-classic-top:17px;
  &[data-gx-narrow]{--gx-classic-top:12px;--gx-classic-inset:10px}
  .corner.tr{top:var(--gx-classic-top);right:var(--gx-classic-inset)}
  .tr:has(.vx-chat-pop-wrap > .vx-popat,.r95-net-pop > .r95-pop){z-index:7}
  .corner.br{top:calc(var(--gx-classic-top,17px) + var(--gx-primary-height,37px) + 9px + var(--gx-history-measured-height,35px) / 2);right:calc(var(--gx-classic-inset) + 9px + var(--gx-history-width,45px));bottom:auto;transform:translateY(-50%);z-index:4}
  .br .glass{position:relative}
  .br .r95-pop-wrap{position:static}
  .br .r95-pop{top:calc(100% + 8px);bottom:auto;right:calc(-9px - var(--gx-history-width,45px));left:auto;width:min(380px,calc(100cqw - 48px));max-height:calc(var(--gx-stage-h,480px) - 145px);overflow:auto}
 }
 .grail.bc-small-rail{right:var(--gx-corner-inset,10px);padding:5px;z-index:3}
 .grail.bc-small-rail .grail-faces span,.grail.bc-small-rail img{width:28px;height:28px}
 .grail .bc-rail-missing{position:relative}
 .grail .bc-rail-missing img{opacity:.45}
 .grail .bc-rail-indicator{position:absolute;right:-1px;bottom:-1px;display:grid;place-items:center;width:15px;height:15px;background:var(--dlg-bg);border:1px solid var(--gline);border-radius:50%;color:var(--warn)}
 .gx-classic-content:is(.whg-panel),.buddy-group-panel.gx-dlg{background:color-mix(in srgb,var(--dlg-bg) 93%,transparent);border-color:var(--dlg-border);color:var(--dlg-text)}
 .gx-classic-content :is(.whg-line-now,.gx-lvl b,.whg-input),.buddy-group-panel :is(.whg-line-now,.whg-input){color:var(--dlg-text)}
 .gx-classic-content :is(.whg-line-now.narrator,.whg-line-now.muted,.gx-lvl,.gx-typing),.buddy-group-panel .buddy-muted{color:var(--dlg-muted)}
 .gx-classic-content .gx-choice{background:var(--choice-bg);color:var(--dlg-text);box-shadow:inset 0 0 0 1px var(--dlg-border)}
 .gx-classic-content .gx-choice:hover:not(:disabled),.gx-classic-content .gx-choice:focus-visible{background:color-mix(in srgb,var(--acc) 20%,var(--choice-bg))}
 .gx-classic-content .gx-ta,.buddy-group-panel .gx-ta{background:color-mix(in srgb,var(--dlg-text) 6%,var(--dlg-bg))}
 &[data-stage-scheme="dark"] :is(.dialogue-shell,.gx-classic-content) [data-voice-recording]>.ui-btn.ghost{background:color-mix(in srgb,var(--dlg-text) 7%,var(--dlg-bg));color:var(--dlg-text)}
 &[data-stage-scheme="light"] :is(.ibar,.vx-recrow){background:color-mix(in srgb,var(--dlg-bg) 97%,transparent)}
 &[data-stage-scheme="light"] :is(.ib:not(.pri,.rec),.vx-recrow .ui-btn.ghost,.ibar .vx-mic,.ibar .vx-livebtn){background:color-mix(in srgb,var(--dlg-text) 6%,var(--dlg-bg));color:var(--dlg-text)}
 &[data-stage-scheme="light"] :is(.ch,.gx-classic-content .gx-choice){background:color-mix(in srgb,var(--choice-bg) 96%,transparent)}
 &[data-stage-scheme="light"] .iline{background:color-mix(in srgb,var(--dlg-bg) 90%,transparent);border-radius:999px;border-bottom-color:transparent;color:var(--dlg-text)}
 .dialogue-shell .iline{max-width:68%;overflow:hidden;text-overflow:ellipsis}
 @container (width < 900px){
  .corner.tl .mode-group{display:none}
 }
 @container (max-width:860px){
  .corner.tl{max-width:calc(100% - 245px)}
  .corner.tl .glass{max-width:100%;min-width:0}
  .corner.tl .gx-model{max-width:42%;overflow:hidden;text-overflow:ellipsis;display:block}
  .grail:not(.bc-small-rail){display:none}
  .choices .ch{padding-inline:9px}
  .gx-paper .gx-cg-grid{grid-template-columns:repeat(2,minmax(0,1fr))}
 }
 @container (max-width:550px){
  .corner.tl{left:10px;top:12px;max-width:calc(100% - 185px)}
  .corner .gb{padding:5px}
  .corner.tl .gs,.corner.tl .gx-model,.corner.br .mtx,.corner .vx-chip .vx-chip-k{display:none}
  &.grp .dialogue-shell .nm{flex-wrap:wrap}
  .gx-round-meta{flex-basis:100%;white-space:normal}
  .gx-settings-dialog .shb>.row .setting-label{flex-basis:100px}
 }
 @media(prefers-reduced-motion:reduce){
  .dot.busy,.thinking i,.recdot{animation:none}
  .corner,.dialogue-shell,.gx-classic-content,.shade,.grail,.gcap,.gf{transition:none}
  .whg-archive-scrim.gx-paper .whg-archive.gx-drawer{animation:none}
 }
}
.gx-paper-dialog.buddy-dialog{width:min(998px,calc(100vw - 36px));max-width:none;height:min(605px,calc(100vh - 36px));max-height:none;border-radius:13px;background:var(--sheetbg);color:var(--dlg-text);border:1px solid var(--dlg-border);box-shadow:0 14px 44px rgba(0,0,0,.4);animation:gx-redesign-rise .32s ease-out}
.gx-paper-dialog.buddy-dialog::backdrop{background:rgba(6,10,20,.32);backdrop-filter:blur(7px)}
.gx-paper-dialog .buddy-dialog-head h2,.gx-paper-dialog.buddy-group-modal header h2{font:700 22px var(--serif);letter-spacing:.3em}
.gx-paper-dialog .buddy-dialog-head,.gx-paper-dialog.buddy-group-modal header{padding:18px 26px 12px}
.gx-paper-dialog .gx-paper-title{display:flex;align-items:center;gap:12px;min-width:0}
.gx-paper-dialog .gx-paper-head{display:flex;align-items:center;gap:12px;flex-shrink:0;border-bottom:1px solid var(--dlg-border)}
.gx-paper-dialog .gx-paper-head h2{margin:0;font:700 22px var(--serif);letter-spacing:.3em;color:var(--dlg-text)}
.gx-paper-dialog .gx-paper-head .sub{font:italic 500 16px var(--latin);color:var(--dlg-muted);white-space:nowrap}
.gx-paper-dialog .gx-paper-head .gx-paper-close{order:3;margin-left:auto;font:12.5px var(--sans);background:transparent;border:1px solid var(--dlg-border);border-radius:6px;padding:3px 9px;color:var(--dlg-text);cursor:pointer;min-height:30px;white-space:nowrap}
.gx-paper-dialog .gx-paper-head .gx-paper-crumb+.gx-paper-close{margin-left:0}
.gx-paper-dialog .gx-paper-title .orn{width:34px;height:26px;background:var(--orn) center/contain no-repeat;flex:none}
.gx-paper-dialog .gx-paper-title .sub,.gx-redesign .gx-paper .gx-paper-sub{font-family:var(--latin);font-style:italic;font-size:16px;color:var(--dlg-muted);letter-spacing:normal}
.gx-redesign .gx-paper-orn{width:34px;height:26px;background:var(--orn) center/contain no-repeat;flex:none}
.gx-redesign .gx-paper-caption{display:flex;align-items:center;gap:12px}
.gx-paper-dialog.gx-backlog .buddy-dialog-shell{display:flex;flex-direction:column;max-height:100%;height:100%;background:transparent}
.gx-paper-dialog.gx-backlog .buddy-dialog-head{flex-shrink:0;border-bottom:1px solid var(--dlg-border)}
.gx-paper-dialog.gx-backlog .buddy-dialog-body{flex:1;min-height:0;padding:14px 26px 18px}
.gx-paper-dialog.gx-backlog .buddy-columns.buddy-history{grid-template-columns:270px minmax(0,1fr);gap:18px;min-height:0;height:100%}
.gx-paper-dialog.gx-backlog .buddy-history>.buddy-sidebar{height:100%;min-height:0}
.gx-paper-dialog.gx-backlog .buddy-history-actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.gx-paper-dialog.gx-backlog .buddy-history-actions>.grow{flex:1;color:var(--dlg-muted)}
.gx-paper-dialog.gx-backlog .buddy-history-actions .b{min-height:36px;font-size:13px;border-radius:var(--rb);padding:6px 14px;border:1px solid var(--gline);background:var(--glass);cursor:pointer;color:var(--dlg-text);white-space:nowrap}
.gx-paper-dialog.gx-backlog .buddy-history-actions .b:hover{background:var(--hov)}
.gx-paper-dialog.gx-backlog .buddy-history-main{overflow:auto;min-height:0;padding:0}
.gx-paper-dialog.gx-backlog .buddy-history-main>.buddy-form-title{border:0;padding:0;background:none;min-height:40px}
.gx-paper-dialog.gx-backlog .buddy-history-main>.buddy-form-title>.buddy-face,.gx-paper-dialog.gx-backlog .buddy-history-main>.buddy-form-title .buddy-muted,.gx-paper-dialog.gx-backlog .buddy-history-main>.buddy-form-title .ws-tag{display:none}
.gx-paper-dialog.gx-backlog .buddy-history-main h3{font:700 16px var(--serif);letter-spacing:.1em}
.gx-paper-dialog.gx-backlog .buddy-history-main .buddy-msgs{gap:0;padding:0;overflow:visible}
.gx-paper-dialog.gx-backlog .buddy-history-main .buddy-message{width:100%;max-width:none;margin:0;display:grid;grid-template-columns:34px minmax(0,1fr);gap:10px;padding:10px 0;border-bottom:1px solid color-mix(in srgb,var(--dlg-border) 70%,transparent);align-items:start}
.gx-paper-dialog.gx-backlog .buddy-message .buddy-face{width:34px;height:34px}
.gx-paper-dialog.gx-backlog .buddy-message .buddy-message-main,.gx-paper-dialog.gx-backlog .buddy-message .buddy-message-head{flex-direction:initial;align-items:flex-start}
.gx-paper-dialog.gx-backlog .buddy-message .buddy-message-main{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:4px 8px}
.gx-paper-dialog.gx-backlog .buddy-message .buddy-message-head{grid-area:1/1}
.gx-paper-dialog.gx-backlog .buddy-message .buddy-message-head strong{font-size:12.5px;color:var(--dlg-muted)}
.gx-paper-dialog.gx-backlog .buddy-message .buddy-message-body{grid-area:2/1;box-shadow:none;background:none;padding:0;font:15px var(--serif);line-height:1.62;letter-spacing:.04em}
.gx-paper-dialog.gx-backlog .buddy-message .buddy-message-actions{grid-area:1/2/span 2}
.gx-paper-dialog.gx-backlog .buddy-sticky-actions{background:var(--sheetbg)}
.gx-paper-dialog.gx-backlog .buddy-history .buddy-side-item{border:0;box-shadow:none;background:transparent;padding:8px 10px;min-height:42px;text-align:left}
.gx-paper-dialog.gx-backlog .buddy-history .buddy-side-item[aria-current=true]{background:color-mix(in srgb,var(--acc) 18%,transparent);box-shadow:inset 3px 0 0 var(--acc)}
.gx-paper-dialog.gx-backlog .buddy-history .buddy-side-item .buddy-face{display:none}
.gx-paper-dialog.gx-backlog .gx-paper-close{font-size:12.5px;background:transparent;border:1px solid var(--dlg-border);border-radius:6px;padding:3px 9px;color:var(--dlg-text);cursor:pointer;min-height:30px;white-space:nowrap}
.gx-paper-dialog.gx-backlog .gx-paper-crumb{color:var(--dlg-muted);font-size:12px;margin-left:auto}
.gx-history-expression{display:inline;padding:0;border:0;background:none;color:inherit;font:inherit;line-height:inherit;letter-spacing:inherit;text-align:inherit;white-space:pre-wrap;cursor:pointer}
.gx-history-expression:hover,.gx-history-expression:focus-visible{text-decoration:underline;text-decoration-color:var(--buddy-accent-text);text-underline-offset:3px}
.gx-paper-dialog.gx-history-preview{width:min(520px,calc(100vw - 36px));height:min(605px,calc(100vh - 36px));padding:0}
.gx-paper-dialog.gx-history-preview .buddy-dialog-head{display:flex;justify-content:space-between;gap:8px;border-bottom:1px solid var(--dlg-border)}
.gx-history-preview-portrait{height:calc(100% - 150px);min-height:170px;display:grid;place-items:center;overflow:hidden;background:color-mix(in srgb,var(--dlg-text) 5%,transparent)}
.gx-history-preview-portrait>img{width:100%;height:100%;object-fit:contain;object-position:center top}
.gx-history-preview-line{margin:10px 26px;font:16px/1.62 var(--serif)}
.gx-paper-dialog.gx-paper-small.buddy-dialog{width:min(520px,calc(100vw - 36px));height:fit-content;max-height:min(605px,calc(100vh - 36px))}
.gx-paper-dialog.gx-paper-medium.buddy-dialog{width:min(640px,calc(100vw - 36px));height:fit-content;max-height:min(605px,calc(100vh - 36px))}
.gx-paper-dialog.gx-paper-small.ws-mdl{padding:0}
.gx-paper-dialog.gx-paper-small .buddy-group-modal-body{padding:14px 26px 18px}
.gx-paper-dialog.gx-paper-small .buddy-group-modal-foot{padding:12px 26px}
@media(max-width:680px){
 .gx-paper-dialog.gx-backlog .buddy-columns.buddy-history{grid-template-columns:minmax(0,1fr);grid-template-rows:minmax(130px,40%) minmax(0,1fr)}
}
.gx-redesign .gx-intro{position:absolute;inset:0;z-index:8;display:grid;place-items:center;background:color-mix(in srgb,var(--dlg-bg) 70%,transparent);backdrop-filter:blur(10px)}
.gx-redesign .gx-intro-card{width:min(440px,calc(100% - 42px));text-align:center;padding:30px;border-radius:var(--r);background:var(--sheetbg);border:1px solid var(--dlg-border)}
.gx-redesign .gx-intro-card b{display:block;font:700 20px var(--serif);letter-spacing:.15em;margin-bottom:8px}
.gx-redesign .gx-intro-card .sub{font-size:12.5px;color:var(--dlg-muted)}
.gx-redesign .gx-intro-card .acts{justify-content:center}
.gx-redesign .gx-intro-card .ui-spinner{display:block;width:34px;height:34px;margin:0 auto 14px}
.gx-redesign .gx-gift-paper.whg-cg-backdrop{display:flex;align-items:center;justify-content:center;background:rgba(6,10,20,.32);backdrop-filter:blur(7px);padding:0}
.gx-redesign .gx-gift-paper .sheet{max-height:calc(100% - 36px)}
.gx-redesign .gx-gift-paper .shh>.x{flex:none;white-space:nowrap}
.gx-redesign .gx-settings-dialog .b.dng:not(:disabled){background:var(--dlg-bg);border-color:var(--err);color:var(--dlg-text)}
.gx-redesign .gx-settings-dialog .b.dng:not(:disabled):hover{background:color-mix(in srgb,var(--dlg-text) 6%,var(--dlg-bg))}
.gx-redesign .gx-gift-paper .shb .gx-big{border-radius:var(--rc)}
.galgame-page .whg-root-tab.gx-redesign .whg-scene .whg-bg{object-position:var(--buddy-bg-position,center);filter:none}
.galgame-page .whg-root-tab.gx-redesign:not(.classic){display:block}
.gx-redesign .gx-title-dialog,.gx-redesign .gx-title-dialog h2{font-family:var(--serif)}
@media(prefers-reduced-motion:reduce){.gx-paper-dialog.buddy-dialog{animation:none}}

`;
export const FX = {cheerful:['hop','heart'],shy:['back','shy'],confused:[null,'question'],angry:['shake','angry'],frightened:['shiver','sweat'],exasperated:['sink','sigh'],starry:['hop2','sparkle'],
 flustered:['shiver','sweat'],smug:['hop2',null],laugh:['hop2',null],sleepy:['sink','sigh'],sad:['sink','tear'],cry:['shiver','tear'],asleep:[null,'zzz'],thinking:[null,'bulb'],playful:['hop',null],eating:['hop2','heart'],surprised:['hop','surprise'],coax:['back','shy']};
export const B = {
 heart:'<svg viewBox="0 0 40 40"><path d="M20 35s-13-8-13-18a7 7 0 0 1 13-4 7 7 0 0 1 13 4c0 10-13 18-13 18z" fill="#ff6f91" stroke="#fff" stroke-width="2.4"/></svg>',
 exclaim:'<svg viewBox="0 0 40 40"><circle cx="20" cy="18" r="15" fill="#fff"/><path d="M14 31l-3 6 8-4" fill="#fff"/><text x="20" y="25" text-anchor="middle" font-size="20" font-weight="900" fill="#e0533b" font-family="sans-serif">!</text></svg>',
 surprise:'<svg viewBox="0 0 40 40"><circle cx="20" cy="18" r="15" fill="#fff"/><path d="M14 31l-3 6 8-4" fill="#fff"/><text x="20" y="25" text-anchor="middle" font-size="17" font-weight="900" fill="#e0533b" font-family="sans-serif">!?</text></svg>',
 question:'<svg viewBox="0 0 40 40"><circle cx="20" cy="18" r="15" fill="#fff"/><path d="M14 31l-3 6 8-4" fill="#fff"/><text x="20" y="25" text-anchor="middle" font-size="20" font-weight="900" fill="#3f78d0" font-family="sans-serif">?</text></svg>',
 shy:'<svg viewBox="0 0 40 40"><g stroke="#ff7aa8" stroke-width="3" stroke-linecap="round"><path d="M6 26l5-8M13 28l5-8M22 28l5-8M29 26l5-8"/></g></svg>',
 angry:'<svg viewBox="0 0 40 40"><g fill="none" stroke="#e5413a" stroke-width="3.6" stroke-linecap="round"><path d="M8 15c4 0 7-3 7-7M25 8c0 4 3 7 7 7M32 25c-4 0-7 3-7 7M15 32c0-4-3-7-7-7"/></g></svg>',
 steam:'<svg viewBox="0 0 40 40"><g fill="#fff" opacity=".92"><circle cx="12" cy="26" r="7"/><circle cx="22" cy="20" r="9"/><circle cx="31" cy="27" r="6"/></g></svg>',
 sweat:'<svg viewBox="0 0 40 40"><path d="M22 6c4 8 9 13 9 19a9 9 0 0 1-18 0c0-6 5-11 9-19z" fill="#8cc8ff" stroke="#fff" stroke-width="2"/></svg>',
 tear:'<svg viewBox="0 0 40 40"><path d="M12 10c3 6 6 9 6 13a6 6 0 0 1-12 0c0-4 3-7 6-13zM28 16c2.4 5 5 7 5 10a5 5 0 0 1-10 0c0-3 2.6-5 5-10z" fill="#8cc8ff" stroke="#fff" stroke-width="1.6"/></svg>',
 bulb:'<svg viewBox="0 0 40 40"><g stroke="#ffd34d" stroke-width="2.6" stroke-linecap="round"><path d="M20 2v4M6 8l3 3M34 8l-3 3"/></g><path d="M20 10a9 9 0 0 0-5 16.5V30h10v-3.5A9 9 0 0 0 20 10z" fill="#ffd34d" stroke="#fff" stroke-width="1.8"/><rect x="15.5" y="31" width="9" height="4" rx="1.5" fill="#cfd6e3"/></svg>',
 sigh:'<svg viewBox="0 0 40 40"><circle cx="20" cy="18" r="15" fill="#fff"/><path d="M14 31l-3 6 8-4" fill="#fff"/><g fill="#7b8396"><circle cx="13" cy="18" r="2.4"/><circle cx="20" cy="18" r="2.4"/><circle cx="27" cy="18" r="2.4"/></g></svg>',
 sparkle:'<svg viewBox="0 0 40 40"><g fill="#ffe27a" stroke="#fff" stroke-width="1.4"><path d="M14 4l3 9 9 3-9 3-3 9-3-9-9-3 9-3z"/><path d="M30 20l2 5 5 2-5 2-2 5-2-5-5-2 5-2z"/></g></svg>',
 zzz:'<svg viewBox="0 0 40 40"><g font-family="sans-serif" font-weight="900" fill="#cfe2ff" stroke="#2c3e66" stroke-width=".8"><text x="8" y="34" font-size="13">z</text><text x="17" y="24" font-size="16">z</text><text x="27" y="13" font-size="19">Z</text></g></svg>'
};
export const GALGAME_ICONS = {
  "check": "<path d=\"M5 12l5 5 9-10\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2.2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/>",
  "wave": "<path d=\"M4 10v4M8 7v10M12 4v16M16 7v10M20 10v4\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\"/>",
  "down": "<path d=\"M6 9l6 6 6-6\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/>",
  "edit": "<path d=\"M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.8\" stroke-linejoin=\"round\"/>",
  "users": "<circle cx=\"9\" cy=\"8\" r=\"3.2\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.8\"/><path d=\"M3 19c.8-3.4 3.2-5 6-5s5.2 1.6 6 5M16 5.2a3 3 0 0 1 0 5.6M17.5 14c2 .5 3.2 2.2 3.5 5\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.8\" stroke-linecap=\"round\"/>",
  "image": "<rect x=\"3\" y=\"5\" width=\"18\" height=\"14\" rx=\"2\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.8\"/><circle cx=\"9\" cy=\"10\" r=\"1.7\" fill=\"currentColor\"/><path d=\"M4 18l5-5 4 4 3-3 4 4\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.8\" stroke-linejoin=\"round\"/>",
  "menu": "<path d=\"M4 7h16M4 12h16M4 17h16\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\"/>",
  "hist": "<path d=\"M4 12a8 8 0 1 0 2.4-5.7M4 4v4h4M12 8v4l3 2\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.9\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/>",
  "eyeoff": "<path d=\"M3 3l18 18M10.6 6.2A9.6 9.6 0 0 1 12 6c5 0 9 6 9 6a15 15 0 0 1-3 3.4M6.2 7.6C4.2 9.2 3 12 3 12s4 6 9 6c1.4 0 2.7-.4 3.9-1\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.8\" stroke-linecap=\"round\"/>",
  "stop": "<rect x=\"6\" y=\"6\" width=\"12\" height=\"12\" rx=\"2\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.9\"/>",
  "gear": "<circle cx=\"12\" cy=\"12\" r=\"3\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.8\"/><path d=\"M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.8\" stroke-linecap=\"round\"/>",
  "mic": "<rect x=\"9\" y=\"3\" width=\"6\" height=\"11\" rx=\"3\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.8\"/><path d=\"M5 11a7 7 0 0 0 14 0M12 18v3\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.8\" stroke-linecap=\"round\"/>",
  "live": "<path d=\"M4 8h13l-3-3M20 16H7l3 3\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.9\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/>",
  "at": "<circle cx=\"12\" cy=\"12\" r=\"3.5\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.8\"/><path d=\"M15.5 12v1.5a2.5 2.5 0 0 0 5 0V12a8.5 8.5 0 1 0-3.4 6.8\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.8\" stroke-linecap=\"round\"/>",
  "send": "<path d=\"M4 12l16-8-6 16-2.5-6.5z\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.8\" stroke-linejoin=\"round\"/>",
  "globe": "<circle cx=\"12\" cy=\"12\" r=\"9\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.8\"/><path d=\"M3 12h18M12 3c3 3.5 3 14.5 0 18M12 3c-3 3.5-3 14.5 0 18\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.8\"/>",
  "eye": "<path d=\"M3 12s4-6 9-6 9 6 9 6-4 6-9 6-9-6-9-6z\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.8\"/><circle cx=\"12\" cy=\"12\" r=\"2.6\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.8\"/>",
  "id": "<rect x=\"3\" y=\"5\" width=\"18\" height=\"14\" rx=\"2\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.8\"/><circle cx=\"9\" cy=\"11\" r=\"2.2\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.6\"/><path d=\"M6 16c.6-1.6 1.7-2.4 3-2.4s2.4.8 3 2.4M14.5 10h4M14.5 13.5h3\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.6\" stroke-linecap=\"round\"/>",
  "back": "<path d=\"M10 6l-6 6 6 6M4 12h16\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.9\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/>",
  "pet": "<path d=\"M3 14c2-5 5-7 9-7s7 2 9 7c-2 3-5 4-9 4s-7-1-9-4zM18 9l3-3M17 14h.01\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.8\" stroke-linecap=\"round\"/>",
  "auto": "<path d=\"M5 12a7 7 0 0 1 12-5l2 2M19 12a7 7 0 0 1-12 5l-2-2M19 4v5h-5M5 20v-5h5\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.8\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/>",
  "user": "<circle cx=\"12\" cy=\"8\" r=\"3.6\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.8\"/><path d=\"M5 20c1-4 3.8-6 7-6s6 2 7 6\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.8\" stroke-linecap=\"round\"/>"
};
