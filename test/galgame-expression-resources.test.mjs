import test from 'node:test';
import assert from 'node:assert/strict';
import {CHARACTER_EXPRESSIONS} from '../src/character-expressions.generated.mjs';

const roles = ['deepseek', 'chatgpt', 'claude', 'gemini', 'glm', 'grok', 'hunyuan', 'kimi', 'minimax', 'qwen', 'seed'];
const emotions = ['normal', 'cheerful', 'shy', 'serious', 'confused', 'angry', 'frightened', 'exasperated', 'starry', 'gentle', 'flustered', 'smug', 'laugh', 'sleepy', 'sad', 'cry', 'asleep', 'thinking', 'playful', 'eating', 'surprised', 'coax'];

test('every role displays the complete approved x2 portrait set', () => {
  assert.deepEqual(Object.keys(CHARACTER_EXPRESSIONS).sort(), roles.toSorted());
  const paths = new Set();
  for (const [id, role] of Object.entries(CHARACTER_EXPRESSIONS)) {
    assert.deepEqual(['normal', ...Object.keys(role.expressions)].sort(), emotions.toSorted(), id);
    for (const [emotion, row] of Object.entries({normal: role.normal, ...role.expressions})) {
      assert.equal(row.src, `./assets/characters/galgame-expressions/${id}/${emotion}.webp`);
      assert.match(row.sha256, /^[0-9a-f]{64}$/);
      assert.ok(row.size.length === 2 && row.size.every(n => Number.isSafeInteger(n) && n >= 1800 && n % 2 === 0));
      assert.ok(row.registration.scale > 0 && [row.registration.x, row.registration.y].every(Number.isFinite));
      paths.add(row.src);
    }
  }
  assert.equal(paths.size, 242);
});

test('uses the approved viewport and doubled registration, including Seed’s replacement', () => {
  assert.deepEqual(CHARACTER_EXPRESSIONS.deepseek.viewport, [0, 0, 1870, 3364]);
  assert.deepEqual(CHARACTER_EXPRESSIONS.deepseek.expressions.gentle.registration, {scale: 1.0757, x: -211.4, y: 18.4});
  assert.deepEqual(CHARACTER_EXPRESSIONS.claude.viewport, [48, 12, 2016, 3050]);
  assert.deepEqual(CHARACTER_EXPRESSIONS.claude.normal.registration, {scale: 0.9041717049576784, x: 160.51602176541712, y: 18.29987908101566});
  assert.equal(CHARACTER_EXPRESSIONS.seed.expressions.starry.source, 'ex-starry-r2');
});
