// UI polish 1.9.0 · section 4 (character manager and group chat). Appended after GalgameDesignCSS
// so these rules win over CompanionCSS, GroupStageCSS and GroupCgCSS. Colours come from the theme tokens only.
export const CompanionDesignCSS=`
/* ---- shared pieces ---- */
.buddy-dialog .spacer,.buddy-group-panel .spacer{min-width:0}
.buddy-sr{position:absolute!important;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.buddy-face{display:inline-grid;place-items:center;flex:none;width:32px;height:32px;border-radius:50%;overflow:hidden;background:var(--buddy-surface2);color:var(--buddy-text);font-size:var(--buddy-fs-sm);font-weight:700;box-shadow:inset 0 0 0 1px var(--buddy-border)}
.buddy-face>img{width:100%;height:100%;object-fit:cover}
.buddy-face.lg{width:44px;height:44px;font-size:var(--buddy-fs-md)}
.buddy-face.sm{width:22px;height:22px;font-size:var(--buddy-fs-cap)}
.buddy-face.blank{color:var(--buddy-muted)}
.buddy-faces{display:inline-flex;align-items:center;flex:none}
.buddy-faces>*+*{margin-left:-8px}
.buddy-faces>.buddy-face,.buddy-faces>.gx-face{box-shadow:0 0 0 2px var(--buddy-surface)}
.gx-chip .buddy-faces>.gx-face{width:20px;height:20px;box-shadow:0 0 0 2px var(--buddy-dlg-bg)}
.buddy-dialog{font:var(--buddy-fs-body)/1.55 var(--buddy-f-ui);border:0;border-radius:var(--buddy-r-dlg);background:var(--buddy-surface);color:var(--buddy-text);box-shadow:0 30px 80px -30px var(--buddy-shadow),0 0 0 1px var(--buddy-border)}
.buddy-dialog::backdrop{background:var(--buddy-scrim);backdrop-filter:blur(3px)}
.buddy-dialog h3{font-size:var(--buddy-fs-lg);font-weight:650}
.buddy-ghost{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:var(--buddy-h-md);padding:0 12px;border:0;border-radius:var(--buddy-r-btn);background:transparent;color:var(--buddy-text);box-shadow:inset 0 0 0 1px var(--buddy-border);font:inherit;font-weight:500;cursor:pointer;white-space:nowrap}
.buddy-ghost:hover:not(:disabled){background:var(--buddy-surface2)}
.buddy-ghost:disabled{opacity:.45;cursor:default}
.buddy-ghost>.ui-icon{color:var(--buddy-muted)}
.buddy-icon{display:inline-grid;place-items:center;flex:none;width:28px;height:28px;padding:0;border:0;border-radius:var(--buddy-r-btn-s);background:transparent;color:var(--buddy-muted);cursor:pointer}
.buddy-icon:hover:not(:disabled){background:var(--buddy-surface2);color:var(--buddy-text)}
.buddy-link{padding:0;border:0;background:none;color:var(--buddy-accent-text);font:inherit;font-size:var(--buddy-fs-cap);cursor:pointer}
.buddy-link:hover{text-decoration:underline}
.buddy-dialog :is(.buddy-ghost,.buddy-icon,.buddy-link,.buddy-op,.buddy-chip,.buddy-side-item,.buddy-new,.buddy-pick):focus-visible{outline:2px solid var(--buddy-accent);outline-offset:2px}
.buddy-ok{display:inline-flex;align-items:center;gap:4px;font-size:var(--buddy-fs-cap);color:var(--buddy-ok)}
.buddy-subhead{display:flex;align-items:baseline;gap:6px;margin:20px 0 10px!important;font-size:var(--buddy-fs-md)!important}
.buddy-subhead small{font-weight:400;font-size:var(--buddy-fs-cap)}
.buddy-searchbox{display:flex;align-items:center;gap:8px;height:34px;padding:0 10px;border-radius:var(--buddy-r-btn);background:color-mix(in srgb,var(--buddy-bg) 45%,var(--buddy-surface));box-shadow:inset 0 0 0 1px var(--buddy-border);color:var(--buddy-muted)}
.buddy-searchbox:focus-within{box-shadow:inset 0 0 0 1px var(--buddy-accent)}
.buddy-searchbox>input,.buddy-searchbox>input.buddy-memory-search{flex:1;min-width:0;height:100%;padding:0;border:0;background:transparent;color:var(--buddy-text);font:inherit;outline:0}
.buddy-switch-row{display:inline-flex;align-items:center;gap:8px;font-size:var(--buddy-fs-sm);color:var(--buddy-muted)}
.buddy-switch-row.wide{display:flex;justify-content:space-between;gap:16px;padding:6px 0}
.buddy-switch-row.wide b{display:block;color:var(--buddy-text);font-weight:600}
.buddy-switch-row.wide small{display:block;font-size:var(--buddy-fs-cap)}
.buddy-dialog .ui-seg.sm>button{height:22px;padding:0 9px;font-size:var(--buddy-fs-cap)}
.buddy-dialog .ui-seg{flex-wrap:wrap}
.buddy-dialog .buddy-field>.ui-seg{display:inline-flex;width:auto;align-self:flex-start}
.buddy-field .buddy-field>.buddy-field-label{display:none}
.buddy-dialog :is(.buddy-field input:not([type=checkbox]):not([type=range]),.buddy-field textarea,.buddy-field select,.buddy-search input,.buddy-group-input,.buddy-dates input,.buddy-danger-zone select,.buddy-scope-source select){border:0;border-radius:var(--buddy-r-btn);background:color-mix(in srgb,var(--buddy-bg) 45%,var(--buddy-surface));box-shadow:inset 0 0 0 1px var(--buddy-border);color:var(--buddy-text)}
.buddy-dialog :is(.buddy-field input,.buddy-field textarea,.buddy-field select,.buddy-group-input,.buddy-dates input):focus-visible{outline:0;box-shadow:inset 0 0 0 1px var(--buddy-accent),0 0 0 3px color-mix(in srgb,var(--buddy-accent) 20%,transparent)}
.buddy-dialog .buddy-field label>small{display:inline;margin-left:6px;font-weight:400;font-size:var(--buddy-fs-cap);color:var(--buddy-muted)}
.buddy-dialog input[type=range]{accent-color:var(--buddy-accent)}

/* ---- manager shell: icon tabs ---- */
.buddy-dialog-head{padding:16px 20px 12px;border-bottom:0}
.buddy-dialog-head h2{font-size:var(--buddy-fs-lg)}
.buddy-dialog-head small{font-size:var(--buddy-fs-sm)}
.buddy-tabs{gap:2px;padding:0 16px;flex-wrap:nowrap;overflow-x:auto;border-bottom:1px solid var(--buddy-border);scrollbar-width:none}
.buddy-tabs>button[role=tab]{display:inline-flex;align-items:center;gap:6px;height:40px;margin-bottom:-1px;padding:0 12px;border:0;border-bottom:2px solid transparent;border-radius:0;background:none;color:var(--buddy-muted);font:inherit;font-weight:500;white-space:nowrap;cursor:pointer}
.buddy-tabs>button[role=tab]:hover{color:var(--buddy-text)}
.buddy-tabs>button[role=tab][aria-selected=true]{color:var(--buddy-text);border-bottom-color:var(--buddy-accent);background:none}
.buddy-tabs>button[role=tab][aria-selected=true] .buddy-tab-icon{color:var(--buddy-accent-text)}
.buddy-tabs>button[role=tab]:focus-visible{outline:2px solid var(--buddy-accent);outline-offset:-2px}
.buddy-tab-icon{display:inline-flex}
.buddy-dialog-body{padding:18px 20px 20px}
.buddy-dialog-foot{padding:10px 20px;border-top:1px solid var(--buddy-border);background:color-mix(in srgb,var(--buddy-bg) 25%,var(--buddy-surface))}
.buddy-status{font-size:var(--buddy-fs-sm);color:var(--buddy-muted)}
.buddy-status.buddy-error{color:var(--buddy-err)}

/* ---- left column ---- */
.buddy-columns{grid-template-columns:220px minmax(0,1fr);gap:22px}
.buddy-columns.buddy-history{grid-template-columns:290px minmax(0,1fr)}
.buddy-sidebar{gap:8px}
.buddy-sidebar-list{gap:2px;max-height:none}
.buddy-side-h{margin:6px 4px 0;font-size:var(--buddy-fs-cap);font-weight:600;letter-spacing:.04em;color:var(--buddy-muted)}
.buddy-new{display:flex;align-items:center;gap:8px;width:100%;min-height:36px;padding:0 12px;border:1px dashed color-mix(in srgb,var(--buddy-accent) 55%,var(--buddy-border));border-radius:var(--buddy-r-btn);background:transparent;color:var(--buddy-accent-text);font:inherit;font-weight:600;cursor:pointer}
.buddy-new:hover{background:color-mix(in srgb,var(--buddy-accent) 8%,transparent)}
.buddy-sidebar .buddy-side-item{display:flex;align-items:center;gap:10px;width:100%;min-height:48px;padding:6px 10px;border:0;border-radius:var(--buddy-r-btn);background:transparent;color:var(--buddy-text);font:inherit;text-align:left;cursor:pointer}
.buddy-sidebar .buddy-side-item:hover{background:var(--buddy-surface2)}
.buddy-sidebar .buddy-side-item[aria-current=true]{background:color-mix(in srgb,var(--buddy-accent) 14%,var(--buddy-surface));box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--buddy-accent) 38%,transparent)}
.buddy-side-item>span:not(.buddy-face):not(.ws-tag):not(.buddy-faces){display:flex;flex-direction:column;flex:1;min-width:0}
.buddy-side-item b{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.buddy-sidebar .buddy-side-item small{display:block;margin:0;font-size:var(--buddy-fs-cap);color:var(--buddy-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.buddy-side-item>.ws-tag{flex:none}
.buddy-dates{display:grid;grid-template-columns:1fr 1fr;gap:6px}
.buddy-dates input{min-width:0;height:30px;padding:0 6px;font:inherit;font-size:var(--buddy-fs-cap)}
.buddy-chips{display:flex;gap:6px;flex-wrap:wrap}
.buddy-chip{display:inline-flex;align-items:center;gap:5px;height:26px;padding:0 10px;border:0;border-radius:999px;background:var(--buddy-surface2);color:var(--buddy-muted);box-shadow:inset 0 0 0 1px var(--buddy-border);font:inherit;font-size:var(--buddy-fs-cap);cursor:pointer}
.buddy-chip[aria-pressed=true]{background:color-mix(in srgb,var(--buddy-accent) 16%,var(--buddy-surface));color:var(--buddy-accent-text);box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--buddy-accent) 45%,transparent)}

/* ---- form header, jump links, fields ---- */
.buddy-form-title{display:flex;align-items:center;gap:12px;margin-bottom:12px}
.buddy-form-title h3{display:flex;align-items:center;gap:8px;margin:0;overflow-wrap:anywhere}
.buddy-form-title small{display:block;margin-top:2px;font-size:var(--buddy-fs-sm)}
.buddy-jump{position:sticky;top:-18px;z-index:3;display:flex;flex-wrap:wrap;gap:2px;margin:0 0 14px;padding:8px 0;background:var(--buddy-surface);border-bottom:1px solid var(--buddy-border)}
.buddy-jump>button{height:26px;padding:0 10px;border:0;border-radius:999px;background:transparent;color:var(--buddy-muted);box-shadow:none;font:inherit;font-size:var(--buddy-fs-sm);cursor:pointer;min-height:0}
.buddy-jump>button:hover{background:var(--buddy-surface2);color:var(--buddy-text)}
.buddy-section{scroll-margin-top:52px}
.buddy-section legend{display:flex;align-items:center;gap:8px;font-size:var(--buddy-fs-md)}
.buddy-section legend small{font-weight:400;font-size:var(--buddy-fs-cap);color:var(--buddy-muted)}
.buddy-fields.three{grid-template-columns:repeat(3,minmax(0,1fr))}
.buddy-field{position:relative}
.buddy-inherit-tag{position:relative;z-index:1;align-self:flex-start;margin:0 0 -16px 10px;padding:0 7px;height:18px;line-height:18px;border-radius:999px;font-size:var(--buddy-fs-cap);font-weight:600;background:var(--buddy-accent);color:var(--buddy-on-accent)}
.buddy-mode-inherit textarea:disabled,.buddy-mode-inherit textarea{padding-top:18px;opacity:1;color:var(--buddy-muted);background:color-mix(in srgb,var(--buddy-accent) 5%,var(--buddy-surface))!important;box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--buddy-accent) 40%,var(--buddy-border))!important;outline:1px dashed color-mix(in srgb,var(--buddy-accent) 45%,transparent);outline-offset:-3px}
.buddy-mode-empty textarea{opacity:.55}
.buddy-range-ends{display:flex;justify-content:space-between;font-size:var(--buddy-fs-cap);color:var(--buddy-muted)}
.buddy-sticky-actions{position:sticky;bottom:-20px;z-index:3;margin:18px 0 0;padding:12px 0;justify-content:flex-end;background:var(--buddy-surface);border-top:1px solid var(--buddy-border)}
.buddy-sticky-actions>.buddy-note{margin:0}
.buddy-scope{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:10px 16px;margin:0 0 12px;padding:12px 14px;border-radius:var(--buddy-r-card);background:var(--buddy-surface2);box-shadow:inset 0 0 0 1px var(--buddy-border)}
.buddy-scope small{display:block;font-size:var(--buddy-fs-cap);color:var(--buddy-muted)}
.buddy-scope b{font-size:var(--buddy-fs-md)}
.buddy-scope-source{grid-column:1/-1;display:flex;align-items:center;gap:8px;font-size:var(--buddy-fs-sm);color:var(--buddy-muted)}
.buddy-scope-source select{height:30px;padding:0 8px;font:inherit}
.buddy-scope .buddy-memory-scope{margin:0;padding:0;border:0}
.buddy-scope .buddy-field{min-width:210px}

/* ---- conversation history ---- */
.buddy-history-main{display:flex;flex-direction:column;gap:12px;min-width:0}
.buddy-history-main>.buddy-form-title{margin:0}
.buddy-history-filters{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.buddy-msgs{display:flex;flex-direction:column;gap:14px}
.buddy-dialog .buddy-message,.buddy-group-modal .buddy-message{display:flex;align-items:flex-start;gap:10px;max-width:84%;padding:0;border:0;border-radius:0;background:none}
.buddy-message.me{flex-direction:row-reverse;margin-left:auto}
.buddy-message-main{display:flex;flex-direction:column;gap:4px;min-width:0}
.buddy-message.me .buddy-message-main{align-items:flex-end}
.buddy-message-head{display:flex;align-items:baseline;gap:8px;font-size:var(--buddy-fs-cap);color:var(--buddy-muted)}
.buddy-message.me .buddy-message-head{flex-direction:row-reverse}
.buddy-message-head strong{font-size:var(--buddy-fs-sm);color:var(--buddy-text)}
.buddy-message .buddy-message-body{margin:0;padding:9px 12px;border-radius:4px 14px 14px 14px;background:var(--buddy-surface2);box-shadow:inset 0 0 0 1px var(--buddy-border);white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.6}
.buddy-message.me .buddy-message-body{border-radius:14px 4px 14px 14px;background:color-mix(in srgb,var(--buddy-accent) 16%,var(--buddy-surface));box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--buddy-accent) 30%,transparent)}
.buddy-message-actions{display:flex;gap:2px}
.buddy-op{display:inline-flex;align-items:center;gap:4px;height:24px;padding:0 8px;border:0;border-radius:var(--buddy-r-btn-s);background:transparent;color:var(--buddy-muted);font:inherit;font-size:var(--buddy-fs-cap);cursor:pointer}
.buddy-op:hover{background:var(--buddy-surface2);color:var(--buddy-text)}
.buddy-op[aria-pressed=true]{color:var(--buddy-warn)}
.buddy-revisions{font-size:var(--buddy-fs-cap);color:var(--buddy-muted)}
.buddy-revisions summary{cursor:pointer}
.buddy-revisions .ws-tag{margin-right:6px}
.buddy-revisions p{margin:6px 0 0;white-space:pre-wrap}

/* ---- group editor ---- */
.buddy-lock{display:inline-flex;align-items:center;gap:3px}
.buddy-mode-help{margin:10px 0 0;padding:10px 12px;border-radius:var(--buddy-r-btn);background:var(--buddy-surface2);font-size:var(--buddy-fs-sm);line-height:1.7}
.buddy-dialog .buddy-members{display:flex;flex-direction:column;gap:8px}
.buddy-dialog .buddy-member{display:flex;align-items:center;flex-wrap:wrap;gap:12px;padding:8px 12px;border:0;border-radius:var(--buddy-r-card);background:var(--buddy-surface2);box-shadow:inset 0 0 0 1px var(--buddy-border)}
.buddy-member-name{flex:1 1 110px;min-width:0}
.buddy-member-name b{display:block;font-weight:600;overflow-wrap:anywhere}
.buddy-member-name small{font-size:var(--buddy-fs-cap);color:var(--buddy-muted)}
.buddy-member-talk{display:flex;flex-direction:column;gap:5px;flex:0 1 210px;font-size:var(--buddy-fs-cap);color:var(--buddy-muted)}
.buddy-member-talk .buddy-link{margin-left:6px}
.buddy-meter{display:block;height:4px;border-radius:999px;background:var(--buddy-border);overflow:hidden}
.buddy-meter>i{display:block;height:100%;background:var(--buddy-accent)}
.buddy-member-add{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}
.buddy-member-add>button{display:inline-flex;align-items:center;gap:6px;min-height:30px;padding:0 10px 0 4px;border:1px dashed var(--buddy-border);border-radius:999px;background:transparent;color:var(--buddy-muted);box-shadow:none;font:inherit;font-size:var(--buddy-fs-sm);cursor:pointer}
.buddy-member-add>button:hover:not(:disabled){color:var(--buddy-text);border-color:var(--buddy-accent)}

/* ---- memory, growth, life archives ---- */
.buddy-memory-tools{display:flex;align-items:center;gap:8px;margin:0 0 10px}
.buddy-memory-tools>.buddy-searchbox{flex:1}
.buddy-memory-bar{display:flex;align-items:center;flex-wrap:wrap;gap:10px;margin:0 0 12px}
.buddy-capacity{position:relative;font-size:var(--buddy-fs-cap);color:var(--buddy-muted)}
.buddy-capacity>summary{display:inline-flex;align-items:center;gap:4px;list-style:none;cursor:pointer}
.buddy-capacity>summary::-webkit-details-marker{display:none}
.buddy-capacity b{color:var(--buddy-text)}
.buddy-capacity-pop{position:absolute;right:0;top:calc(100% + 6px);z-index:5;width:300px;padding:10px 12px;border-radius:var(--buddy-r-btn);background:var(--buddy-surface);box-shadow:0 16px 36px -16px var(--buddy-shadow),0 0 0 1px var(--buddy-border)}
.buddy-capacity-pop .buddy-note{margin:4px 0}
.buddy-jobs{display:flex;flex-direction:column;gap:8px;margin:0 0 12px}
.buddy-job{display:flex;align-items:center;gap:10px;padding:9px 12px;border-radius:var(--buddy-r-btn);background:color-mix(in srgb,var(--buddy-warn) 12%,var(--buddy-surface));box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--buddy-warn) 40%,transparent)}
.buddy-job>.ui-icon{flex:none;color:var(--buddy-warn)}
.buddy-job.err{background:color-mix(in srgb,var(--buddy-err) 10%,var(--buddy-surface));box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--buddy-err) 40%,transparent)}
.buddy-job.err>.ui-icon{color:var(--buddy-err)}
.buddy-job p{margin:0}
.buddy-life-list.two{grid-template-columns:repeat(2,minmax(0,1fr))}
.buddy-dialog .buddy-life-card{border:0;border-radius:var(--buddy-r-card);background:var(--buddy-surface2);box-shadow:inset 0 0 0 1px var(--buddy-border)}
.buddy-life-card h4{font-size:var(--buddy-fs-sm);color:var(--buddy-muted);font-weight:600}
.buddy-life-meta>span{display:inline-flex;align-items:center}
.buddy-pick2{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin:4px 0 14px}
.buddy-pick{display:flex;flex-direction:column;align-items:flex-start;gap:6px;padding:14px;border:0;border-radius:var(--buddy-r-card);background:var(--buddy-surface2);box-shadow:inset 0 0 0 1px var(--buddy-border);color:var(--buddy-text);font:inherit;text-align:left;cursor:pointer}
.buddy-pick:hover:not(:disabled){box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--buddy-accent) 55%,transparent)}
.buddy-pick[aria-pressed=true]{background:color-mix(in srgb,var(--buddy-accent) 10%,var(--buddy-surface2));box-shadow:inset 0 0 0 2px var(--buddy-accent)}
.buddy-pick b{display:inline-flex;align-items:center;gap:6px;font-size:var(--buddy-fs-md)}
.buddy-pick b>.ui-icon{color:var(--buddy-accent-text)}
.buddy-pick span{font-size:var(--buddy-fs-sm);color:var(--buddy-muted);line-height:1.6}
.buddy-dialog .buddy-life-alert{border:0;border-radius:var(--buddy-r-card);background:color-mix(in srgb,var(--buddy-warn) 9%,var(--buddy-surface));box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--buddy-warn) 40%,transparent)}
.buddy-life-alert h4{display:flex;align-items:center;gap:6px;margin:0 0 6px}
.buddy-life-alert h4>.ui-icon{color:var(--buddy-warn)}
.buddy-life-labels.row{grid-template-columns:minmax(0,1fr) minmax(0,1.4fr) auto;align-items:end;margin:0 0 6px}
.buddy-life-heading img{width:44px;height:44px;border-radius:50%;object-fit:cover;box-shadow:inset 0 0 0 1px var(--buddy-border)}
.buddy-life-acts{margin:10px 0 0}
.buddy-life-more{position:relative}
.buddy-life-more>.ui-menu{left:0;top:calc(100% + 4px)}
.buddy-danger-zone{display:flex;align-items:center;flex-wrap:wrap;gap:12px;margin-top:22px;padding:14px 16px;border-radius:var(--buddy-r-card);background:color-mix(in srgb,var(--buddy-err) 7%,var(--buddy-surface));box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--buddy-err) 35%,transparent)}
.buddy-danger-zone b{color:var(--buddy-err)}
.buddy-danger-zone .buddy-note{margin:2px 0 0}
.buddy-danger-zone select{height:32px;padding:0 8px;font:inherit}
.buddy-danger{color:var(--buddy-err)!important;box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--buddy-err) 45%,transparent)!important}

/* ---- group header (same frame as the private top bar) ---- */
.gx-top.buddy-group-top .gx-title{max-width:min(380px,40vw)}
.gx-top.buddy-group-top .gx-title>span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;opacity:1;font-size:inherit}
.buddy-group-top .gx-tools{position:relative}
.buddy-group-top .gx-tb.buddy-cg-chip[data-active=true]::after{content:"";position:absolute;top:6px;right:6px;width:6px;height:6px;border-radius:50%;background:var(--buddy-accent)}
.buddy-group-top .gx-tb.buddy-cg-chip[data-status=failed]>.ui-icon{color:var(--buddy-err)}
.buddy-group-top .gx-tb:disabled{opacity:.45;cursor:default}
.buddy-group-stage-controls{display:inline-flex;align-items:center;gap:6px;margin-left:6px;min-width:0;font-size:var(--buddy-fs-sm)}
.buddy-group-stage-controls:empty{display:none}
.buddy-group-stage-controls .buddy-viewing{max-width:220px;padding:0 10px;height:26px;line-height:26px;border-radius:999px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;background:color-mix(in srgb,var(--buddy-accent) 20%,transparent);color:var(--buddy-dlg-text)}
.buddy-group-stage-controls .whg-btn{height:26px;padding:0 10px;border:0;border-radius:999px;background:color-mix(in srgb,var(--buddy-dlg-text) 10%,transparent);color:var(--buddy-dlg-text);font:inherit;font-size:var(--buddy-fs-sm);cursor:pointer}
.buddy-group-top>.buddy-error{margin:0;font-size:var(--buddy-fs-sm)}

/* ---- group stage: speaker pill, roster ---- */
.buddy-stage-names span{color:var(--buddy-dlg-text)}
.buddy-stage-names span[data-speaker=true]{max-width:max-content;margin:0 auto;padding:2px 12px;border-radius:999px;background:var(--plate-bg,var(--buddy-accent));color:var(--plate-text,var(--buddy-on-accent));font-weight:700;text-shadow:none}
.buddy-roster{gap:6px;padding:10px;border:0;border-radius:var(--buddy-r-card);background:color-mix(in srgb,var(--buddy-dlg-bg) 82%,transparent);box-shadow:inset 0 0 0 1px var(--buddy-dlg-border);color:var(--buddy-dlg-text);-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px)}
.buddy-roster>strong{font-size:var(--buddy-fs-sm)}
.buddy-roster>strong small{display:inline;margin-left:4px;color:var(--buddy-dlg-muted);font-weight:400}
.buddy-roster .buddy-roster-entry{gap:8px;border:0;border-radius:10px;background:transparent;color:var(--buddy-dlg-text);box-shadow:none}
.buddy-roster .buddy-roster-entry:hover{background:color-mix(in srgb,var(--buddy-dlg-text) 8%,transparent)}
.buddy-roster .buddy-roster-entry[data-speaking=true]{background:color-mix(in srgb,var(--buddy-accent) 20%,transparent);box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--buddy-accent) 50%,transparent)}
.buddy-roster-entry small{display:block;color:var(--buddy-dlg-muted);font-size:var(--buddy-fs-cap)}

/* ---- group dialogue: in-flow actions reserve space above the text ---- */
.gx-dlg.buddy-group-panel{position:relative}
.gx-dlg.buddy-group-panel .buddy-group-meta{position:static;display:flex;justify-content:flex-end;flex-wrap:wrap;flex:none;min-width:0;gap:6px;margin:0}
.buddy-group-hint{margin:0;font-size:var(--buddy-fs-sm);color:var(--buddy-dlg-muted)}
.buddy-round{display:flex;align-items:center;flex-wrap:wrap;gap:8px;padding:7px 8px 7px 12px;border-radius:10px;background:color-mix(in srgb,var(--buddy-dlg-text) 6%,transparent);box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--buddy-dlg-text) 10%,transparent);font-size:var(--buddy-fs-sm);color:var(--buddy-dlg-text)}
.buddy-round-k{font-size:var(--buddy-fs-cap);font-weight:700;letter-spacing:.04em;color:var(--buddy-dlg-muted)}
.buddy-round-steps{display:flex;align-items:center;flex-wrap:wrap;gap:6px;min-width:0}
.buddy-turn{display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 10px 0 3px;border-radius:999px;background:color-mix(in srgb,var(--buddy-dlg-text) 8%,transparent);color:var(--buddy-dlg-muted);white-space:nowrap}
.buddy-turn.done{color:var(--buddy-dlg-text)}
.buddy-turn.done>.ui-icon{color:var(--buddy-ok)}
.buddy-turn.next{color:var(--buddy-dlg-text);box-shadow:inset 0 0 0 1px var(--buddy-accent)}
.buddy-turn.busy{padding-left:8px;color:var(--buddy-dlg-text);box-shadow:inset 0 0 0 1px var(--buddy-accent)}
.buddy-turn.fail{color:var(--buddy-err);box-shadow:inset 0 0 0 1px var(--buddy-err)}
.buddy-turn .buddy-face{box-shadow:none}
.buddy-round-arrow{color:var(--buddy-dlg-muted)}
.buddy-round-end{font-size:var(--buddy-fs-sm);color:var(--buddy-dlg-muted)}
.buddy-round .buddy-muted{font-size:var(--buddy-fs-sm);color:var(--buddy-dlg-muted)}
.buddy-group-panel .gx-ta .whg-input{min-height:44px}
.buddy-mention-menu{border:0;border-radius:12px;background:var(--buddy-surface);color:var(--buddy-text);box-shadow:0 16px 40px -16px var(--buddy-shadow),0 0 0 1px var(--buddy-border);font:var(--buddy-fs-body)/1.4 var(--buddy-f-ui)}
.buddy-mention-menu button[aria-selected=true]{background:color-mix(in srgb,var(--buddy-accent) 16%,transparent)}
.buddy-mention-menu img,.buddy-mention-initial{width:28px;height:28px;border-radius:50%;object-fit:cover;background:var(--buddy-surface2)}

/* ---- group dialogs: × in the title bar, actions at the bottom ---- */
.buddy-dialog.buddy-group-modal{display:flex;flex-direction:column;width:min(600px,calc(100vw - 32px));height:fit-content;min-height:0;max-height:calc(100dvh - 32px);margin:auto;padding:0;overflow:hidden}
.buddy-dialog.buddy-group-modal.buddy-group-small{width:min(460px,calc(100vw - 32px))}
.buddy-dialog.buddy-group-modal.buddy-group-wide{width:min(880px,calc(100vw - 32px))}
.buddy-dialog.buddy-group-modal.buddy-group-photo{width:min(660px,calc(100vw - 32px))}
.buddy-group-modal>header{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 16px 14px 20px;border-bottom:1px solid var(--buddy-border)}
.buddy-group-modal>header h2{margin:0;font-size:var(--buddy-fs-lg);overflow-wrap:anywhere}
.buddy-group-modal>.buddy-group-modal-body{display:flex;flex-direction:column;gap:12px;flex:1 1 auto;min-height:0;padding:16px 20px;overflow:auto;overscroll-behavior:contain}
.buddy-group-modal-body>.buddy-note,.buddy-group-modal-body>p{margin:0}
.buddy-group-modal-foot{display:flex;align-items:center;flex-wrap:wrap;gap:8px;padding:12px 20px;border-top:1px solid var(--buddy-border);background:color-mix(in srgb,var(--buddy-bg) 25%,var(--buddy-surface))}
.buddy-group-modal-foot>.buddy-note{margin:0;display:inline-flex;align-items:center;gap:6px}
.buddy-group-modal .buddy-group-input{box-sizing:border-box;width:100%;height:34px;padding:0 10px;font:inherit}
.buddy-count-row{display:flex;justify-content:space-between;gap:12px;font-size:var(--buddy-fs-cap);color:var(--buddy-muted)}
.buddy-group-member-list{display:flex;flex-direction:column;gap:8px}
.buddy-group-member-row,.buddy-group-route{display:flex;align-items:center;gap:12px;margin:0;padding:8px 12px;border:0;border-radius:var(--buddy-r-card);background:var(--buddy-surface2);box-shadow:inset 0 0 0 1px var(--buddy-border)}
.buddy-group-member-row.now,.buddy-group-route.now{box-shadow:inset 0 0 0 1px var(--buddy-accent);background:color-mix(in srgb,var(--buddy-accent) 9%,var(--buddy-surface2))}
.buddy-group-member-row>div{flex:1;min-width:0}
.buddy-group-member-row strong,.buddy-group-route strong{display:flex;align-items:center;gap:6px;font-weight:600}
.buddy-group-member-row small,.buddy-group-route small{display:block;margin-top:2px;font-size:var(--buddy-fs-cap);color:var(--buddy-muted);overflow-wrap:anywhere}
.buddy-group-thumb{flex:none;width:40px;height:48px;border-radius:9px;object-fit:cover;object-position:top;background:var(--buddy-bg)}
.buddy-group-route>select.buddy-group-input{flex:0 1 250px;width:auto;min-width:150px}
.buddy-group-bg-preview{position:relative}
.buddy-group-bg-preview>img{display:block;width:100%;height:190px;object-fit:cover;border-radius:var(--buddy-r-card);margin:0}
.buddy-group-bg-preview>.ws-tag{position:absolute;left:10px;top:10px}
.buddy-group-bg-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px}
.buddy-group-bg-card{display:flex;flex-direction:column;padding:0!important;border:0;border-radius:12px;overflow:hidden;background:var(--buddy-surface2);box-shadow:inset 0 0 0 1px var(--buddy-border);color:var(--buddy-text);font:inherit;text-align:left;cursor:pointer}
.buddy-group-bg-card>i{display:block;aspect-ratio:16/9;background:var(--buddy-bg) center/cover no-repeat}
.buddy-group-bg-card>b{padding:7px 10px;font-size:var(--buddy-fs-sm);font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.buddy-group-bg-card[aria-checked=true]{box-shadow:0 0 0 2px var(--buddy-accent)}
.buddy-group-history-tools{display:flex;align-items:center;gap:10px}
.buddy-group-history-tools>.buddy-searchbox{flex:1}
.buddy-group-history-list{max-height:min(52dvh,460px);overflow:auto;margin:0;padding:2px 4px 2px 0}
.buddy-group-history-list .buddy-message:not(.me) strong{color:color-mix(in srgb,var(--plate-bg,var(--buddy-accent-text)) 62%,var(--buddy-text))}

/* ---- group CG gallery ---- */
.buddy-group-cg-tools{color:var(--buddy-muted)}
.buddy-group-cg-grid{grid-template-columns:repeat(auto-fill,minmax(210px,1fr));margin-top:4px}
.buddy-dialog .buddy-group-cg-card{gap:4px;padding:0 0 10px!important;border:0;border-radius:var(--buddy-r-card);overflow:hidden;background:var(--buddy-surface2);box-shadow:inset 0 0 0 1px var(--buddy-border);color:var(--buddy-text)}
.buddy-dialog .buddy-group-cg-card[aria-pressed=true]{outline:0;box-shadow:0 0 0 2px var(--buddy-accent)}
.buddy-group-cg-card>strong,.buddy-group-cg-card>small{padding:0 10px}
.buddy-group-cg-card>small{color:var(--buddy-muted);opacity:1}
.buddy-group-cg-thumb{position:relative;border-radius:0;background:color-mix(in srgb,var(--buddy-bg) 70%,var(--buddy-surface2));color:var(--buddy-muted)}
.buddy-group-cg-thumb>.ws-tag{position:absolute;left:8px;top:8px}
.buddy-group-cg-thumb[data-status=ready]>.ws-tag{color:var(--buddy-ok)}
.buddy-group-cg-wait{display:flex;flex-direction:column;align-items:center;gap:6px;font-size:var(--buddy-fs-sm)}
.buddy-group-cg-thumb[data-status=failed] .buddy-group-cg-wait{color:var(--buddy-err)}
.buddy-group-cg-detail{border-top:1px solid var(--buddy-border)}
.buddy-group-modal .buddy-empty{display:flex;flex-direction:column;align-items:center;gap:6px}
.buddy-group-modal .buddy-empty p{margin:0}

/* ---- group photo: cast chips and the two-step pipeline ---- */
.buddy-photo-count{font-size:var(--buddy-fs-sm)}
.buddy-photo-parts{display:flex;flex-wrap:wrap;gap:6px}
.buddy-photo-parts>button{display:inline-flex;align-items:center;gap:6px;min-height:32px;padding:0 10px 0 4px;border:0;border-radius:999px;background:var(--buddy-surface2);color:var(--buddy-muted);box-shadow:inset 0 0 0 1px var(--buddy-border);font:inherit;font-size:var(--buddy-fs-sm);cursor:pointer}
.buddy-photo-parts>button[aria-pressed=true]{color:var(--buddy-text);background:color-mix(in srgb,var(--buddy-accent) 12%,var(--buddy-surface2));box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--buddy-accent) 55%,transparent)}
.buddy-photo-parts>button>.ui-icon{color:var(--buddy-accent-text)}
.buddy-group-modal .buddy-subhead{margin:4px 0 0!important}
.buddy-pipe{display:flex;flex-direction:column;gap:10px;margin:0}
.buddy-pipe-steps{display:grid;grid-template-columns:minmax(0,1.35fr) auto minmax(0,1fr);align-items:stretch;gap:6px}
.buddy-pipe-arrow{display:grid;place-items:center;color:var(--buddy-muted)}
.buddy-pipe-arrow>svg{transform:rotate(-90deg)}
.buddy-step{display:flex;flex-direction:column;gap:8px;min-width:0;padding:12px;border-radius:var(--buddy-r-card);background:var(--buddy-surface2);box-shadow:inset 0 0 0 1px var(--buddy-border)}
.buddy-step.on{box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--buddy-accent) 50%,transparent)}
.buddy-step.err{box-shadow:inset 0 0 0 1px var(--buddy-err)}
.buddy-step-h{display:flex;align-items:center;flex-wrap:wrap;gap:6px;font-size:var(--buddy-fs-sm);font-weight:600}
.buddy-step-h>b{display:inline-grid;place-items:center;width:20px;height:20px;border-radius:50%;background:var(--buddy-accent);color:var(--buddy-on-accent);font-size:var(--buddy-fs-cap)}
.buddy-step:not(.on) .buddy-step-h>b{background:var(--buddy-border);color:var(--buddy-text)}
.buddy-step-h>small{font-weight:400;font-size:var(--buddy-fs-cap);color:var(--buddy-muted)}
.buddy-step select{box-sizing:border-box;width:100%;height:34px;padding:0 8px;border:0;border-radius:var(--buddy-r-btn);background:color-mix(in srgb,var(--buddy-bg) 45%,var(--buddy-surface));box-shadow:inset 0 0 0 1px var(--buddy-border);color:var(--buddy-text);font:inherit}
.buddy-step select[aria-invalid=true]{box-shadow:inset 0 0 0 1px var(--buddy-err)}
.buddy-step .buddy-note{margin:0}
.buddy-step .buddy-error{display:flex;align-items:flex-start;gap:4px;margin:0;font-size:var(--buddy-fs-cap)}
.buddy-step .buddy-link{align-self:flex-start}
.buddy-pipe .gx-alert{color:var(--buddy-text)}
.buddy-pipe .gx-alert .gx-gbtn{color:var(--buddy-text);background:color-mix(in srgb,var(--buddy-text) 10%,transparent)}
.buddy-pipe-fix{justify-content:flex-end;margin:0}
.buddy-group-photo .gx-alert{color:var(--buddy-text)}

@media(max-width:820px){.buddy-columns.buddy-history{grid-template-columns:230px minmax(0,1fr)}.buddy-fields.three{grid-template-columns:1fr 1fr}.buddy-life-list.two,.buddy-pick2{grid-template-columns:1fr}.buddy-pipe-steps{grid-template-columns:1fr}.buddy-pipe-arrow>svg{transform:none}}
@media(max-width:700px){.buddy-columns.buddy-history{grid-template-columns:1fr}.buddy-fields.three,.buddy-life-labels.row{grid-template-columns:1fr}.buddy-jump{position:static}.buddy-dialog .buddy-message{max-width:100%}}
`;
