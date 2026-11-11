// NapCat must stay inert until the parent assigns this Node process to its Job.
const {readFileSync} = require('node:fs');
const {isAbsolute} = require('node:path');
const {performance} = require('node:perf_hooks');

const file = process.env.AI_BUDDY_QQ_LAUNCH_FILE;
const token = process.env.AI_BUDDY_QQ_LAUNCH_TOKEN;
delete process.env.AI_BUDDY_QQ_LAUNCH_FILE;
delete process.env.AI_BUDDY_QQ_LAUNCH_TOKEN;

if (!file || !isAbsolute(file) || !/^[a-f0-9]{64}$/.test(token ?? '')) process.exit(72);
const waitCell = new Int32Array(new SharedArrayBuffer(4));
const deadline = performance.now() + 45_000;
for (;;) {
  if (performance.now() >= deadline) process.exit(71);
  try {
    if (readFileSync(file, 'utf8') === token) break;
    process.exit(72);
  } catch (error) {
    if (!['ENOENT', 'EACCES', 'EPERM', 'EBUSY'].includes(error.code)) process.exit(72);
  }
  // Only this child waits. The parent and its IPC/event loop stay responsive.
  Atomics.wait(waitCell, 0, 0, 40);
}

require('./native-path-guard.cjs');
