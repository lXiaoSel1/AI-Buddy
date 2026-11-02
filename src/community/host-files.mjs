import {readFile, stat} from 'node:fs/promises';
export {detectWorkEngines} from './work-engines.mjs';
export {OFFLINE_BUNDLE_EXTENSION} from './offline-bundle.mjs';

const fail = message => { throw Object.assign(Error(message), {code: 'COMMUNITY_REQUEST_INVALID'}); };
/** 「导入文件」 for favourites and follows (B1/B6): the same JSON as 「导出文件」 writes; the service validates its content. */
export async function readPreferencesFile(path) {
  const info = await stat(path);
  if (!info.isFile()) fail('Choose a favourites file, not a folder or device');
  if (info.size > 4 * 1024 * 1024) fail('Favourites file is too large');
  try { return JSON.parse(await readFile(path, 'utf8')); } catch { fail('Favourites file is not valid JSON'); }
}
