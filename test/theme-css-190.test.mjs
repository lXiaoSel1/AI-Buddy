import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {themeVariables} from '../src/appearance.mjs';
import {THEME_PALETTES} from '../src/theme-palettes.mjs';

const read=path=>readFileSync(new URL('../'+path,import.meta.url),'utf8');
const sources=[...readdirSync(new URL('../src/',import.meta.url)).filter(name=>/\.(css|mjs|html)$/.test(name)).map(name=>'src/'+name),'src/adapted/galgame-client.ts'];
const withoutGenerated=text=>text.replace(/\/\* @generated theme-tokens[\s\S]*?@end theme-tokens \*\//,'');

test('the tone switch is gone: every theme, DeepSeek included, takes its palette from data-theme',()=>{
 for(const path of sources){const text=read(path);assert.doesNotMatch(text,/data-tone|dataset\.tone/,path);}
 const css=read('src/appearance.css');
 for(const {id} of THEME_PALETTES)if(id!=='deepseek')assert.match(css,new RegExp('html\\[data-theme="'+id+'"\\]\\{'),id);
 assert.match(css,/:root\{[^}]*--buddy-bg:#/);
});

test('every var(--x) without a fallback is defined somewhere',()=>{
 const used=new Map(),defined=new Set([...Object.keys(themeVariables('kimi')),...Object.keys(themeVariables('gemini'))]);
 for(const path of sources){
  const text=read(path);
  for(const match of text.matchAll(/var\(\s*(--[\w-]+)\s*(,)?/g))if(!match[2])used.set(match[1],path);
  for(const match of text.matchAll(/(--[\w-]+)\s*:/g))defined.add(match[1]);
  for(const match of text.matchAll(/['"](--[\w-]+)['"]\s*[:,)]/g))defined.add(match[1]);
 }
 assert.deepEqual([...used].filter(([name])=>!defined.has(name)),[]);
});

// Ceilings only go down. What is left is mostly black shadows, the plate fallbacks and a few
// per-theme ornament tints in workspace.css (Grok gold, Seed blue, Gemini pinks). The CG viewer stays
// near-black in every theme on purpose, so the picture's own colours read true.
const CEILINGS={
 'src/dashboard.css':1,'src/appearance.css':6,'src/workspace.css':27,'src/adapted/galgame-client.ts':24,'src/galgame-design.mjs':12,'src/companion-ui.mjs':3,'src/companion-life-ui.mjs':0,
 'src/group-stage-ui.mjs':2,'src/group-header.mjs':0,'src/companion-design.mjs':0,'src/group-cg-ui.mjs':0,'src/cg-image-viewer.mjs':13,'src/pet.html':0,'src/pet-trajectory.mjs':0,
};
test('hard-coded colours stay under each file\'s ceiling',()=>{
 const literal=/#[0-9a-fA-F]{8}\b|#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3,4}\b|rgba?\(/g;
 for(const [path,ceiling] of Object.entries(CEILINGS)){
  const count=(withoutGenerated(read(path)).match(literal)||[]).length;
  assert.ok(count<=ceiling,`${path}: ${count} colour literals, ceiling ${ceiling}`);
 }
});

test('shared controls never use <dialog>, so an open toast or menu cannot hold back replies',()=>{
 assert.doesNotMatch(read('src/ui-controls.mjs'),/['"]dialog['"]/);
 assert.doesNotMatch(read('src/appearance.css'),/dialog\.ui-|\.ui-[\w-]+\s*dialog/);
});
