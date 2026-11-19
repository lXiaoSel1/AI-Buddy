import React from 'react';

const h = React.createElement;

// Stored scene text may contain similar markers. Only unwrap a complete producer envelope.
const managedPrompt = /^(?<opening>【CG 固定构图要求 v\d+】\r?\n[^\r\n]+\r?\n以下只作为场景与女角色互动素材；[^\r\n]*：\r?\n)(?<scene>[\s\S]*?)(?<closingBreak>\r?\n)(?<closing>【再次确认】[^\r\n]+)$/u;

// The group producer serializes the theme between its cast/context and closing instruction.
const groupThemeLine = /^(Galgame 群聊纪念合影，[^\r\n]*\r?\n本张必须包含以下全部女性角色，[^\r\n]*\r?\n仅以如下已呈现的群聊内容为经历，[^\r\n]*\r?\n主题和场景：)(\{[^\r\n]*\})(?=\r?\n角色身份和服装遵循人物参考，)/u;

function groupSceneForDisplay(scene) {
  return scene.replace(groupThemeLine, (original, prefix, serializedTheme) => {
    let theme;
    try {
      theme = JSON.parse(serializedTheme);
    } catch {
      return original;
    }
    if (theme?.source !== 'local' || typeof theme.fallbackReason !== 'string') return original;
    const { fallbackReason, ...sceneTheme } = theme;
    return prefix + JSON.stringify(sceneTheme);
  });
}

export function cgPromptSections(prompt) {
  if (typeof prompt !== 'string') return { scene: prompt };
  const openings = [], closings = [];
  let scene = prompt;
  let envelope;
  while ((envelope = managedPrompt.exec(scene))) {
    const { opening, scene: innerScene, closingBreak, closing } = envelope.groups;
    openings.push(opening);
    closings.push({ closingBreak, closing });
    scene = innerScene;
  }
  if (!openings.length) return { scene: prompt };

  const confirmations = closings.reverse().map(({ closingBreak, closing }, index) =>
    index === 0 ? closing : closingBreak + closing);
  return { scene: groupSceneForDisplay(scene), rules: openings.join('') + confirmations.join('') };
}

export function GalgameCgDetail({ image, heading, meta, descriptionLabel, descriptions, actions, children }) {
  return h('div', { className: 'gx-cg-detail-paper' },
    h('div', { className: 'gx-cg-detail-image' }, image),
    h('div', { className: 'gx-cg-detail-copy' },
      h('h4', null, heading),
      meta && h('div', { className: 'gx-cg-detail-meta' }, meta),
      descriptions?.length ? h(React.Fragment, null,
        h('hr'),
        h('div', { className: 'gx-cg-detail-meta' }, descriptionLabel),
        h('div', { className: 'gx-cg-detail-description' }, descriptions.map((line, index) => h('p', { key: index }, line)))) : null,
      children,
      actions && h('div', { className: 'gx-cg-detail-actions' }, actions)));
}

export const GalgameCgDetailCSS = `
.gx-redesign .gx-cg-detail-paper{display:grid;grid-template-columns:minmax(0,1.5fr) minmax(0,1fr);align-items:start;gap:18px}
.gx-redesign .gx-cg-detail-image{border:1px solid var(--dlg-border);border-radius:var(--rc);overflow:hidden;position:relative;background:color-mix(in srgb,var(--dlg-text) 5%,transparent)}
.gx-redesign .gx-cg-detail-image .buddy-cg-open{border-radius:0;text-align:start}
.gx-redesign .gx-cg-detail-image .buddy-cg-open:focus-visible{outline-offset:-2px}
.gx-redesign .gx-cg-detail-image .buddy-cg-open>img{aspect-ratio:16/9;max-height:none;object-fit:cover}
.gx-redesign .gx-cg-detail-image .buddy-cg-zoom{display:block;position:static;height:auto;padding:6px 9px;background:none;color:var(--dlg-muted);font:12px/1.5 var(--buddy-f-ui)}
.gx-redesign .gx-cg-detail-image .buddy-cg-zoom svg{display:none}
.gx-redesign .gx-cg-detail-copy h4{margin:0;font:700 18px/1.5 var(--serif);letter-spacing:.15em;color:var(--dlg-text)}
.gx-redesign .gx-cg-detail-copy hr{margin:12px 0;border:0;border-top:1px solid var(--dlg-border)}
.gx-redesign .gx-cg-detail-meta{color:var(--dlg-muted);font-size:12.5px}
.gx-redesign .gx-cg-detail-description{margin-top:4px;border:1px solid var(--dlg-border);border-radius:var(--rc);padding:10px 12px;background:color-mix(in srgb,var(--dlg-text) 4%,transparent);font-size:13px;overflow-wrap:anywhere}
.gx-redesign .gx-cg-detail-description p{margin:0;white-space:pre-wrap}
.gx-redesign .gx-cg-detail-description p+p{margin-top:6px}
.gx-redesign .gx-cg-detail-rules summary{margin-top:8px;cursor:pointer;color:var(--dlg-text);font-size:13px}
.gx-redesign .gx-cg-detail-rules summary:focus-visible{outline:2px solid var(--buddy-accent);outline-offset:2px}
.gx-redesign .gx-cg-detail-actions{display:flex;gap:8px;margin-top:8px;flex-wrap:wrap}
@media(max-width:680px){.gx-redesign .gx-cg-detail-paper{grid-template-columns:minmax(0,1fr)}}
`;
