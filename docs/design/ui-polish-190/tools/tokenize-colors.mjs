// One-off B0 sweep: replace hard-coded colours in CSS with the nearest theme token.
// The old UI was drawn in DeepSeek's dark blues, so each literal is matched against the
// DeepSeek palette within the token family its CSS property implies (text / ground / line).
// Usage: node tokenize-colors.mjs [--write] <file[:fromLine-toLine]>...   (prints a mapping report)
import {readFileSync,writeFileSync} from 'node:fs';
import {THEME_PALETTES} from '../../../../src/theme-palettes.mjs';

const ds=THEME_PALETTES.find(p=>p.id==='deepseek').colors;
const FAMILY={
 text:['text','muted','accentText','ok','warn','err'],
 ground:['bg','surface','surface2','sideBg','choiceBg','accent','ok','warn','err'],
 line:['border','accent','accentText','muted','ok','warn','err'],
};
const TOKEN={text:'text',muted:'muted',accentText:'accent-text',ok:'ok',warn:'warn',err:'err',bg:'bg',surface:'surface',surface2:'surface2',sideBg:'side-bg',choiceBg:'choice-bg',accent:'accent',border:'border',a2:'a2'};
const familyOf=prop=>{
 if(/^(color|fill|stroke|caret-color|-webkit-text-fill-color|text-decoration(-color)?)$/.test(prop))return 'text';
 if(/^(background(-color|-image)?)$/.test(prop))return 'ground';
 if(/^(border(-[a-z]+)*|outline(-color)?|column-rule(-color)?|accent-color)$/.test(prop))return 'line';
 if(/shadow$|^filter$/.test(prop))return 'shadow';
 return null;
};
const hexRgb=h=>{h=h.slice(1);if(h.length<=4)h=[...h].map(c=>c+c).join('');return {rgb:[0,2,4].map(i=>parseInt(h.slice(i,i+2),16)),a:h.length===8?parseInt(h.slice(6,8),16)/255:1};};
const lin=v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;};
const oklab=([r,g,b])=>{[r,g,b]=[r,g,b].map(lin);const l=Math.cbrt(.4122214708*r+.5363325363*g+.0514459929*b),m=Math.cbrt(.2119034982*r+.6806995451*g+.1073969566*b),s=Math.cbrt(.0883024619*r+.2817188376*g+.6299787005*b);return [.2104542553*l+.793617785*m-.0040720468*s,1.9779984951*l-2.428592205*m+.4505937099*s,.0259040371*l+.7827717662*m-.808675766*s];};
const dist=(a,b)=>{const x=oklab(a),y=oklab(b);return Math.hypot(x[0]-y[0],(x[1]-y[1])*1.4,(x[2]-y[2])*1.4);};
const parse=lit=>{let m;if(lit.startsWith('#'))return hexRgb(lit);if((m=/^rgba?\(\s*(\d+)[ ,]+(\d+)[ ,]+(\d+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/i.exec(lit)))return {rgb:[+m[1],+m[2],+m[3]],a:m[4]===undefined?1:m[4].endsWith('%')?parseFloat(m[4])/100:+m[4]};return null;};
const pct=a=>Math.round(a*100);
const report=new Map();
const hsl=([r,g,b])=>{r/=255;g/=255;b/=255;const max=Math.max(r,g,b),min=Math.min(r,g,b),l=(max+min)/2,d=max-min;if(!d)return [0,0,l];const s=d/(1-Math.abs(2*l-1));let h=max===r?((g-b)/d)%6:max===g?(b-r)/d+2:(r-g)/d+4;return [(h*60+360)%360,s,l];};
// Saturated colours are classified by hue (status colours keep their meaning, blues/purples become the accent);
// dark or greyish colours are neutral and take the nearest neutral token of the family.
function chromatic(family,[h,s,l]){
 if(family==='ground'&&l<.32)return null;if(family==='line'&&l<.3)return null;
 if(s<(family==='text'?.45:.3)||l<.15||l>.94)return null;
 if(h>=345||h<20)return 'err';
 // Brass/gold was decoration in the old UI: the theme's second colour for lines and fills, accent text for words.
 if(h<66)return family==='text'?(s>.75&&l<.65?'warn':'accentText'):s>.85&&l<.62?'warn':'a2';
 if(h>=75&&h<170)return 'ok';
 return family==='text'?'accentText':family==='line'&&l>.6?'accentText':'accent';
}
function neutral(family,c,[,,l]){
 if(family==='text')return l>=.8||l<.35?'text':'muted';
 if(family==='line')return l<.45?'border':'muted';
 if(l>.75)return 'surface';
 return ['bg','surface','surface2','sideBg','choiceBg'].map(k=>[k,dist(c.rgb,hexRgb(ds[k]).rgb)]).sort((x,y)=>x[1]-y[1])[0][0];
}
function token(lit,family,onAccent=false){
 const c=parse(lit);if(!c)return null;
 const [r,g,b]=c.rgb,lum=.2126*lin(r)+.7152*lin(g)+.0722*lin(b),shade=hsl(c.rgb);
 // Black stays black (shadows and scrims read on both schemes); coloured glows follow the line colours.
 if(family==='shadow'){if(lum<.02)return null;family='line';}
 if(r===g&&g===b&&r<=8)return null;
 let key;
 if(r===g&&g===b&&r>=245&&c.a<1)key='text';
 else if(family==='text'&&onAccent&&shade[2]>.85)key='onAccent';
 else key=chromatic(family,shade)??neutral(family,c,shade);
 const name=key==='onAccent'?'on-accent':TOKEN[key],v=`var(--buddy-${name})`,out=c.a<1?`color-mix(in srgb,${v} ${pct(c.a)}%,transparent)`:v;
 const k=family+' '+lit.toLowerCase()+' → '+out;report.set(k,(report.get(k)||0)+1);return out;
}
const COLOR=/#[0-9a-f]{8}\b|#[0-9a-f]{6}\b|#[0-9a-f]{3,4}\b|rgba?\([^)]*\)/gi;
const DECL=/(^|[{;\s'"`])(-?-?[a-z][a-z-]*)\s*:\s*([^;{}'"`]+)/gi;
function sweepBody(body){
 // A rule whose background becomes the accent keeps its light text readable on it.
 let onAccent=false;
 body.replace(DECL,(all,pre,prop,value)=>{if(familyOf(prop.toLowerCase())==='ground'){const lits=value.replace(/url\([^)]*\)/g,'').match(COLOR)||[];if(lits.some(lit=>{const c=parse(lit);return c&&c.a>.6&&chromatic('ground',hsl(c.rgb))==='accent';}))onAccent=true;}return all;});
 return body.replace(DECL,(all,pre,prop,value)=>{
  if(prop.startsWith('--')||prop==='content')return all;const family=familyOf(prop.toLowerCase());if(!family)return all;
  // leave url(...) payloads (inline SVG) untouched
  const parts=value.split(/(url\([^)]*\))/);
  const next=parts.map(p=>p.startsWith('url(')?p:p.replace(COLOR,lit=>token(lit,family,onAccent)??lit)).join('');
  return pre+prop+':'+next.replace(/^\s+/,'');
 });
}
const sweepCss=css=>css.replace(/\{([^{}]*)\}/g,(all,body)=>'{'+sweepBody(body)+'}');
const write=process.argv.includes('--write');
for(const spec of process.argv.slice(2).filter(a=>!a.startsWith('--'))){
 const [file,range]=spec.split(/:(?=\d+-\d+$)/),text=readFileSync(file,'utf8'),eol=text.includes('\r\n')?'\r\n':'\n',lines=text.split(eol);
 const [from,to]=range?range.split('-').map(Number):[1,lines.length];
 for(let i=from-1;i<Math.min(to,lines.length);i++)lines[i]=sweepCss(lines[i]);
 const out=lines.join(eol);if(write&&out!==text)writeFileSync(file,out);console.error((out===text?'unchanged ':'swept ')+spec);
}
const rows=[...report].sort((a,b)=>b[1]-a[1]);
console.log('| 场合 | 原颜色 → 主题变量 | 次数 |\n|---|---|---|');
for(const [k,n] of rows){const [fam,rest]=[k.slice(0,k.indexOf(' ')),k.slice(k.indexOf(' ')+1)];console.log(`| ${fam} | \`${rest.replace(' → ','` → `')}\` | ${n} |`);}
