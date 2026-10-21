// Assemble the design-review page: template + slices reused verbatim from the approved theme preview + inlined images.
import {readFileSync, writeFileSync, readdirSync, existsSync} from 'node:fs';
import {join} from 'node:path';
const root = import.meta.dirname, preview = join(root, '../ai-theme/index.html');
const p = readFileSync(preview, 'utf8');
const between = (a, b, inclA = true) => { const i = p.indexOf(a), j = p.indexOf(b, i + a.length); if (i < 0 || j < 0) throw Error('anchor missing: ' + a + ' / ' + b); return p.slice(inclA ? i : i + a.length, j); };
const slices = {
  '/*@@SLICE_THEMES@@*/': between('/*THEMES-START*/', '/*CONTRAST-END*/') + '/*CONTRAST-END*/',
  '/*@@SLICE_ORN@@*/': between('const svgUrl = s=>', 'const HEAD = {'),
  '/*@@SLICE_HEAD@@*/': between('const HEAD = {', '(function injectThemeCSS(){'),
  '/*@@SLICE_ICON@@*/': between('const ICON = {', 'const face = ') + p.slice(p.indexOf('const CAPTION = `'), p.indexOf('\n', p.indexOf('const CAPTION = `'))) + '\n',
  '/*@@MOCK_CSS@@*/': '/* =========================================================\n' + between('   Recreated AI 酱 UI', '</style>')
};
let s = readFileSync(join(root, 'src.html'), 'utf8');
// per-section parts live in their own files (sec3.css/js, sec4.css/js, ...) and are spliced in at fixed markers
const parts = ext => readdirSync(root).filter(f => /^sec\d+\./.test(f) && f.endsWith(ext)).sort().map(f => readFileSync(join(root, f), 'utf8')).join('\n');
slices['/*@@PART_CSS@@*/'] = parts('.css'); slices['/*@@PART_JS@@*/'] = parts('.js');
for (const [k, v] of Object.entries(slices)) { if (s.split(k).length !== 2) throw Error('placeholder count: ' + k); s = s.replace(k, () => v); }
const assets = {};
const add = (dir, prefix) => { for (const f of readdirSync(dir)) if (f.endsWith('.webp')) assets[prefix + f] = readFileSync(join(dir, f)).toString('base64'); };
add(join(root, '../ai-theme/art'), 'art/');
add(join(root, '../ai-theme/gen/web'), 'gen/web/');
add(join(root, 'extra'), 'extra/');   // app assets the later sections need (group table, member thumbnails)
const used = new Set([...s.matchAll(/\['([a-z0-9-]+)','/g)].map(m => m[1]));   // before-shot names referenced by the surfaces
for (const f of readdirSync(join(root, 'before'))) { const n = f.replace(/\.webp$/, ''); if (used.has(n)) assets['before/' + f] = readFileSync(join(root, 'before', f)).toString('base64'); }
const missing = [...used].filter(n => !existsSync(join(root, 'before', n + '.webp')) && !/^(ok|change|busy)$/.test(n));
s = s.replace('<!--ASSETS-->', () => '<script id="assets" type="application/json">' + JSON.stringify(assets) + '</script>');
writeFileSync(join(root, 'ui-design.html'), s);
console.log('built', Object.keys(assets).length, 'assets', (s.length / 1048576).toFixed(2), 'MB; before-shots missing:', missing.join(', ') || 'none');
