import {access} from 'node:fs/promises';
import {isAbsolute} from 'node:path';
import {createKimiWorkAdapter} from '../../../src/harness-profiles/kimi.mjs';

let adapter = null;
/** Bundled by package-kimi-plugin.mjs. Runtime is a separate verified dependency. */
export async function activate(api, context = {}) {
  const binary = context.runtimeBinary;
  if (typeof binary !== 'string' || !isAbsolute(binary)) throw Error('Kimi runtime dependency is not installed or has not been verified');
  await access(binary);
  adapter = await createKimiWorkAdapter({task: context.task, binding: context.binding, connection: context.connection,
    context: context.characterContext, profileOptions: context.profileOptions,
    runtime: {binary, version: context.version, sha256: context.sha256}});
  adapter.on('event', event => { void api.harness.emit({harnessId: 'ai-buddy.kimi-engine.acp', event}).catch(() => {}); });
  await api.harness.register({id: 'ai-buddy.kimi-engine.acp', name: 'Kimi ACP', protocol: 'acp', runtimeDependency: 'ai-buddy.kimi-runtime'}, {
    probe: () => adapter.probe(), startSession: options => adapter.startSession(options), resumeSession: options => adapter.resumeSession(options),
    sendTurn: options => adapter.sendTurn(options), cancelTurn: options => adapter.cancelTurn(options), respondToRequest: options => { adapter.respondToRequest(options); return {sent: true}; }, profileReceipt: () => adapter.profileReceipt,
  });
}
export async function deactivate() { adapter?.dispose(); adapter = null; }
