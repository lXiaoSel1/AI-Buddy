import {createHash} from 'node:crypto';
import {lstat, mkdir, readFile, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {assertPluginTreeNoLinks} from '../src/plugin-archive.mjs';
import {BUILTIN_ASR_FILES} from '../src/voice/builtin-asr-assets.mjs';

export async function stageBuiltinAsrAssets(root, out) {
  const destination = join(out, 'assets', 'voice-asr');
  await assertPluginTreeNoLinks(destination);
  await mkdir(destination, {recursive:true});
  const index = [];
  for (const file of BUILTIN_ASR_FILES) {
    const name = file.path;
    const upstreamText = ['ASSET-NOTICES.md','downloads.json'].includes(name);
    const folder = name === 'LICENSE.md' ? root
      : upstreamText ? join(root,'release','voice-asr')
      : join(root,'sdk','plugins','voice-shared-runtime');
    const source = join(folder, name);
    await assertPluginTreeNoLinks(source);
    const info = await lstat(source);
    if (!info.isFile() || info.size > file.bytes*(upstreamText?2:1)) throw Error('Unexpected built-in ASR source for ' + name);
    const sourceBytes = await readFile(source);
    // The checkout uses CRLF. Restore the exact published LF bytes before applying the asset pins.
    const bytes = upstreamText ? Buffer.from(sourceBytes.toString('utf8').replaceAll('\r\n','\n')) : sourceBytes;
    if (bytes.length !== file.bytes) throw Error('Unexpected built-in ASR source for ' + name);
    if (createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw Error('Built-in ASR source differs for ' + name);
    const target = join(destination, name);
    await assertPluginTreeNoLinks(target);
    try {
      await writeFile(target, bytes, {flag:'wx'});
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const existing = await lstat(target);
      if (!existing.isFile() || existing.nlink !== 1 || existing.size !== file.bytes || !(await readFile(target)).equals(bytes)) {
        throw Error('Conflicting ASR asset in candidate for ' + name);
      }
    }
    index.push({...file, path:'assets/voice-asr/' + name});
  }
  return index;
}
