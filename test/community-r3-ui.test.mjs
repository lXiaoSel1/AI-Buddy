import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, rm, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {setLocale} from '../src/i18n.mjs';
import {InstallPage, installStage, engineRows} from '../src/community-install-page.mjs';
import {WorkDetail, AuthorDialog, RatingSummary} from '../src/community-detail.mjs';
import {Markdown} from '../src/community-markdown.mjs';
import {installedSituation, runtimeLabel, maintenanceNote, MaintenanceRow, UpdateCard, checkedLabel} from '../src/community-center.mjs';
import {workText, formatBytes} from '../src/community-capabilities.mjs';
import {PluginCenter, rangeCeiling} from '../src/plugin-center.mjs';
import {detectWorkEngines} from '../src/community/work-engines.mjs';
import {checkSocialAccountDraft} from '../src/community/social-draft-check.mjs';
import {publicWebUrl} from '../src/community/service.mjs';
import {setupCommunity, catalog} from './support/community-fixtures.mjs';

const html = (type, props) => renderToStaticMarkup(React.createElement(type, props)), han = /[㐀-鿿]/, noop = () => {};
const visible = markup => markup.replace(/<[^>]*>/g, ' ');
const official = {sourceId: 'official', name: 'AI Buddy 官方扩展', official: true};
const plan = (packageName, capabilities, extra = {}) => ({planId: 'p', packageBytes: 48213, packageRef: {packageName, exactVersion: '2.0.1', sourceDigest: 'a'.repeat(64), spec: {kind: 'tarball'}}, declaredCapabilities: capabilities, addedCapabilities: capabilities, priorDataSchemaVersion: null, ...extra});
const page = props => html(InstallPage, {work: {packageName: props.plan?.packageRef?.packageName ?? props.packageName, authorName: 'lXiaoSel1'}, source: official, granted: [], onGrant: noop, stage: 'plan', busy: false, ...props});

test('B3 install page: real package size, no raw capability ids in the rows, and each plugin its own next step', () => {
  setLocale('zh-CN');
  const open = page({plan: plan('@ai-buddy/bilibili-companion', ['social.context.read', 'models.request'])});
  assert.match(open, /lXiaoSel1 · 2\.0\.1 · 48 KB/); assert.doesNotMatch(visible(open).replace(/技术详情[\s\S]*$/, ''), /social\.context\.read|models\.request/);
  assert.match(open, /title="social\.context\.read"/); assert.match(open, /能力: social\.context\.read, models\.request/);
  const done = name => page({plan: null, stage: 'installed', record: {packageKey: 'k', grantedCapabilities: [], enabled: false}, packageName: name});
  assert.match(done('@ai-buddy/bilibili-companion'), /启用并连接 B站账号/); assert.match(done('@ai-buddy/qq-connect'), /启用并扫码登录/); assert.match(done('@ai-buddy/qq-connect'), /再选一位替你回复的角色/);
  const work = page({plan: null, stage: 'installed', record: {packageKey: 'k', grantedCapabilities: [], enabled: false}, packageName: '@ai-buddy/work-collaboration', engines: [{engine: 'codex', state: 'signed-in'}, {engine: 'claude', state: 'missing'}, {engine: 'dsh', state: 'needs-connection'}, {engine: 'kimi', version: '1.0.0', state: 'incompatible'}]});
  assert.match(work, /选一个工作引擎/); assert.match(work, /Codex[\s\S]*已登录/); assert.match(work, /Kimi 1\.0\.0[\s\S]*不兼容/); assert.doesNotMatch(work.split('data-work-engines')[1].split('ws-row-btns')[0], /Claude/); assert.match(work, /启用并打开工作窗口/);
  assert.equal(engineRows([{engine: 'kimi', version: '1.0.0', state: 'incompatible'}])[0].tone, 'warn');
  assert.equal(formatBytes(8.7e6), '8.7 MB'); assert.equal(formatBytes(44e3), '44 KB');
});

test('B5 upgrade page lists only the new permissions; what was granted before stays ticked in a fold', () => {
  setLocale('zh-CN');
  const markup = page({plan: plan('@ai-buddy/bilibili-companion', ['social.context.read', 'ui.bubble'], {addedCapabilities: ['ui.bubble'], priorDataSchemaVersion: 1, priorGrantedCapabilities: ['social.context.read']}), granted: ['social.context.read']});
  const [open, kept] = markup.split('ext-kept');
  assert.match(open, /在桌宠上冒气泡/); assert.match(open, /新增/); assert.doesNotMatch(open, /读取她的心情/);
  assert.match(kept, /已授予 1 项，保持不变/); assert.match(kept, /读取她的心情和记忆摘要/); assert.match(kept, /checked=""/);
});

test('A3 / B6: with no catalog listing the plugin, the install page offers the signed file instead of a dead end', () => {
  setLocale('zh-CN'); assert.equal(installStage({plan: null, unavailable: true}), 'unavailable');
  const markup = page({plan: null, stage: 'unavailable', source: null, packageName: '@ai-buddy/work-collaboration', work: {packageName: '@ai-buddy/work-collaboration'}});
  assert.match(markup, /官方目录还没有上线/); assert.match(markup, /从文件安装…/); assert.match(markup, /添加社区目录地址/); assert.match(markup, /几位角色一起做你的项目/);
  setLocale('en'); const english = page({plan: plan('@ai-buddy/work-collaboration', ['work.host']), work: {packageName: '@ai-buddy/work-collaboration', name: '工作与协作', description: '几位角色'}});
  assert.match(english, /<h2[^>]*>Work<\/h2>/); assert.match(english, /Install and grant 0|Tick the permissions/); assert.doesNotMatch(visible(english), han);
  setLocale('zh-CN');
});

test('B2 README is safe Markdown: formatting, no HTML, no images loaded, links only through the host opener', () => {
  const opened = [], markup = html(Markdown, {text: '# Title\n\nSome **bold** and `code`.\n\n- one\n- two [site](https://example.com/a)\n\n<script>alert(1)</script> <img src=x onerror=alert(1)>\n\n![pic](https://example.com/p.png) [bad](javascript:alert(1))', onLink: url => opened.push(url)});
  assert.match(markup, /<h3>Title<\/h3>/); assert.match(markup, /<strong>bold<\/strong>/); assert.match(markup, /<ul><li>one<\/li><li>two <button[^>]*class="ext-mdlink"[^>]*>site<small class="ext-mdhost"> \(example\.com\)<\/small><\/button><\/li><\/ul>/);
  assert.doesNotMatch(markup, /<script|<img|<as|href=|<[^>]* onerror=/); assert.match(markup, /&lt;script&gt;/); assert.match(markup, /<span>bad<\/span>/);
  assert.equal(publicWebUrl('https://example.com/x'), 'https://example.com/x');
  for (const bad of ['http://localhost/x', 'https://127.0.0.1/', 'http://192.168.1.2/', 'https://user:pw@example.com/', 'file:///c:/x', 'http://[::1]/', 'https://printer.local/', 'http://localhost./', 'http://foo.local./', 'http://router.home./']) assert.equal(publicWebUrl(bad), null, bad);
});

test('B2 details sheet: author, follow, official tag and Install in the header; README once; star distribution; paste link only under More', () => {
  setLocale('zh-CN');
  const work = {key: 's:w', id: 'w', sourceId: 'official', packageName: '@ai-buddy/bilibili-companion', name: 'B站陪伴', description: '角色陪你看 B站视频，看完聊聊，也可以帮你写评论。', readme: '## 用法\n\n- 看视频', category: 'function', authorId: 'a', reviewsRepository: 'o/r', releases: [{version: '2.0.1', publishedAt: '2026-10-20T00:00:00Z', notes: 'fix'}, {version: '2.0.0', publishedAt: '2026-10-10T00:00:00Z'}], backend: 'dsh'};
  const markup = html(WorkDetail, {detail: {work, author: {id: 'a', name: 'lXiaoSel1', githubLogin: 'lXiaoSel1'}, authorWorks: 3, followed: false, reviews: {count: 4, sum: 18, distribution: [0, 0, 0, 2, 2], reviews: []}}, source: official, busy: false, onClose: noop, onInstall: noop, onAuthor: noop, onFollow: noop, onLink: noop, onReadmeLink: noop, onReview: noop, onCheck: noop, onCheckLink: noop});
  assert.match(markup, /lXiaoSel1/); assert.match(markup, />关注</); assert.match(markup, /class="ws-tag">官方</); assert.match(markup, /ui-dlg-act[\s\S]*安装…/);
  assert.match(markup, /<h4>用法<\/h4>/); assert.equal(markup.split('角色陪你看 B站视频').length - 1, 0, 'description is not repeated when a README exists');
  assert.match(markup, /版本<span class="ext-tabn">2</); const rating = html(RatingSummary, {reviews: {count: 4, sum: 18, distribution: [0, 0, 0, 2, 2]}}); assert.match(rating, /4\.5/); assert.match(rating, /50%/); assert.match(html(RatingSummary, {reviews: {count: 0}}), /暂无评价/);
  const author = html(AuthorDialog, {author: {id: 'a', name: 'lXiaoSel1', githubLogin: 'lXiaoSel1'}, followed: true, works: [{key: 'k', packageName: '@ai-buddy/qq-connect', name: 'QQ连接'}], busy: false, onClose: noop, onFollow: noop, onOpen: noop});
  assert.match(author, /1 个插件/); assert.match(author, /已关注/); assert.doesNotMatch(author, /关注人数|followers/);
});

test('B4 rows say what a plugin is doing now and why a load failed, in plain words', () => {
  setLocale('zh-CN');
  assert.equal(runtimeLabel({enabled: true, runtimeVerified: true}), '运行中'); assert.equal(runtimeLabel({enabled: true}), '加载中'); assert.equal(runtimeLabel({enabled: false}), '已停用'); assert.equal(runtimeLabel({enabled: true, runtimeFailure: {code: 'X'}}), '加载失败');
  assert.equal(installedSituation({packageName: '@ai-buddy/work-collaboration', enabled: true, runtimeVerified: true, grantedCapabilities: Array(9)}, {jobs: 2}), '2 个任务进行中 · 9 项权限');
  assert.equal(installedSituation({packageName: '@ai-buddy/qq-connect', enabled: true, grantedCapabilities: ['a']}, {accounts: [{pluginId: '@ai-buddy/qq-connect', enabled: true, label: '我的QQ'}]}), '已连接「我的QQ」 · 1 项权限');
  assert.match(installedSituation({packageName: 'x', enabled: true, runtimeFailure: {code: 'DSH_ACTIVATION_FAILED', message: 'native'}}), /插件启动后没有正常运行/);
  setLocale('en'); assert.equal(installedSituation({packageName: '@ai-buddy/work-collaboration', enabled: true, grantedCapabilities: ['a']}, {jobs: 1}), '1 task running · 1 permission'); setLocale('zh-CN');
});

test('B5 maintenance records: retry, cancel only where safe, reasons translated; update cards show what changed and no 尚未启动', () => {
  setLocale('zh-CN');
  const row = job => html(MaintenanceRow, {job: {id: 'j', packageKey: 'dsh:official:@ai-buddy/qq-connect', operation: 'install', version: '2.0.1', createdAt: '2026-10-29T00:00:00Z', ...job}, installed: [{packageKey: 'dsh:official:@ai-buddy/qq-connect'}], busy: false, onCancel: noop, onRetry: noop, onReview: noop});
  const failed = row({state: 'failed', error: {code: 'DSH_PACKAGE_DIGEST_MISMATCH', message: 'Package bytes differ'}});
  assert.match(failed, /下载校验不一致，已停止。 原来的版本保留着。/); assert.match(failed, /data-maintenance-action="review"[^>]*>[\s\S]*查看/); assert.doesNotMatch(failed, /取消这次维护|重试/);
  assert.match(row({state: 'failed', error: {code: 'PLUGIN_BUSY'}}), /data-maintenance-action="retry"[\s\S]*重试/);
  const running = row({state: 'running'}); assert.match(running, /这一步不能取消/); assert.doesNotMatch(running, /取消这次维护|重试/);
  assert.match(row({state: 'queued', waitingReason: 'active-work'}), /等工作任务停下来[\s\S]*取消这次维护/);
  assert.match(maintenanceNote({state: 'queued'}, {ahead: '工作与协作'}), /排在「工作与协作」之后/);
  setLocale('en'); assert.match(row({state: 'failed', error: {code: 'DSH_PACKAGE_DIGEST_MISMATCH'}}), /Checksum mismatch/); setLocale('zh-CN');
  const card = html(UpdateCard, {update: {packageKey: 'dsh:official:@ai-buddy/bilibili-companion', from: '2.0.0', to: '2.0.1', state: 'available', addedCapabilities: ['ui.bubble'], changes: [{version: '2.0.1', notes: '观看记录里失败的条目可以折叠'}]}, busy: false, onReview: noop});
  assert.match(card, /<details[^>]*open=""[^>]*><summary>更新内容/); assert.match(card, /观看记录里失败的条目可以折叠/); assert.match(card, /新增 1 项权限/); assert.doesNotMatch(card, /尚未启动/);
  const now = new Date(2026, 9, 29, 19, 32); assert.equal(checkedLabel(new Date(2026, 9, 29, 19, 32), now), '今天 19:32');
});

test('C-6 English names: official plugins and sources through t(), community works through signed locales.en', () => {
  setLocale('en');
  assert.deepEqual(workText({packageName: '@ai-buddy/qq-connect', name: 'QQ连接', description: '中文'}, {official: true}), {name: 'QQ Connect', description: 'Lets a character answer the QQ contacts and groups you allow.', readme: null});
  assert.equal(workText({packageName: 'x', name: '番剧追更提醒', description: '中文', locales: {en: {name: 'Anime reminder'}}}).name, 'Anime reminder');
  assert.equal(workText({packageName: 'x', name: '番剧追更提醒', description: '中文'}).description, '中文');
  // a third-party source cannot borrow the official profile by reusing a package name
  assert.equal(workText({packageName: '@ai-buddy/qq-connect', name: 'Fake'}, {official: false}).name, 'Fake');
  setLocale('zh-CN');
});

test('B6 sources: the community catalog is a source row, offline import takes a signed file, favourites are files', () => {
  setLocale('zh-CN');
  const markup = html(PluginCenter, {api: {action: async () => ({}), onUpdate: () => noop}, embedded: true, extras: {catalog: {configured: false, works: 0}, busy: false, onSetCatalog: noop, onRefreshCatalog: noop, onImport: noop, onExport: noop, onImportPreferences: noop}});
  assert.match(markup, /data-community-catalog-row[\s\S]*社区目录[\s\S]*还没有配置地址[\s\S]*设置地址/); assert.match(markup, /离线导入[\s\S]*选择文件…/); assert.match(markup, /导入旧扩展文件夹…/); assert.match(markup, /收藏与关注[\s\S]*导出文件[\s\S]*导入文件/); assert.doesNotMatch(markup, /<textarea/);
  assert.equal(rangeCeiling('>=1.9.0 <=1.9.2'), '这个扩展只支持到 1.9.2。');
});

test('B1/B6 source: favourites import/export and the five-star sort live where the design puts them', async () => {
  const center = await readFile(new URL('../src/community-center.mjs', import.meta.url), 'utf8');
  assert.match(center, /h\("option", \{ value: "stars" \}, t\("五星评价"\)\)/);
  assert.match(center, /label: t\("导出收藏与关注…"\)[\s\S]*label: t\("导入收藏与关注…"\)/); assert.doesNotMatch(center, /h\("textarea"/);
  // the busy maintenance banner shows only on Updates
  assert.match(center, /maintenance: tab === "updates" \? state\?\.maintenance : null/);
});

test('丙7 work engine detection checks files only and never reads a sign-in file', async t => {
  const root = await mkdtemp(join(process.env.AI_BUDDY_TEST_TEMP_BASE || tmpdir(), 'buddy-engines-')); t.after(() => rm(root, {recursive: true, force: true}));
  const local = join(root, 'local'), codexHome = join(root, 'codex'), bin = join(root, 'bin');
  await mkdir(join(local, 'OpenAI', 'Codex', 'bin', 'v1'), {recursive: true}); await writeFile(join(local, 'OpenAI', 'Codex', 'bin', 'v1', 'codex.exe'), '');
  await mkdir(codexHome, {recursive: true}); await writeFile(join(codexHome, 'auth.json'), 'SECRET-NEVER-READ');
  await mkdir(bin, {recursive: true}); await writeFile(join(bin, 'claude.exe'), '');
  const env = {LOCALAPPDATA: local, CODEX_HOME: codexHome, USERPROFILE: root, PATH: bin, CLAUDE_CONFIG_DIR: join(root, 'claude')};
  const result = await detectWorkEngines({env, root, connections: [{kind: 'deepseek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash'}]});
  assert.deepEqual(result.engines.map(row => [row.engine, row.state]), [['codex', 'signed-in'], ['claude', 'signed-out'], ['dsh', 'ready']]);
  assert.doesNotMatch(JSON.stringify(result), /SECRET/);
  // a network share in PATH is never touched; the local entry still counts
  const shared = await detectWorkEngines({env: {USERPROFILE: root, PATH: '\\\\server\\share;' + bin}, root}); assert.equal(shared.engines[0].state, 'missing'); assert.equal(shared.engines[1].state, 'signed-out');
  const source = await readFile(new URL('../src/community/work-engines.mjs', import.meta.url), 'utf8'); assert.doesNotMatch(source, /execFile|spawn|child_process|readFileSync|statSync/); assert.deepEqual([...source.matchAll(/readFile\(([^)]*)\)/g)].map(m => /runtime-paths\.json/.test(m[1])), [true]);
});

test('B8 「检查并保存」 checks the OneBot endpoints (or the cookie) before saving and stores nothing itself', async () => {
  const calls = [], session = (account, secret) => ({verify: async () => calls.push(['verify', account, secret]), socket: async () => calls.push(['socket'])});
  const accounts = {get: ref => ref === 'r' ? {ref: 'r', pluginId: '@ai-buddy/qq-connect', httpUrl: 'http://127.0.0.1:3000', webSocketUrl: 'ws://127.0.0.1:3001'} : null, secret: () => ({accessToken: 'saved'})};
  assert.deepEqual(await checkSocialAccountDraft({pluginId: '@ai-buddy/qq-connect', accountId: '7654321', httpUrl: 'http://127.0.0.1:3000', webSocketUrl: 'ws://127.0.0.1:3001', secret: {accessToken: 'new'}}, {accounts, session}), {checked: true, platform: 'qq'});
  assert.equal(calls[0][2].accessToken, 'new');
  await checkSocialAccountDraft({ref: 'r', pluginId: '@ai-buddy/qq-connect', accountId: '7654321'}, {accounts, session}); assert.equal(calls.at(-2)[2].accessToken, 'saved');
  await assert.rejects(checkSocialAccountDraft({pluginId: '@ai-buddy/qq-connect', accountId: '1', httpUrl: 'http://10.0.0.2:3000', webSocketUrl: 'ws://127.0.0.1:3001'}, {accounts, session}), {code: 'SOCIAL_ENDPOINT_DENIED'});
  assert.deepEqual(await checkSocialAccountDraft({pluginId: '@ai-buddy/bilibili-companion', accountId: '42'}, {accounts, session}), {checked: false, platform: 'bilibili', reason: 'no-cookie'});
  const fetchImpl = async () => new Response(JSON.stringify({code: 0, data: {isLogin: true, mid: 43}}));
  await assert.rejects(checkSocialAccountDraft({pluginId: '@ai-buddy/bilibili-companion', accountId: '42', secret: {cookie: 'c'}}, {accounts, session, fetchImpl}), {code: 'SOCIAL_LOGIN_IDENTITY_MISMATCH'});
  const ui = await readFile(new URL('../src/social-accounts-ui.mjs', import.meta.url), 'utf8');
  assert.match(ui, /const empty=\(\)=>\(\{pluginId:'@ai-buddy\/qq-connect'/); assert.ok(ui.indexOf("action:'social-accounts-check'") < ui.indexOf("action:'social-accounts-save'"));
});

test('B2 README links open through the host only when the signed work page contains them', async t => {
  const opened = [], f = await setupCommunity(t, {onOpenExternal: async url => opened.push(url)}), value = catalog(f.pub); value.works[0].readme = 'See [docs](https://example.com/docs) or http://127.0.0.1:9/x'; await f.load(value);
  await f.service.action({action: 'community-open-readme-link', sourceId: f.pub.source.sourceId, id: 'test.tools', url: 'https://example.com/docs'}); assert.deepEqual(opened, ['https://example.com/docs']);
  await assert.rejects(f.service.action({action: 'community-open-readme-link', sourceId: f.pub.source.sourceId, id: 'test.tools', url: 'https://evil.example/x'}), {code: 'COMMUNITY_LINK_UNAVAILABLE'});
  await assert.rejects(f.service.action({action: 'community-open-readme-link', sourceId: f.pub.source.sourceId, id: 'test.tools', url: 'http://127.0.0.1:9/x'}), {code: 'COMMUNITY_LINK_UNAVAILABLE'});
});

// ---- review fixes (REVIEW-ext-center.md) ----
test('中-3: needs-user and interrupted rows only offer 「查看」; nothing on a record re-queues by itself', async () => {
  const {maintenanceAction} = await import('../src/community-center.mjs');
  for (const state of ['needs-user', 'interrupted-needs-user']) for (const operation of ['install', 'enable', 'disable', 'uninstall', 'rollback']) assert.equal(maintenanceAction({state, operation, error: {code: 'PLUGIN_SOURCE_CHANGED'}}), 'review', state + ' ' + operation);
  assert.equal(maintenanceAction({state: 'failed', operation: 'enable', error: {code: 'PLUGIN_SOURCE_CHANGED'}}), 'review');
  assert.equal(maintenanceAction({state: 'failed', operation: 'enable', error: {code: 'COMMUNITY_INSTALLATION_CHANGED'}}), 'retry');
  assert.equal(maintenanceAction({state: 'running'}), null); assert.equal(maintenanceAction({state: 'completed'}), null);
  const center = await readFile(new URL('../src/community-center.mjs', import.meta.url), 'utf8'), review = center.slice(center.indexOf('function reviewJob('), center.indexOf('function retryJob('));
  // 「查看」 never calls a dsh-* action; changed sources go to the plan review, uninstall / roll back to their confirmation
  assert.doesNotMatch(review, /action: "dsh-(enable|disable|uninstall|rollback)"|"dsh-" \+/); assert.match(review, /SOURCE_CHANGED\|PLAN_CHANGED[\s\S]*openPlanFor/); assert.match(review, /setConfirm\(\{ kind: job\.operation, record \}\)/);
  const retry = center.slice(center.indexOf('function retryJob('), center.indexOf('function retryJob(') + 600); assert.match(retry, /\["uninstall", "rollback"\]\.includes\(job\.operation\)\) return record \? setConfirm/);
});

test('中-4: the README renderer is linear: 100,000 unclosed marks render quickly, and the result is memoized per text', async () => {
  const cases = ['['.repeat(100000), '[a'.repeat(50000), '[a]('.repeat(25000), '_a'.repeat(50000), '<!--'.repeat(25000), '# a' + ' '.repeat(99990) + 'b', 'http://a'.repeat(12000), 'a\n\n'.repeat(33000)];
  for (const text of cases) { const started = performance.now(); html(Markdown, {text, onLink: noop}); assert.ok(performance.now() - started < 1500, text.slice(0, 12) + ' took ' + Math.round(performance.now() - started) + ' ms'); }
  const source = await readFile(new URL('../src/community-markdown.mjs', import.meta.url), 'utf8');
  assert.match(source, /useMemo\(\(\)=>markdownBlocks\(text/); assert.doesNotMatch(source, /const INLINE=/);
});

test('中-1 UI: the import confirmation shows the signed date and warns for an old or older-than-active catalog', async () => {
  setLocale('zh-CN'); const {OfflineImportDialog} = await import('../src/community-offline-dialog.mjs');
  const base = {importId: 'i', sourceId: 's', generatedAt: '2026-10-24T22:00:00Z', activeGeneratedAt: null, ageDays: 2, warnOld: false, replaceCatalog: true, works: [{sourceId: 's', id: 'w', packageName: '@ai-buddy/qq-connect', version: '2.0.1'}]};
  const fresh = html(OfflineImportDialog, {preview: base, sourceName: 'AI Buddy 官方扩展', busy: false, onConfirm: noop, onCancel: noop});
  assert.match(fresh, /目录签名日期[\s\S]*2026/); assert.match(fresh, /QQ连接 2\.0\.1/); assert.match(fresh, /会成为这个来源正在用的目录/); assert.doesNotMatch(fresh, /data-offline-stale|data-offline-older/);
  assert.match(html(OfflineImportDialog, {preview: {...base, ageDays: 65, warnOld: true}, busy: false, onConfirm: noop, onCancel: noop}), /data-offline-stale[\s\S]*已经签名 65 天了/);
  assert.match(html(OfflineImportDialog, {preview: {...base, replaceCatalog: false, keptReason: 'COMMUNITY_CATALOG_REPLAY', activeGeneratedAt: '2026-10-28T22:00:00Z'}, busy: false, onConfirm: noop, onCancel: noop}), /data-offline-older[\s\S]*不会替换正在用的目录/);
});

test('低-4: official texts and the scan step need the official source, not only the package name', () => {
  setLocale('zh-CN');
  const third = html(InstallPage, {work: {packageName: '@ai-buddy/qq-connect', name: 'Look-alike'}, source: {sourceId: 'x', name: 'Someone', official: false}, plan: null, granted: [], onGrant: noop, stage: 'installed', record: {packageKey: 'k', grantedCapabilities: [], enabled: false}, busy: false});
  assert.doesNotMatch(third, /启用并扫码登录|替你回复你允许的人和群/); assert.match(third, /Look-alike/);
  const unknown = html(InstallPage, {work: {packageName: '@ai-buddy/qq-connect', name: 'Look-alike'}, source: null, plan: null, granted: [], onGrant: noop, stage: 'plan', busy: false});
  assert.doesNotMatch(unknown, /替你回复你允许的人和群/);
  const validation = html(InstallPage, {work: {packageName: '@ai-buddy/qq-connect'}, source: {sourceId: 'iso', name: 'ISO', official: false}, official: true, plan: null, granted: [], onGrant: noop, stage: 'installed', record: {packageKey: 'k', grantedCapabilities: [], enabled: false}, busy: false});
  assert.match(validation, /启用并扫码登录/);
});
