// Galgame private chat in the approved 1.9.0 design (surfaces 3.1-3.13). Appended last to GalgameCSS so it
// wins ties with the older .whg-* rules; colours come from the theme's dialogue tokens.
export const GalgameDesignCSS=`
/* top bar: title, character / model chips and the network switch; tools in five groups */
.gx-top{position:relative;z-index:5;display:flex;flex-direction:column;align-items:flex-start;gap:8px;padding:12px 16px 6px;min-width:0}
.gx-top::before{content:"";position:absolute;z-index:-1;left:0;right:0;top:0;bottom:-64px;background:linear-gradient(to bottom,color-mix(in srgb,var(--buddy-dlg-bg) 82%,transparent),transparent);pointer-events:none}
.galgame-page .whg-root-tab .gx-top{grid-area:1/1;align-self:start}
.whg-root>.gx-top{position:absolute;top:0;left:0;right:0}
.gx-row{display:flex;align-items:center;gap:8px;width:100%;min-width:0}
.gx-top .gx-title{display:inline-flex;align-items:center;gap:6px;min-width:0;padding:2px 8px 2px 4px;border:0;border-radius:8px;background:none;font-family:var(--buddy-f-head);font-size:19px;font-weight:700;letter-spacing:.02em;color:var(--buddy-dlg-text);text-shadow:0 1px 10px rgba(0,0,0,.35);white-space:nowrap;cursor:pointer}
.gx-top .gx-title .ui-icon{color:var(--buddy-dlg-muted)}
.gx-top .gx-title:hover{background:color-mix(in srgb,var(--buddy-dlg-text) 10%,transparent)}
.gx-chip{display:inline-flex;align-items:center;gap:6px;min-width:0;max-width:340px;height:30px;padding:0 10px 0 4px;border:0;border-radius:999px;font:inherit;font-size:var(--buddy-fs-sm);background:color-mix(in srgb,var(--buddy-dlg-bg) 80%,transparent);box-shadow:inset 0 0 0 1px var(--buddy-dlg-border);-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px);color:var(--buddy-dlg-text);white-space:nowrap;cursor:pointer}
.gx-chip.np{padding-left:10px}
.gx-chip small{color:var(--buddy-dlg-muted);font-size:var(--buddy-fs-cap)}
.gx-chip strong{overflow:hidden;text-overflow:ellipsis;font-weight:600}
.gx-chip>.ui-icon{color:var(--buddy-dlg-muted)}
.gx-chip.open,.gx-chip:focus-visible{outline:0;box-shadow:inset 0 0 0 1px var(--buddy-accent),0 0 0 3px color-mix(in srgb,var(--buddy-accent) 25%,transparent)}
.gx-face{display:inline-grid;place-items:center;flex:none;width:22px;height:22px;border-radius:50%;overflow:hidden;background:var(--buddy-surface2);color:var(--buddy-text);font-size:11px;font-weight:700}
.gx-face>img{width:100%;height:100%;object-fit:cover}
.gx-dot{width:7px;height:7px;border-radius:50%;flex:none;background:var(--buddy-ok);box-shadow:0 0 0 3px color-mix(in srgb,var(--buddy-ok) 22%,transparent)}
.gx-dot.off{background:var(--buddy-dlg-muted);box-shadow:none}
.gx-grow{flex:1}
.gx-net{display:inline-flex;align-items:center;gap:8px;height:30px;padding:0 5px 0 12px;border-radius:999px;font-size:var(--buddy-fs-sm);color:var(--buddy-dlg-text);background:color-mix(in srgb,var(--buddy-dlg-bg) 80%,transparent);box-shadow:inset 0 0 0 1px var(--buddy-dlg-border);-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px);white-space:nowrap}
.gx-net>.ui-icon{color:var(--buddy-dlg-muted)}
.gx-net .ui-switch{width:34px;height:20px}.gx-net .ui-switch::after{width:14px;height:14px}.gx-net .ui-switch[aria-checked=true]::after{left:17px}
.gx-tools{display:flex;flex-wrap:wrap;align-items:center;gap:2px;max-width:100%;padding:3px;border-radius:12px;background:color-mix(in srgb,var(--buddy-dlg-bg) 74%,transparent);box-shadow:inset 0 0 0 1px var(--buddy-dlg-border);-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px)}
.gx-tb{position:relative;display:inline-flex;align-items:center;gap:6px;height:30px;padding:0 10px;border:0;border-radius:9px;background:none;font:inherit;font-size:var(--buddy-fs-sm);color:var(--buddy-dlg-text);white-space:nowrap;cursor:pointer}
.gx-tb>.ui-icon{color:var(--buddy-dlg-muted)}
.gx-tb:hover,.gx-tb.open{background:color-mix(in srgb,var(--buddy-dlg-text) 12%,transparent)}
.gx-tb[aria-pressed=true]{background:color-mix(in srgb,var(--buddy-accent) 22%,transparent);box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--buddy-accent) 48%,transparent)}
.gx-tb[aria-pressed=true]>.ui-icon{color:var(--buddy-dlg-text)}
.gx-tb:focus-visible{outline:2px solid var(--buddy-accent);outline-offset:1px}
.gx-tb:disabled{opacity:.5;cursor:default}
.gx-tb.only{width:30px;padding:0;justify-content:center}
.gx-tb.gx-glass{background:color-mix(in srgb,var(--buddy-dlg-bg) 80%,transparent);box-shadow:inset 0 0 0 1px var(--buddy-dlg-border)}
.gx-cnt{display:inline-grid;place-items:center;min-width:18px;height:18px;padding:0 5px;border-radius:9px;background:var(--buddy-accent);color:var(--buddy-on-accent);font-size:11px;font-weight:700;font-variant-numeric:tabular-nums}
.gx-sep{width:1px;height:18px;margin:0 4px;background:var(--buddy-dlg-border)}
.gx-confirm-wrap{position:relative;display:inline-flex}
.gx-confirm{position:absolute;z-index:40;top:calc(100% + 8px);right:-4px;display:grid;gap:4px;width:240px;padding:12px 14px;border-radius:12px;background:var(--buddy-surface);color:var(--buddy-text);font-size:var(--buddy-fs-sm);box-shadow:0 0 0 1px var(--buddy-border),0 16px 32px -14px rgba(0,0,0,.55)}
.gx-confirm>span{color:var(--buddy-muted);font-size:var(--buddy-fs-cap)}
.gx-confirm-btns{display:flex;justify-content:flex-end;gap:6px;margin-top:6px}
/* dialogue box */
.whg-panel.gx-dlg{display:flex;flex-direction:column;gap:12px;background:color-mix(in srgb,var(--buddy-dlg-bg) 93%,transparent);color:var(--buddy-dlg-text);border:1px solid var(--buddy-dlg-border);border-radius:var(--buddy-r-dlg);-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px);box-shadow:0 18px 40px -20px rgba(0,0,0,.6)}
.galgame-page .whg-root-tab .whg-panel.gx-dlg{margin:22px 20px 16px;padding:26px 22px 16px;gap:12px}
.whg-plate.gx-plate{top:-17px;left:22px;display:inline-flex;align-items:center;height:32px;padding:0 22px;border-radius:999px;font-family:var(--buddy-f-head);font-weight:700;font-size:16px;letter-spacing:.12em;box-shadow:0 6px 16px -8px rgba(0,0,0,.5)}
.gx-plate>.gx-acc{position:absolute;right:-18px;top:-14px;width:calc(var(--buddy-acc-w) / 2);height:calc(var(--buddy-acc-h) / 2);background:var(--buddy-orn-image) center/contain no-repeat;transform:rotate(12deg);pointer-events:none}
.whg-level.gx-lvl,.galgame-page .whg-panel .whg-level.gx-lvl{top:11px;right:20px;gap:8px;font-size:var(--buddy-fs-cap);color:var(--buddy-dlg-muted);font-variant-numeric:tabular-nums}
.gx-lvl b{color:var(--buddy-dlg-text);font-weight:600}
.gx-track{display:block;width:112px;height:6px;border-radius:3px;background:color-mix(in srgb,var(--buddy-dlg-text) 14%,transparent);overflow:hidden}
.gx-track>s{display:block;height:100%;border-radius:3px;background:linear-gradient(90deg,var(--buddy-accent),var(--buddy-bar-end));transition:width .6s ease}
.galgame-page .whg-panel.gx-dlg .whg-line-now{font-size:clamp(15px,1.5vw,20px);line-height:1.55;font-weight:500;color:var(--buddy-dlg-text)}
.galgame-page .whg-panel.gx-dlg .whg-line-now.narrator,.galgame-page .whg-panel.gx-dlg .whg-line-now.muted{color:var(--buddy-dlg-muted)}
.galgame-page .whg-panel.gx-dlg .whg-line-now.user{color:var(--buddy-dlg-text)}
.gx-typing{display:inline-flex;align-items:center;gap:10px;color:var(--buddy-dlg-muted)}
.galgame-page .whg-panel.gx-dlg .whg-line-now.gx-typing{font-size:var(--buddy-fs-body)}
.gx-typing>span{display:inline-flex;gap:4px}
.gx-typing i{width:7px;height:7px;border-radius:50%;background:var(--buddy-dlg-muted);animation:gx-dot 1.2s ease-in-out infinite}
.gx-typing i:nth-child(2){animation-delay:.15s}.gx-typing i:nth-child(3){animation-delay:.3s}
@keyframes gx-dot{0%,60%,100%{opacity:.35;transform:none}30%{opacity:1;transform:translateY(-3px)}}
.galgame-page .whg-panel .gx-choices,.gx-choices{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin:0}
.galgame-page .whg-panel .gx-choice,.gx-choice{display:flex;align-items:center;gap:10px;min-width:0;max-height:none;height:38px;padding:0 12px;border:0;border-radius:var(--buddy-r-btn-s);background:var(--buddy-choice-bg);box-shadow:inset 0 0 0 1px var(--buddy-dlg-border);color:var(--buddy-dlg-text);font:inherit;font-size:var(--buddy-fs-body);text-align:left;overflow:hidden;cursor:pointer}
.gx-choice>span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gx-choice:hover:not(:disabled),.gx-choice:focus-visible{outline:0;background:color-mix(in srgb,var(--buddy-accent) 20%,var(--buddy-choice-bg));box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--buddy-accent) 55%,transparent)}
.gx-choice kbd{display:grid;place-items:center;flex:none;width:20px;height:20px;border-radius:6px;font:600 11px/1 var(--buddy-f-ui);background:color-mix(in srgb,var(--buddy-dlg-text) 10%,transparent);color:var(--buddy-dlg-muted)}
.galgame-page .whg-panel .gx-say,.gx-say{display:flex;gap:8px;align-items:stretch;margin:0}
.gx-ta{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px;padding:7px 12px 6px;border-radius:12px;background:color-mix(in srgb,var(--buddy-dlg-text) 6%,var(--buddy-dlg-bg));box-shadow:inset 0 0 0 1px var(--buddy-dlg-border);cursor:text}
.gx-ta:focus-within{box-shadow:inset 0 0 0 1px var(--buddy-accent),0 0 0 3px color-mix(in srgb,var(--buddy-accent) 22%,transparent)}
.gx-ta.dis{opacity:.6}
.galgame-page .whg-panel .gx-ta .whg-input,.gx-ta .whg-input{flex:1;min-height:22px;padding:0;border:0;border-radius:0;background:none;color:var(--buddy-dlg-text);font:inherit;font-size:var(--buddy-fs-body);line-height:1.5;resize:none;outline:0;box-shadow:none}
.gx-ta .whg-input::placeholder{color:var(--buddy-dlg-muted)}
.gx-ta>small{align-self:flex-end;font-size:11px;color:var(--buddy-dlg-muted)}
.galgame-page .whg-panel .gx-send,.gx-send{display:inline-flex;align-items:center;gap:6px;padding:0 20px;border:0;border-radius:12px;background:var(--buddy-accent);color:var(--buddy-on-accent);font:inherit;font-weight:700;font-size:var(--buddy-fs-body);white-space:nowrap;cursor:pointer}
.gx-send:disabled{opacity:.45;cursor:default}
.gx-send:hover:not(:disabled){background:var(--buddy-accent-hover)}
.gx-alert{display:flex;align-items:center;gap:10px;padding:8px 8px 8px 12px;border-radius:10px;font-size:var(--buddy-fs-sm);color:var(--buddy-dlg-text);background:color-mix(in srgb,var(--buddy-err) 14%,transparent);box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--buddy-err) 42%,transparent)}
.gx-alert>.ui-icon{flex:none;color:var(--buddy-err)}
.gx-alert b{color:var(--buddy-err);font-weight:600}
.gx-alert.warn{background:color-mix(in srgb,var(--buddy-warn) 12%,transparent);box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--buddy-warn) 40%,transparent)}
.gx-alert.warn>.ui-icon,.gx-alert.warn b{color:var(--buddy-warn)}
.gx-alert.info{background:color-mix(in srgb,var(--buddy-accent) 12%,transparent);box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--buddy-accent) 40%,transparent)}
.gx-alert.info>.ui-icon{color:var(--buddy-accent-text)}
.gx-alert .grow{flex:1;min-width:0}
.galgame-page .whg-panel .gx-alert.whg-fallback-note{max-height:none;overflow:visible}
.gx-gbtn{display:inline-flex;align-items:center;gap:6px;flex:none;height:28px;padding:0 12px;border:0;border-radius:8px;font:inherit;font-size:var(--buddy-fs-sm);font-weight:600;color:var(--buddy-dlg-text);background:color-mix(in srgb,var(--buddy-dlg-text) 10%,transparent);white-space:nowrap;cursor:pointer}
.gx-gbtn.pri{background:var(--buddy-accent);color:var(--buddy-on-accent)}
.gx-gbtn:disabled{opacity:.5;cursor:default}
/* pickers */
.whg-picker.gx-pop{display:flex;flex-direction:column;width:min(340px,calc(100vw - 28px));padding:0;border:0;border-radius:14px;background:var(--buddy-surface);color:var(--buddy-text);box-shadow:0 0 0 1px var(--buddy-border),0 24px 48px -16px rgba(0,0,0,.55)}
.whg-picker.gx-pop.gx-pop-wide{width:min(400px,calc(100vw - 28px))}
.gx-pop-h{display:flex;align-items:center;gap:8px;padding:12px 14px 10px;font-size:var(--buddy-fs-body);font-weight:700}
.gx-pop-h small{font-weight:500;font-size:var(--buddy-fs-cap);color:var(--buddy-muted)}
.gx-pop-h .grow,.gx-pop-f .grow{flex:1}
.gx-pop-b{display:flex;flex-direction:column;gap:10px;min-height:0;padding:0 14px 12px}
.gx-pop-f{display:flex;align-items:center;gap:8px;padding:10px 14px;border-top:1px solid var(--buddy-border);font-size:var(--buddy-fs-cap);color:var(--buddy-muted)}
.gx-follow{display:flex;align-items:center;gap:10px;width:100%;padding:8px 10px;border:0;border-radius:10px;background:none;box-shadow:inset 0 0 0 1px var(--buddy-border);color:var(--buddy-text);font:inherit;font-size:var(--buddy-fs-sm);text-align:left;cursor:pointer}
.gx-follow>span{flex:1;min-width:0}
.gx-follow b{display:block;font-weight:600}
.gx-follow small{display:block;color:var(--buddy-muted);font-size:var(--buddy-fs-cap)}
.gx-follow>.ui-icon{color:var(--buddy-muted)}
.gx-follow.sel{box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--buddy-accent) 55%,transparent);background:color-mix(in srgb,var(--buddy-accent) 10%,transparent)}
.gx-follow.sel>.ui-icon:last-child{color:var(--buddy-accent-text)}
.gx-cgrid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:4px}
.gx-copt{display:flex;align-items:center;gap:10px;min-width:0;height:44px;padding:0 10px 0 6px;border:0;border-radius:10px;background:none;color:var(--buddy-text);font:inherit;font-size:var(--buddy-fs-sm);text-align:left;cursor:pointer}
.gx-copt:hover,.gx-copt:focus-visible,.gx-follow:hover,.gx-follow:focus-visible{outline:0;background:var(--buddy-surface2)}
.gx-copt>.gx-face{width:30px;height:30px}
.gx-copt>span:not(.gx-face){flex:1;min-width:0}
.gx-copt b{display:block;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.gx-copt small{display:block;font-size:11px;color:var(--buddy-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.gx-copt.sel{background:color-mix(in srgb,var(--buddy-accent) 14%,transparent);box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--buddy-accent) 45%,transparent)}
.gx-copt.sel>.ui-icon{color:var(--buddy-accent-text)}
.gx-pop .gx-sec{margin:2px 0 0;font-size:var(--buddy-fs-cap);font-weight:700;color:var(--buddy-muted);letter-spacing:.04em}
.gx-prev{position:relative}
.gx-pop .gx-prev .whg-bg-preview{margin:0;border:0;border-radius:10px;box-shadow:inset 0 0 0 1px var(--buddy-border);object-fit:cover}
.gx-prev>.ws-tag{position:absolute;left:8px;top:8px;background:color-mix(in srgb,var(--buddy-surface) 88%,transparent)}
.gx-pop .whg-bg-builtins{display:flex;flex-direction:column;gap:8px;margin:0;padding:0;border:0;background:none}
.gx-pop .whg-bg-builtin{border:0;border-radius:10px;box-shadow:inset 0 0 0 1px var(--buddy-border);background:var(--buddy-surface2);color:var(--buddy-text)}
.gx-pop .whg-bg-builtin[aria-pressed=true]{box-shadow:inset 0 0 0 2px var(--buddy-accent)}
.gx-pop .whg-bg-builtin-meta{color:var(--buddy-text)}
.gx-pop .whg-bg-builtin-tag{background:var(--buddy-surface);color:var(--buddy-muted)}
.gx-pop .whg-bg-override-note{color:var(--buddy-warn)}
.gx-pop .whg-sprite-preview-shell{margin:0;border:0;border-radius:10px;box-shadow:inset 0 0 0 1px var(--buddy-border);background:repeating-conic-gradient(color-mix(in srgb,var(--buddy-text) 7%,var(--buddy-surface)) 0 25%,var(--buddy-surface) 0 50%) 0 0/20px 20px}
.gx-hint{margin:0;font-size:var(--buddy-fs-cap);color:var(--buddy-muted);line-height:1.6}
.gx-pop .whg-bg-error{margin:0}
/* CG gallery drawer */
.whg-archive-scrim.gx-scrim{background:rgba(0,0,0,.38)}
.whg-archive.gx-drawer{display:flex;flex-direction:column;width:min(460px,calc(100% - 42px));background:var(--buddy-surface);color:var(--buddy-text);border:0;border-radius:0;box-shadow:-28px 0 56px -28px rgba(0,0,0,.6),inset 1px 0 0 var(--buddy-border)}
.whg-archive.gx-drawer::before,.whg-archive.gx-drawer::after{display:none}
.gx-dh{position:relative;display:flex;flex-direction:column;gap:6px;padding:18px 20px 14px;border-bottom:1px solid var(--buddy-border)}
.gx-dh h3{margin:0;padding-right:40px;font-family:var(--buddy-f-head);font-size:22px;font-weight:700}
.gx-dh .kick{font-size:var(--buddy-fs-cap);color:var(--buddy-muted);font-variant-numeric:tabular-nums}
.gx-dh-x{position:absolute;right:12px;top:12px}
.gx-dh-row{display:flex;align-items:center;gap:8px;margin-top:4px}
.gx-dh-row .grow{flex:1}
.whg-archive-body.gx-db{flex:1;min-height:0;display:flex;flex-direction:column;gap:12px;padding:16px 20px 72px;overflow-y:auto;scrollbar-color:auto}
.gx-cg-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
.gx-cg{position:relative;display:block;min-width:0;padding:0;border:0;border-radius:12px;overflow:hidden;background:var(--buddy-surface2);box-shadow:0 0 0 1px var(--buddy-border);color:var(--buddy-text);font:inherit;text-align:left;cursor:pointer;transition:box-shadow .15s var(--buddy-ease)}
.gx-cg:hover,.gx-cg:focus-visible{outline:0;box-shadow:0 0 0 2px color-mix(in srgb,var(--buddy-accent) 60%,var(--buddy-border))}
.gx-cg.hl{box-shadow:0 0 0 2px var(--buddy-accent)}
.gx-cg[aria-disabled=true]{cursor:default}
.gx-cg-img{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;aspect-ratio:16/10;padding:8px;font-size:var(--buddy-fs-sm);color:var(--buddy-muted);text-align:center;overflow:hidden}
.gx-cg-img>img{width:100%;height:100%;margin:-8px;object-fit:cover;min-width:calc(100% + 16px);min-height:calc(100% + 16px)}
.gx-cg-img.wait{background:color-mix(in srgb,var(--buddy-accent) 7%,var(--buddy-surface2));color:var(--buddy-muted)}
.gx-cg-img.wait .ui-spinner{color:var(--buddy-accent)}
.gx-cg-img.fail{background:color-mix(in srgb,var(--buddy-err) 7%,var(--buddy-surface2));color:var(--buddy-err)}
.gx-steps{display:flex;gap:4px}
.gx-steps>i{width:22px;height:4px;border-radius:2px;background:color-mix(in srgb,var(--buddy-text) 14%,transparent)}
.gx-steps>i.d{background:var(--buddy-accent)}
.gx-steps>i.n{background:color-mix(in srgb,var(--buddy-accent) 45%,transparent)}
.gx-cg-tag{position:absolute;left:8px;top:8px;background:color-mix(in srgb,var(--buddy-surface) 88%,transparent)}
.gx-cg-m{display:flex;align-items:center;gap:8px;padding:8px 10px;font-size:var(--buddy-fs-cap);color:var(--buddy-muted)}
.gx-cg-m b{color:var(--buddy-accent-text);font-weight:700;font-variant-numeric:tabular-nums}
.gx-cg-m span{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.gx-cg-skel{display:block;aspect-ratio:16/12;border-radius:12px}
.gx-cg-empty{margin-top:12px}
.gx-snack{position:absolute;z-index:3;left:20px;right:20px;bottom:16px}
.gx-snack .grow{flex:1}
.gx-snack button{display:inline-flex;align-items:center;gap:4px}
.gx-snack-left{opacity:.65;font-variant-numeric:tabular-nums}
.gx-cg-menu{z-index:9700;min-width:200px}
.gx-back{display:inline-flex;align-items:center;gap:4px;align-self:flex-start;padding:0;border:0;background:none;font:inherit;font-size:var(--buddy-fs-sm);color:var(--buddy-accent-text);font-weight:600;cursor:pointer}
button.gx-back:hover{text-decoration:underline;text-underline-offset:3px}
.gx-back>.ui-icon{transform:rotate(90deg)}
.gx-detail{display:flex;flex-direction:column;gap:12px}
.gx-big{position:relative;border-radius:12px;overflow:hidden;box-shadow:inset 0 0 0 1px var(--buddy-border)}
.gx-big .buddy-cg-open{border-radius:0}
.gx-big-wait{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;aspect-ratio:16/10;padding:16px;background:var(--buddy-surface2);color:var(--buddy-muted);font-size:var(--buddy-fs-sm);text-align:center}
.gx-big-wait.err{color:var(--buddy-err)}
.gx-meta{display:flex;flex-direction:column;gap:2px}
.gx-meta b{font-family:var(--buddy-f-head);font-size:17px}
.gx-meta small{font-size:var(--buddy-fs-cap);color:var(--buddy-muted)}
.gx-acts{display:flex;gap:8px;flex-wrap:wrap}
.gx-detail .whg-gallery-prompt{margin:0;padding:8px 12px 10px 36px;font-size:var(--buddy-fs-cap);color:var(--buddy-muted);white-space:pre-wrap;overflow-wrap:anywhere}
/* CG progress toast, reward dialog, whole-page states */
.whg-toast.gx-toast{position:absolute;z-index:30;left:auto;top:auto;right:16px;bottom:16px;transform:none;display:flex;gap:12px;align-items:flex-start;width:min(350px,calc(100% - 32px));padding:12px 12px 12px 14px;border:0;border-radius:12px;background:var(--buddy-surface);color:var(--buddy-text);box-shadow:0 0 0 1px var(--buddy-border),0 16px 32px -14px rgba(0,0,0,.55);font-size:var(--buddy-fs-sm);cursor:default}
.gx-toast>.ui-icon,.gx-toast>.ui-spinner{flex:none;margin-top:1px}
.gx-toast>.ui-spinner{color:var(--buddy-accent)}
.gx-toast>div{flex:1;min-width:0;display:flex;flex-direction:column;gap:6px}
.gx-toast small{color:var(--buddy-muted);font-size:var(--buddy-fs-cap)}
.gx-toast .gx-steps>i{flex:1;width:auto}
.gx-toast.err{box-shadow:0 0 0 1px color-mix(in srgb,var(--buddy-err) 50%,var(--buddy-border)),0 16px 32px -14px rgba(0,0,0,.55)}
.gx-toast.err>.ui-icon{color:var(--buddy-err)}
.gx-row-btns{display:flex;gap:6px}
.whg-cg-backdrop.gx-veil{position:absolute;inset:0;z-index:39;display:grid;place-items:center;padding:24px;background:rgba(2,6,14,.62);-webkit-backdrop-filter:blur(3px);backdrop-filter:blur(3px)}
.gx-gift{width:min(680px,100%);max-height:100%;overflow:auto;border-radius:var(--buddy-r-dlg);background:var(--buddy-surface);color:var(--buddy-text);box-shadow:0 0 0 1px var(--buddy-border),0 40px 80px -30px rgba(0,0,0,.7)}
.gx-gift .gx-big{border-radius:0;box-shadow:none}
.gx-gift-b{display:flex;align-items:center;gap:14px;padding:16px 18px}
.gx-gift-b>.gx-face{width:40px;height:40px}
.gx-gift-b h4{margin:0;font-family:var(--buddy-f-head);font-size:18px}
.gx-gift-b p{margin:2px 0 0;font-size:var(--buddy-fs-sm);color:var(--buddy-muted)}
.gx-gift-b .grow{flex:1;min-width:0}
.gx-full{position:absolute;inset:0;z-index:5;display:grid;place-items:center;padding:24px;background:color-mix(in srgb,var(--buddy-dlg-bg) 55%,transparent)}
.gx-fcard{display:flex;flex-direction:column;align-items:center;gap:10px;max-width:320px;padding:24px 22px;border-radius:var(--buddy-r-card);background:color-mix(in srgb,var(--buddy-surface) 94%,transparent);color:var(--buddy-text);text-align:center;box-shadow:0 0 0 1px var(--buddy-border),0 20px 40px -20px rgba(0,0,0,.6)}
.gx-fcard h4{margin:0;font-family:var(--buddy-f-head);font-size:18px}
.gx-fcard p{margin:0;font-size:var(--buddy-fs-sm);color:var(--buddy-muted);line-height:1.6;overflow-wrap:anywhere}
.gx-fcard>.ui-icon{color:var(--buddy-accent-text)}
.gx-fcard.err>.ui-icon{color:var(--buddy-err)}
.gx-big-spin{width:28px;height:28px;border-width:3px;color:var(--buddy-accent)}
/* old skits, read-only, inside 角色与对话 › 对话历史 */
.buddy-skits-entry{display:flex;align-items:center;gap:12px;width:100%;text-align:left;cursor:pointer}
.buddy-skits-entry>div{flex:1;min-width:0}
.buddy-skits-ico{display:inline-grid;place-items:center;flex:none;width:36px;height:36px;border-radius:10px;background:var(--buddy-surface2);color:var(--buddy-accent-text)}
.buddy-old-skits{display:flex;flex-direction:column;gap:12px}
.buddy-skits-head{display:flex;align-items:center;gap:12px}
.buddy-skits-head .buddy-skits-ico{width:46px;height:46px}
.buddy-skits-head h3{display:flex;align-items:center;gap:8px;margin:0;font-size:var(--buddy-fs-lg)}
.buddy-skits-head small{color:var(--buddy-muted);font-size:var(--buddy-fs-cap)}
.buddy-skit{display:flex;flex-direction:column;gap:8px;padding:12px 14px;border-radius:12px;background:var(--buddy-surface2);box-shadow:0 0 0 1px var(--buddy-border)}
.buddy-skit-h{display:flex;align-items:center;gap:8px;font-size:var(--buddy-fs-cap);color:var(--buddy-muted)}
.buddy-skit-h b{color:var(--buddy-text);font-size:var(--buddy-fs-sm)}
.buddy-skit-faces{display:flex}
.buddy-skit-face{display:inline-grid;place-items:center;width:24px;height:24px;border-radius:50%;overflow:hidden;background:var(--buddy-surface);box-shadow:0 0 0 2px var(--buddy-surface2);font-size:11px;font-weight:700}
.buddy-skit-face+.buddy-skit-face{margin-left:-6px}
.buddy-skit-face>img{width:100%;height:100%;object-fit:cover}
.buddy-skit p{margin:0;font-size:var(--buddy-fs-sm);line-height:1.6;color:var(--buddy-text)}
.buddy-skit p em{margin-right:6px;font-style:normal;font-weight:700}
.buddy-skit .buddy-skit-seed{color:var(--buddy-muted);font-size:var(--buddy-fs-cap)}
.buddy-skit-f{display:flex;align-items:center;gap:8px;padding-top:8px;border-top:1px solid var(--buddy-border);font-size:var(--buddy-fs-cap);color:var(--buddy-muted)}
.ws-fld-foot{display:flex;justify-content:space-between;gap:12px}
@media (max-width:1100px){.gx-choices,.galgame-page .whg-panel .gx-choices{grid-template-columns:minmax(0,1fr)}.galgame-page .whg-panel .gx-choice{height:34px}}
@media (prefers-reduced-motion:reduce){.gx-typing i{animation:none}.gx-cg{transition:none}}
`;
