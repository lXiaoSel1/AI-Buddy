import {createHash} from 'node:crypto';
import {lstat, readFile} from 'node:fs/promises';
import {isAbsolute, join} from 'node:path';
import {assertPluginTreeNoLinks} from '../plugin-archive.mjs';

export const BUILTIN_ASR_ID = 'builtin-asr';
// Published ai-buddy.voice-shared-runtime 1.0.3. Preserve the official shared ASR cache identity.
export const BUILTIN_ASR_ARCHIVE = '2a649fc210a00f20b5000d82ac56ba8a6e383c71947bc899880a9307ac90c06e';
export const BUILTIN_ASR_FILES = Object.freeze([
  ['assets.json', 675616, '36402e36a0e3249db75d6d93995bfd696f1759b0c1c8620300ab8a3df92b5eee'],
  ['downloads.json', 251444, '8d6e870ecb95054e55a1e7454e9b129d024ebd77dd2980aa3f1edceb5ed6838a'],
  ['asr.py', 4490, '19ddc7b7ffa1e3d58614caecbe26df94efe93ae9793166d972acbb398b7ba2e9'],
  ['asr_worker.py', 1698, '7401a00522cff5ade2f00853d1edd2b20c10b1e6c47f75810c6809556b1926f8'],
  ['worker_protocol.py', 2921, '204769ac9411983c6522402a6f0b8b5fce74519a6675ad07bbf152925afc2455'],
  ['LICENSE.md', 13663, '743e12419085102e444fd36c1df870d9fcd64badcc03cc551ae0fae81f517b3a'],
  ['ASSET-NOTICES.md', 2049, 'd96c2b3bf59ab71b0de74158c7d1e04d3ef4a05b18b37462ad094608d9839de0'],
].map(([path, bytes, sha256]) => Object.freeze({path, bytes, sha256})));

const invalid = () => Object.assign(Error('语音识别组件清单无效'), {code:'VOICE_ASSET_MANIFEST'});

export function builtinAsrRecord(directory) {
  if (!isAbsolute(directory ?? '')) throw invalid();
  return {directory, sourceId:'official', archiveSha256:BUILTIN_ASR_ARCHIVE, manifest:{files:BUILTIN_ASR_FILES}};
}

export async function checkBuiltinAsrWorkers(directory, signal) {
  for (const file of BUILTIN_ASR_FILES.filter(row => row.path.endsWith('.py'))) {
    signal?.throwIfAborted();
    const path = join(directory, file.path);
    await assertPluginTreeNoLinks(path);
    const stat = await lstat(path);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size !== file.bytes) throw invalid();
    const bytes = await readFile(path, {signal});
    if (createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw invalid();
  }
}
