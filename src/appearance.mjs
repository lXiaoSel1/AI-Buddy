// Theme palettes come from the approved per-portrait design (src/theme-palettes.mjs).
// Every colour key is exposed as --buddy-<kebab-name>; older --buddy-* names stay as aliases.
import {THEME_PALETTES} from './theme-palettes.mjs';

const PALETTES=Object.fromEntries(THEME_PALETTES.map(p=>[p.id,p]));
const palette=id=>PALETTES[id]||PALETTES.deepseek;
const kebab=key=>'--buddy-'+key.replace(/[A-Z]/g,m=>'-'+m.toLowerCase());
export const THEMES=Object.freeze(Object.fromEntries(THEME_PALETTES.map(p=>[p.id,Object.freeze({name:p.name,...(p.nameEn?{nameEn:p.nameEn}:{}),mode:p.mode,background:p.colors.bg,accent:p.colors.accent,secondary:p.colors.a2})])));
export const LIGHT_THEMES=Object.freeze(THEME_PALETTES.filter(p=>p.mode==='light').map(p=>p.id));
export function resolvedTheme(preferences={},character='deepseek'){return preferences.themeMode==='character'&&THEMES[character]?character:THEMES[preferences.theme]?preferences.theme:'deepseek';}
export const themePalette=id=>palette(id);
export const themeScheme=id=>palette(id).mode;
export const chromeColor=id=>palette(id).colors.chrome;
// Caption buttons drawn by Windows over the title bar: dark on the light themes.
export const chromeSymbolColor=id=>palette(id).colors.sideText;
export const windowBackground=id=>palette(id).colors.bg;
export function themeVariables(id='deepseek'){
 const p=palette(id),c=p.colors,light=p.mode==='light',vars={};
 for(const [key,value] of Object.entries(c))vars[kebab(key)]=value;
 Object.assign(vars,{
  '--buddy-sidebar':c.sideBg,'--buddy-raised':c.surface2,'--buddy-secondary':c.a2,'--buddy-success':c.ok,'--buddy-warning':c.warn,'--buddy-danger':c.err,
  '--buddy-scrim':light?'#18253d55':'#02071299','--buddy-shadow':light?'#1a31491c':'#03091245','--buddy-scheme':light?'light':'dark',
  '--buddy-r-card':p.radius.card+'px','--buddy-r-btn':p.radius.btn+'px','--buddy-r-dlg':p.radius.dlg+'px',
  '--buddy-f-head':p.headFont||'var(--buddy-f-ui)','--buddy-acc-w':p.accessorySize[0]+'px','--buddy-acc-h':p.accessorySize[1]+'px','--buddy-bg-position':p.backgroundPosition,
 });
 for(const [key,value] of Object.entries(p.extra))vars[key.replace(/^--/,'--buddy-')]=value;
 return vars;
}
export function applyAppearance(preferences={},character='deepseek'){
 if(typeof document==='undefined')return;
 const id=resolvedTheme(preferences,character),root=document.documentElement,vars=themeVariables(id);
 root.dataset.theme=id;root.dataset.scheme=themeScheme(id);
 for(const name of [...root.style])if(name.startsWith('--buddy-')&&!(name in vars))root.style.removeProperty(name);
 for(const [k,v] of Object.entries(vars))root.style.setProperty(k,v);
}
