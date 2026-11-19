import {createHash} from 'node:crypto';
import {constants, copyFileSync, linkSync, lstatSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {GALGAME_EMOTIONS as emotions} from '../src/galgame-expressions.mjs';

const roles = ['deepseek', 'chatgpt', 'claude', 'gemini', 'glm', 'grok', 'hunyuan', 'kimi', 'minimax', 'qwen', 'seed'];
const sourceManifestSha256 = 'cc0132c75971029ebdf1ce252625dd3bad23e173ce3f026e2d4556cb0266bfb4';
const layout = JSON.parse(readFileSync(new URL('./galgame-expression-layout.json', import.meta.url), 'utf8'));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const identityRegistration = {scale: 1, x: 0, y: 0};
const assetFolder = 'assets/characters/galgame-expressions';

function assert(condition, detail) {
  if (!condition) throw new Error('Galgame expression resources: ' + detail);
}

function readAsset(root, relativePath) {
  let file = root;
  for (const component of relativePath.split('/')) {
    file = join(file, component);
    assert(!lstatSync(file).isSymbolicLink(), 'linked asset: ' + relativePath);
  }
  assert(lstatSync(file).isFile(), 'asset is not a file: ' + relativePath);
  return {file, data: readFileSync(file)};
}

function isExactSet(value, keys) {
  return Object.keys(value ?? {}).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function checkWebp(data, entry, context) {
  assert(data.length === entry.bytes && data.length >= 30 &&
    data.toString('ascii', 0, 4) === 'RIFF' && data.readUInt32LE(4) + 8 === data.length &&
    data.toString('ascii', 8, 16) === 'WEBPVP8X' && data.readUInt32LE(16) === 10 &&
    (data[20] & 0x10) !== 0 && (data[20] & 0x02) === 0 &&
    data.readUIntLE(24, 3) + 1 === entry.size[0] && data.readUIntLE(27, 3) + 1 === entry.size[1],
  'expected still WebP with approved dimensions and alpha: ' + context);
}

export function readApprovedExpressions(directory,{manifestSha256=sourceManifestSha256}={}) {
  assert(/^[a-f0-9]{64}$/i.test(manifestSha256), 'expected the approved manifest SHA-256');
  const root = resolve(directory);
  for (let part = root; ; part = dirname(part)) {
    assert(!lstatSync(part).isSymbolicLink(), 'linked input directory: ' + part);
    if (part === dirname(part)) break;
  }
  const {data: raw} = readAsset(root, 'manifest.json');
  assert(sha256(raw) === manifestSha256.toLowerCase(), 'approved source manifest SHA-256 differs');
  const approval = JSON.parse(raw);
  assert(typeof approval.approved==='string' && /^\d{4}-\d{2}-\d{2}$/.test(approval.approved)
    && new Date(approval.approved).toString()!=='Invalid Date'
    && new Date(approval.approved).toISOString().startsWith(approval.approved), 'expected a valid approval date');
  assert(isExactSet(approval.characters, roles), 'character inventory differs');
  const files = [];
  const catalog = Object.fromEntries(roles.map(id => {
    const approved = approval.characters[id];
    assert(isExactSet(approved, emotions), 'expression inventory differs: ' + id);
    const [normal, ...expressions] = emotions.map(emotion => {
      const {x1, x2, source, registration_to_cheerful: alignment} = approved[emotion];
      const {scale, x, y} = alignment ?? (emotion === 'normal' ? layout[id].normal : identityRegistration);
      assert(Number.isFinite(scale) && scale > 0 && Number.isFinite(x) && Number.isFinite(y), 'invalid registration: ' + id + '/' + emotion);
      const filename = id + '/' + emotion + '.webp';
      assert(x2.file === 'x2/' + filename && x1.file === 'x1/' + filename &&
        x2.size.length === 2 && x2.size.every((n, i) => Number.isSafeInteger(n) && n === 2 * x1.size[i]),
      'expected the approved 2x path and dimensions: ' + filename);
      const {file, data} = readAsset(root, x2.file);
      checkWebp(data, x2, filename);
      const path = assetFolder + '/' + filename, digest = sha256(data);
      files.push({characterId: id, file, path, bytes: data.length, sha256: digest});
      return [emotion, {src: './' + path, size: x2.size, sha256: digest, registration: {scale, x: x * 2, y: y * 2}, source}];
    });
    const role = {version: approval.approved + '-x2', viewport: layout[id].viewport.map(n => n * 2), normal: normal[1], expressions: Object.fromEntries(expressions)};
    return [id, role];
  }));
  return {catalog, files};
}

export function materializeGalgameExpressions(bundle, destination, linkAssets) {
  const staged = {linkedFiles: 0, linkedBytes: 0, copiedFiles: 0, copiedBytes: 0};
  for (const row of bundle.files) {
    const target = join(destination, row.path);
    const sourceStat = lstatSync(row.file);
    assert(sourceStat.isFile() && sourceStat.size === row.bytes, 'asset changed before staging: ' + row.path);
    mkdirSync(dirname(target), {recursive: true});
    if (linkAssets) {
      try {
        linkSync(row.file, target);
        const targetStat = lstatSync(target);
        assert(targetStat.dev === sourceStat.dev && targetStat.ino === sourceStat.ino, 'staged hardlink changed identity: ' + row.path);
        staged.linkedFiles++;
        staged.linkedBytes += row.bytes;
        continue;
      } catch (error) {
        if (error.code !== 'EXDEV') throw error;
      }
    }
    copyFileSync(row.file, target, constants.COPYFILE_EXCL);
    staged.copiedFiles++;
    staged.copiedBytes += row.bytes;
  }
  return staged;
}

// Only the earlier stage expression WebPs are replaced. Default portrait PNGs are still CG references.
export function isLegacyStageExpression(path) {
  return /^assets\/characters\/v1710\/[a-z]+\/expressions\/(?:cheerful|shy|serious|confused|angry|frightened|exasperated|starry)\.webp$/.test(path);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [, , source, output, sha, ...extra] = process.argv;
  assert(source && output && !extra.length && (sha===undefined || sha.startsWith('--manifest-sha256=')),
    'pass the approved asset directory, generated manifest path and optional --manifest-sha256');
  const {catalog, files} = readApprovedExpressions(source,{manifestSha256:sha?.slice('--manifest-sha256='.length)});
  const content = '// Generated by scripts/galgame-expression-resources.mjs from the approved x2 WebPs.\n' +
    'export const CHARACTER_EXPRESSION_IDS=' + JSON.stringify(emotions) + ';\n' +
    'export const CHARACTER_EXPRESSIONS=' + JSON.stringify(catalog, null, 2) + ';\n';
  writeFileSync(output, content.replaceAll('\n', '\r\n'));
  console.log(JSON.stringify({portraits: files.length, bytes: files.reduce((bytes, row) => bytes + row.bytes, 0)}));
}
