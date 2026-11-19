import {mkdir, lstat, readFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {writeAtomic} from '../atomic-write.mjs';
import {assertPluginTreeNoLinks} from '../plugin-archive.mjs';
import {BUILTIN_ASR_ID} from './builtin-asr-assets.mjs';

const validBytes = n => Number.isSafeInteger(n) && n >= 0;

// Only the host schedules downloads. Page mounts and status reads are side-effect free.
export function createBuiltinAsr({assets, dataRoot, publish = () => {}}) {
  const file = join(dataRoot, 'voice', 'asr-download.json');
  let tail = Promise.resolve(), loaded = false, hold = null, active = null, closed = false;
  function serialized(fn) {
    const task = tail.then(fn);
    tail = task.catch(() => {});
    return task;
  }
  function notify(value) {
    try { publish({...value}); } catch {}
    return value;
  }
  async function readHold() {
    if (loaded) return;
    await assertPluginTreeNoLinks(file);
    try {
      const info = await lstat(file);
      if (!info.isFile() || info.nlink !== 1 || info.size > 256) throw Error();
      const saved = JSON.parse(await readFile(file, 'utf8'));
      hold = saved === 'paused' || saved === null ? saved : 'failed';
    } catch (error) {
      hold = error.code === 'ENOENT' ? null : 'failed';
    }
    loaded = true;
  }
  async function saveHold(next) {
    if (next === hold) return;
    await assertPluginTreeNoLinks(file);
    await mkdir(dirname(file), {recursive:true});
    writeAtomic(file, JSON.stringify(next));
    hold = next;
  }
  async function inspect() {
    await readHold();
    if (active) return {...active.progress};
    const row = await assets.status('asr', BUILTIN_ASR_ID);
    if (row.state === 'ready') return {state:'ready'};
    return {state:hold ?? (row.state === 'unavailable' ? 'failed' : 'missing'),
      ...(validBytes(row.downloadBytes) ? {total:row.downloadBytes} : {})};
  }
  async function start(manual) {
    await readHold();
    if (closed || active || (!manual && hold)) return inspect();
    const component = await assets.status('asr', BUILTIN_ASR_ID);
    if (component.state === 'ready') {
      await saveHold(null);
      return {state:'ready'};
    }
    if (component.state === 'unavailable') {
      await saveHold('failed');
      return notify({state:'failed'});
    }
    await saveHold(null);
    const task = {controller:new AbortController(),progress:{state:'downloading',received:0,
      ...(validBytes(component.downloadBytes) ? {total:component.downloadBytes} : {})}};
    active = task;
    notify(task.progress);
    const onProgress = event => {
      if (closed || active !== task || task.controller.signal.aborted) return;
      if (validBytes(event.downloadReceivedBytes)) task.progress.received = event.downloadReceivedBytes;
      if (validBytes(event.downloadBytes)) task.progress.total = event.downloadBytes;
      notify(task.progress);
    };
    task.work = Promise.resolve().then(() => assets.prepare('asr', {engineId:BUILTIN_ASR_ID,
      verifyOnly:component.state === 'verification-needed',
      forceDownload:component.downloadRequired === true && (component.state !== 'missing' || component.verificationFailed === true),
      signal:task.controller.signal, onProgress})).then(() => true, () => false);
    task.work.then(success => serialized(async () => {
      if (active !== task || closed || task.controller.signal.aborted) return;
      active = null;
      if (!success) await saveHold('failed');
      notify({state:success ? 'ready' : 'failed'});
    })).catch(() => {hold = 'failed';});
    return {...task.progress};
  }
  async function stopDownload() {
    const previous = active;
    if (previous) {
      active = null;
      previous.controller.abort();
      await previous.work;
    }
  }
  return {
    status:() => serialized(inspect),
    auto:() => serialized(() => start(false)),
    resume:() => serialized(() => start(true)),
    pause:() => serialized(async () => {
      if ((await inspect()).state === 'ready') return {state:'ready'};
      await saveHold('paused');
      await stopDownload();
      return notify({state:'paused'});
    }),
    close:() => serialized(async () => {closed = true; await stopDownload();}),
  };
}
