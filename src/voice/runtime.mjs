import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import {voicePythonEnvironment,pythonFilePath} from './python-environment.mjs';

const engines = new Set(['breeze', 'gpt']);
const MAX_LINE = 8 * 1024 * 1024;
const fail = (code, message) => Object.assign(new Error(message), { code });
const aborted = () => new DOMException('语音操作已停止', 'AbortError');
// The pinned Zipformer vocabulary emits this standalone silence control token.
const recognitionText=value=>String(value??'').replace(/(?<![A-Za-z])SIL(?![A-Za-z])/g,'').trim();

function awaitChecked(promise, signal, timeoutMs) {
  let timer;
  let cancel;
  return new Promise((resolve, reject) => {
    cancel = () => reject(aborted());
    timer = setTimeout(() => reject(fail('VOICE_WORKER_TIMEOUT', '语音组件响应超时')), timeoutMs);
    if (signal?.aborted) cancel();
    else signal?.addEventListener('abort', cancel, { once: true });
    promise.then(resolve, reject);
  }).finally(() => {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
  });
}

async function* readLines(stream) {
  const decoder = new StringDecoder('utf8');
  let tail = '';
  for await (const chunk of stream) {
    tail += decoder.write(chunk);
    let end;
    while ((end = tail.indexOf('\n')) !== -1) {
      if (end > MAX_LINE) throw fail('VOICE_WORKER_PROTOCOL', '语音组件数据过大');
      const line = tail.slice(0, end);
      tail = tail.slice(end + 1);
      yield JSON.parse(line);
    }
    if (tail.length > MAX_LINE) throw fail('VOICE_WORKER_PROTOCOL', '语音组件数据过大');
  }
  if (tail || decoder.end()) throw fail('VOICE_WORKER_PROTOCOL', '语音组件数据未完整结束');
}

function childEnvironment(assets) {
  return voicePythonEnvironment(assets);
}

function makeWorker({ kind, assets, supervisor }) {
  for (const field of ['python', 'script', 'root', 'assetRoot', 'cacheRoot']) {
    if (!isAbsolute(assets[field] ?? '')) throw fail('VOICE_ASSETS_INVALID', '语音运行组件路径无效');
  }
  const runtimeId = 'voice:' + kind + ':' + randomUUID();
  const process = spawn(assets.python, [assets.script], {
    cwd: assets.root,
    env: childEnvironment(assets),
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  const lines = readLines(process.stdout);
  const exited = new Promise((resolve, reject) => {
    process.once('close', resolve);
    process.once('error', reject);
  });
  exited.catch(() => {});
  process.stdin.on('error', () => {});
  let admitted = false;
  let sequence = 0;
  let stopping;
  let requestActive = false;

  async function* request(op, payload, signal, timeout = 20000) {
    if (requestActive) throw fail('VOICE_WORKER_BUSY', '语音组件正在处理上一条请求');
    if (stopping || process.exitCode !== null) throw fail('VOICE_WORKER_CLOSED', '语音组件已退出');
    if (signal?.aborted) throw aborted();
    requestActive = true;
    const id = ++sequence;
    try {
      await awaitChecked(new Promise((resolve, reject) => {
        process.stdin.write(JSON.stringify({ id, op, ...payload }) + '\n', error => error ? reject(error) : resolve());
      }), signal, timeout);
      for (;;) {
        const next = await awaitChecked(lines.next(), signal, timeout);
        if (next.done || next.value?.id !== id) throw fail('VOICE_WORKER_PROTOCOL', '语音组件返回无效会话');
        const event = next.value;
        if (event.type === 'error') throw fail(event.code ?? 'VOICE_WORKER_ERROR', String(event.message ?? '语音组件运行失败').slice(0, 120));
        if (event.type === 'result' || event.type === 'done') {
          yield event;
          return;
        }
        if (event.type !== 'pcm') throw fail('VOICE_WORKER_PROTOCOL', '语音组件返回了无效的数据类型');
        yield event;
      }
    } finally {
      requestActive = false;
    }
  }

  async function result(op, payload, signal, timeout) {
    const events = request(op, payload, signal, timeout);
    try {
      const row = (await events.next()).value;
      if (row.type !== 'result') throw fail('VOICE_WORKER_PROTOCOL', '语音组件响应格式不匹配');
      return row;
    } finally {
      await events.return();
    }
  }

  async function start(signal) {
    await new Promise((resolve, reject) => {
      process.once('spawn', resolve);
      process.once('error', reject);
    });
    await supervisor.registerRoot({ runtimeId, pid: process.pid });
    admitted = true;
    const response = await result('initialize', {
      // Pinned engines build some relative import paths with '/' and chdir().
      // Keep their cwd conventional; long imported libraries and model/cache
      // files retain extended paths through the private environment/fields.
      root: assets.root,
      assetRoot: pythonFilePath(assets.assetRoot),
      cacheRoot: pythonFilePath(assets.cacheRoot),
    }, signal, 240000);
    if (response.state !== 'ready') throw fail('VOICE_WORKER_NOT_READY', '语音组件未准备就绪');
  }

  function stop() {
    if (stopping) return stopping;
    stopping = (async () => {
      process.stdin.end();
      if (admitted) {
        // Idle workers exit from stdin EOF. An owned busy worker can be retired
        // by the OS guard even when native synthesis has not yielded yet.
        await awaitChecked(exited, null, 400).catch(() => {});
        const proof = await supervisor.releaseRoot({ runtimeId });
        if (proof?.stopped !== true) throw fail('VOICE_STOP_UNCONFIRMED', '语音组件退出尚未确认');
      } else if (process.pid && process.exitCode === null) {
        // No Python engine loads until after ownership admission.
        process.kill();
      }
      await awaitChecked(exited, null, 10000).catch(error => {
        if (admitted) throw error;
      });
    })();
    return stopping;
  }

  return { kind, start, stop, request, result, dead: () => process.exitCode !== null };
}

export function createVoiceRuntime({ supervisor, resolveAssets, resolveProfile }) {
  let asr;
  let tts;
  let captureActive = false;
  let captureController;
  let speakController;
  let closed = false;
  let captureTail = Promise.resolve();
  let engineTail = Promise.resolve();

  function captureOperation(run) {
    const result = captureTail.then(run);
    captureTail = result.catch(() => {});
    return result;
  }

  function engineOperation(run) {
    const result = engineTail.then(run);
    engineTail = result.catch(() => {});
    return result;
  }

  function assertOpen() {
    if (closed) throw fail('VOICE_RUNTIME_CLOSED', '语音功能已停止');
  }

  async function retireAsr() {
    if (!asr) return;
    await asr.stop();
    asr = undefined;
  }

  async function retireTts() {
    if (!tts) return;
    await tts.stop();
    tts = undefined;
  }

  async function startCapture({ engineId } = {}) {
    assertOpen();
    if (captureController) throw fail('VOICE_CAPTURE_ACTIVE', '已有录音正在进行');
    const controller = captureController = new AbortController();
    return captureOperation(async () => {
      try {
        const assets = await resolveAssets('asr', engineId);
        if (controller.signal.aborted) throw aborted();
        if (asr?.dead() || (asr && asr.proof !== assets.proof)) await retireAsr();
        if (!asr) {
          asr = makeWorker({ kind: 'asr', assets, supervisor });
          asr.proof = assets.proof;
          await asr.start(controller.signal);
        }
        await asr.result('capture', {}, controller.signal);
        captureActive = true;
      } catch (error) {
        captureController = undefined;
        await retireAsr();
        throw error;
      }
    });
  }

  function feedCapture({ pcm }) {
    if (!(pcm instanceof Uint8Array) || !pcm.byteLength || pcm.byteLength % 2 || pcm.byteLength > 32000) {
      throw fail('VOICE_AUDIO_INVALID', '录音数据必须为 16kHz 单声道 PCM16');
    }
    const data = Buffer.from(pcm).toString('base64');
    return captureOperation(async () => {
      if (!captureActive) throw fail('VOICE_CAPTURE_INACTIVE', '录音会话已结束');
      const row = await asr.result('feed', { pcm: data }, captureController.signal);
      return { partial: recognitionText(row.partial), endpoint: row.endpoint === true, limit: row.limit === true };
    });
  }

  function finishCapture() {
    return captureOperation(async () => {
      if (!captureActive) throw fail('VOICE_CAPTURE_INACTIVE', '录音会话已结束');
      try {
        const row = await asr.result('finish', {}, captureController.signal);
        return { text: recognitionText(row.text) };
      } catch (error) {
        await retireAsr();
        throw error;
      } finally {
        captureActive = false;
        captureController = undefined;
      }
    });
  }

  function cancelCapture() {
    const active = captureController;
    active?.abort();
    return captureOperation(async () => {
      if (!active) return;
      captureActive = false;
      if (captureController === active) captureController = undefined;
      // Abort can leave an outstanding stream reply. Never attach a later
      // capture to a channel whose previous sequence is unconfirmed.
      await retireAsr();
    });
  }

  async function* speak({ engine, characterId, profileId, profileVersion, text, instruction = '', performance, referenceStyle, signal }) {
    assertOpen();
    if (!engines.has(engine) || typeof text !== 'string' || !text.trim() || Array.from(text).length > 240 ||
        typeof instruction !== 'string' || Array.from(instruction).length > 500) throw fail('VOICE_TTS_INVALID', '配音请求无效');
    if (speakController) throw fail('VOICE_TTS_BUSY', '配音组件正在处理上一段');
    const controller = speakController = new AbortController();
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    let completed = false;
    try {
      if (combined.aborted) throw aborted();
      const reference = await resolveProfile({ characterId, profileId, profileVersion, engine, performance, referenceStyle });
      const assets = await resolveAssets(engine);
      await engineOperation(async () => {
        if (combined.aborted) throw aborted();
        if (tts && (tts.dead() || tts.kind !== engine || tts.proof !== assets.proof)) await retireTts();
        if (!tts) {
          tts = makeWorker({ kind: engine, assets, supervisor });
          tts.proof = assets.proof;
          await tts.start(combined);
        }
      });
      yield { type: 'reference', style: reference.referenceStyle, source: reference.referenceSource };
      for await (const event of tts.request('speak', {
        text, instruction, reference: { path: reference.path, text: reference.text, language: reference.language },
      }, combined, 120000)) {
        if (event.type === 'pcm') {
          if (!Number.isSafeInteger(event.sample_rate) || event.sample_rate < 8000 || event.sample_rate > 192000 ||
              typeof event.pcm !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(event.pcm)) throw fail('VOICE_PCM_INVALID', '配音组件返回了无效音频');
          const pcm = Buffer.from(event.pcm, 'base64');
          if (!pcm.length || pcm.length % 2) throw fail('VOICE_PCM_INVALID', '配音组件返回了无效音频');
          yield { type: 'pcm', pcm, sampleRate: event.sample_rate, elapsed: event.elapsed };
        } else {
          const { id, type, ...metrics } = event;
          completed = true;
          yield { type: 'done', metrics };
        }
      }
    } finally {
      try { if (!completed) await engineOperation(retireTts); }
      finally { speakController = undefined; }
    }
  }

  function stopEngine() {
    speakController?.abort();
    return engineOperation(retireTts);
  }

  async function close() {
    closed = true;
    captureController?.abort();
    speakController?.abort();
    const results = await Promise.allSettled([captureOperation(retireAsr), engineOperation(retireTts)]);
    for (const result of results) if (result.status === 'rejected') throw result.reason;
  }

  return { startCapture, feedCapture, finishCapture, cancelCapture, speak, stopEngine, close };
}
