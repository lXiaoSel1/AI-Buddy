// Screenshot individual surface cards of ui-design.html the way the artifact host serves it (doctype skeleton).
// usage: node snap.mjs <theme> <id,id,...|sN> [outdir]
import {readFileSync, writeFileSync, mkdirSync} from 'node:fs';
import {join} from 'node:path';
const {chromium} = await import('file:///C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs');
const root = import.meta.dirname;
const [theme = 'deepseek', which = 's2', out = join(root, 'snaps')] = process.argv.slice(2);
mkdirSync(out, {recursive: true});
const page_html = readFileSync(join(root, 'ui-design.html'), 'utf8');
writeFileSync(join(root, 'preview.html'), '<!doctype html><html><head><meta charset=utf8><meta name=viewport content="width=device-width,initial-scale=1,viewport-fit=cover"><style>*,*::before,*::after{box-sizing:border-box}html,body{margin:0}</style></head><body>' + page_html + '</body></html>');
const browser = await chromium.launch({executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', args: ['--hide-scrollbars']});
const page = await browser.newPage({viewport: {width: 1440, height: 1000}, deviceScaleFactor: 1});
const errors = [];
page.on('pageerror', e => errors.push(e.message));
await page.addInitScript(t => { try { localStorage.setItem('aibuddy-ui-design-r1-theme', t); } catch (e) {} }, theme);
await page.goto('file:///' + join(root, 'preview.html').replace(/\\/g, '/'));
await page.waitForTimeout(800);
const ids = which.startsWith('s') && !which.includes('-')
  ? await page.$$eval(`article.sfc[id^="${which}-"]`, els => els.map(e => e.id))
  : which.split(',').map(s => s.includes('-') ? s : 's' + s.replace('.', '-'));
for (const id of ids) {
  const el = await page.$('#' + id);
  if (!el) { console.log('missing', id); continue; }
  await el.scrollIntoViewIfNeeded();
  await page.waitForTimeout(150);
  await el.screenshot({path: join(out, `${theme}-${id}.png`)});
}
console.log('shots', ids.length, 'errors', errors.length ? errors : 'none');
await browser.close();
