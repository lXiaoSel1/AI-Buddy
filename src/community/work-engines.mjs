import {readdir, readFile, stat} from 'node:fs/promises';
import {join, isAbsolute} from 'node:path';
import {homedir} from 'node:os';
import {codexHome} from '../runtime-discovery.mjs';

const origin = value => { try { return new URL(value).origin; } catch { return null; } };
// Review 低-7: asynchronous, local drives only (no UNC or network share in PATH is touched), and the whole scan has a time limit.
const local = path => isAbsolute(path) && /^[A-Za-z]:[\\/]/.test(path);
const withTimeout = (promise, ms, fallback) => Promise.race([promise, new Promise(done => { const timer = setTimeout(() => done(fallback), ms); timer.unref?.(); })]);
async function file(path) { if (!local(path)) return false; try { return (await stat(path)).isFile(); } catch { return false; } }
async function any(paths) { const found = await Promise.all(paths.map(file)); return found.includes(true); }
/** Work install page (B3, 丙7): which work engines this PC already has. File checks only: no engine, CLI, shell or
 * `--version` runs, nothing is installed or prepared, and sign-in files are tested for existence, never read.
 * connections: the host's saved API connections ({kind, protocol, baseUrl, model}); the DSH engine needs one of them. */
export async function detectWorkEngines({env = process.env, root, connections = [], timeoutMs = 2500} = {}) {
  const home = env.USERPROFILE || env.HOME || homedir(), appData = env.APPDATA || join(home, 'AppData', 'Roaming'), desktop = join(env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'OpenAI', 'Codex', 'bin');
  const paths = (env.PATH || env.Path || '').split(';').map(part => part.trim().replace(/^"|"$/g, '')).filter(local).slice(0, 200);
  const codex = withTimeout((async () => {
    let cores = []; if (local(desktop)) try { cores = (await readdir(desktop, {withFileTypes: true})).filter(entry => entry.isDirectory() && !entry.isSymbolicLink()).map(entry => join(desktop, entry.name, 'codex.exe')); } catch {}
    let recorded = null; if (root) try { recorded = JSON.parse(await readFile(join(root, 'local', 'receipts', 'runtime-paths.json'), 'utf8')).codex; } catch {}
    return any([...cores, ...paths.flatMap(dir => [join(dir, 'codex.exe'), join(dir, 'codex.cmd')]), join(appData, 'npm', 'codex.cmd'), ...typeof recorded === 'string' ? [recorded] : []]);
  })(), timeoutMs, false);
  const claude = withTimeout(any([...paths.flatMap(dir => [join(dir, 'claude.exe'), join(dir, 'claude.cmd')]), join(appData, 'npm', 'claude.cmd'), join(home, '.local', 'bin', 'claude.exe')]), timeoutMs, false);
  const [codexFound, claudeFound, codexAuth, claudeAuth] = await Promise.all([codex, claude, withTimeout(file(join(codexHome(env), 'auth.json')), timeoutMs, false), withTimeout(file(join(env.CLAUDE_CONFIG_DIR || join(home, '.claude'), '.credentials.json')), timeoutMs, false)]);
  const dsh = (Array.isArray(connections) ? connections : []).filter(row => row?.model && (row.kind === 'deepseek' && origin(row.baseUrl) === 'https://api.deepseek.com' || ['anthropic', 'anthropic-messages'].includes(row.protocol))).length;
  return {engines: [
    {engine: 'codex', state: !codexFound ? 'missing' : codexAuth ? 'signed-in' : 'signed-out'},
    {engine: 'claude', state: !claudeFound ? 'missing' : claudeAuth || env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN ? 'signed-in' : 'signed-out'},
    {engine: 'dsh', state: dsh ? 'ready' : 'needs-connection', connections: dsh}
  ]};
}
