import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {THEMES,LIGHT_THEMES,themeVariables,chromeColor,chromeSymbolColor,windowBackground,resolvedTheme,themeScheme} from '../src/appearance.mjs';
import {THEME_PALETTES} from '../src/theme-palettes.mjs';
import {plateVars,contrast,readableOn} from '../src/plate-colors.mjs';

const hex=v=>/^#[0-9a-f]{6}$/i.test(v);
const mix=(a,b,p)=>'#'+[1,3,5].map(i=>Math.round(parseInt(a.slice(i,i+2),16)*p+parseInt(b.slice(i,i+2),16)*(1-p)).toString(16).padStart(2,'0')).join('');

test('eleven approved themes: six light, five dark, each with a complete palette',()=>{
 assert.equal(THEME_PALETTES.length,11);
 assert.deepEqual([...LIGHT_THEMES].sort(),['chatgpt','claude','hunyuan','minimax','qwen','seed']);
 const keys=Object.keys(THEME_PALETTES[0].colors);
 for(const p of THEME_PALETTES){
  assert.deepEqual(Object.keys(p.colors),keys,p.id);
  for(const [k,v] of Object.entries(p.colors))if(k!=='dlgBorder')assert.ok(hex(v),p.id+' '+k+' '+v);
  assert.equal(themeScheme(p.id),p.mode);assert.ok(THEMES[p.id]);
 }
});

test('every palette passes the design contrast checks',()=>{
 for(const {id,colors:c} of THEME_PALETTES){
  const checks=[[c.text,c.bg,4.5],[c.text,c.surface,4.5],[c.muted,c.surface,4.5],[c.muted,c.bg,4.5],[c.accentText,c.surface,4.5],[c.accentText,mix(c.accent,c.surface,.12),4.5],[c.onAccent,c.accent,4.5],[c.accent,c.surface,3],
   [c.sideText,c.sideBg,4.5],[c.sideMuted,c.sideBg,4.5],[c.sideAccent,c.sideActive,4.5],[c.ok,mix(c.ok,c.surface,.14),4.5],[c.ok,c.bg,4.5],[c.warn,mix(c.warn,c.surface,.14),4.5],[c.err,mix(c.err,c.surface,.14),4.5],
   [c.dlgText,c.dlgBg,4.5],[c.dlgMuted,c.dlgBg,4.5],[c.dlgMuted,mix(c.dlgText,c.dlgBg,.06),4.5],[c.dlgText,c.choiceBg,4.5],[c.plateText,c.plateBg,4.5]];
  checks.forEach(([fg,bg,need],i)=>assert.ok(contrast(fg,bg)>=need,`${id} check ${i}: ${fg} on ${bg} = ${contrast(fg,bg).toFixed(2)}`));
 }
});

test('window chrome follows the palette and its caption buttons stay readable',()=>{
 for(const {id,colors:c} of THEME_PALETTES){
  assert.equal(chromeColor(id),c.chrome);assert.equal(windowBackground(id),c.bg);
  assert.ok(contrast(chromeSymbolColor(id),chromeColor(id))>=4.5,id);
 }
 assert.equal(chromeColor('missing'),chromeColor('deepseek'));
});

test('theme variables keep the older --buddy-* names readable on every ground',()=>{
 for(const id of Object.keys(THEMES)){
  const v=themeVariables(id);
  for(const name of ['bg','sidebar','surface','raised','border','accent','secondary','text','muted','on-accent','success','warning','danger','scrim','shadow','scheme'])assert.ok(v['--buddy-'+name],id+' '+name);
  for(const ground of ['bg','surface','raised'])for(const ink of ['text','muted'])assert.ok(contrast(v['--buddy-'+ink],v['--buddy-'+ground])>=4.5,`${id} ${ink} on ${ground}`);
  // the sidebar has its own inks (Hunyuan: dark cloak beside a light page)
  for(const ink of ['side-text','side-muted'])assert.ok(contrast(v['--buddy-'+ink],v['--buddy-sidebar'])>=4.5,`${id} ${ink} on sidebar`);
  assert.match(v['--buddy-r-card'],/^\d+px$/);assert.ok(v['--buddy-f-head']);
 }
 assert.equal(themeVariables('kimi')['--buddy-prism'].startsWith('linear-gradient'),true);
 assert.equal(resolvedTheme({themeMode:'character'},'claude'),'claude');
});

test('name plates: own colours for built-ins, readable text for custom colours',()=>{
 for(const {id,colors:c} of THEME_PALETTES)assert.deepEqual(plateVars({who:'character',characterId:id}),{'--plate-bg':c.plateBg,'--plate-text':c.plateText});
 for(const color of ['#ffd400','#123456','#7fd0ff','#ff9cc8','#202020','#f0f0f0']){const v=plateVars({characterId:'custom-x',color});assert.ok(contrast(v['--plate-text'],color)>=4.5,color);}
 assert.equal(readableOn('#000000'),'#FFFFFF');
 assert.equal(plateVars({who:'user'})['--plate-bg'],'var(--buddy-accent)');
 assert.deepEqual(plateVars({characterId:'custom-x',color:'not-a-colour'}),{});
});

test('generated palette module and CSS tokens match the design source',()=>{
 const script=fileURLToPath(new URL('../scripts/extract-theme-palettes.mjs',import.meta.url));
 const run=spawnSync(process.execPath,[script,'--check'],{encoding:'utf8'});
 assert.equal(run.status,0,run.stderr||run.stdout);
});
