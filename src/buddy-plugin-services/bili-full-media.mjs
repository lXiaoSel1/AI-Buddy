import {once} from 'node:events';
import {createServer} from 'node:http';
import {randomBytes} from 'node:crypto';
import {Worker} from 'node:worker_threads';
import {join} from 'node:path';
import {mediaCandidates,mediaUrl} from './bili-media-addresses.mjs';

const fail = code => Object.assign(Error(code), {code});
const chunkSize = 8 * 1024 * 1024;
const agent = 'Mozilla/5.0 AI-Buddy/2.0.2';

class RangeFailure extends Error {
  constructor(code, status) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

async function withRange(url, from, to, {signal, fetchImpl, timeout}, consume) {
  const deadline = AbortSignal.timeout(timeout);
  const active = AbortSignal.any([signal, deadline]);
  let response;
  try {
    active.throwIfAborted();
    response = await fetchImpl(url, {
      method:'GET',
      headers:{range:'bytes='+from+'-'+to, referer:'https://www.bilibili.com/', 'user-agent':agent, 'accept-encoding':'identity'},
      redirect:'error',
      signal:active,
    });
    active.throwIfAborted();
    if (response.status !== 206 && response.status !== 200) {
      throw new RangeFailure('BILI_FULL_MEDIA_HTTP', response.status);
    }
    const parts = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') ?? '');
    const [start, end, total] = parts ? parts.slice(1).map(Number) : [];
    const length = response.headers.get('content-length');
    const encoding = response.headers.get('content-encoding');
    if (response.status !== 206 || !response.body || ![start,end,total].every(Number.isSafeInteger) ||
        start !== from || end < from || end > to || end >= total ||
        (length !== null && (!/^\d+$/.test(length) || Number(length) !== end-from+1)) ||
        (encoding && encoding.toLowerCase() !== 'identity')) {
      throw new RangeFailure('BILI_FULL_PROXY_RANGE', response.status);
    }
    const result = await consume(response, {end,total}, active);
    active.throwIfAborted();
    return result;
  } catch (error) {
    signal.throwIfAborted();
    if (deadline.aborted) throw new RangeFailure('BILI_FULL_MEDIA_TIMEOUT', response?.status);
    if (error instanceof RangeFailure) throw error;
    throw new RangeFailure('BILI_FULL_MEDIA_NETWORK', response?.status);
  } finally {
    await response?.body?.cancel().catch(() => {});
  }
}

async function readRangeBody(response, length, signal, write) {
  let received = 0;
  for await (const bytes of response.body) {
    signal.throwIfAborted();
    received += bytes.length;
    if (received > length) throw new RangeFailure('BILI_FULL_PROXY_RANGE', response.status);
    if (write) await write(bytes);
  }
  if (received !== length) throw new RangeFailure('BILI_FULL_PROXY_RANGE', response.status);
}

async function selectSource(candidates, {signal, check, fetchImpl, report}) {
  let last = fail('BILI_FULL_MEDIA_ORIGIN');
  if (!candidates.length) report('address', null, 0, last);
  for (const [index, candidate] of candidates.entries()) {
    signal.throwIfAborted();
    await check?.();
    signal.throwIfAborted();
    try {
      const info = await withRange(candidate.url, 0, 0, {signal,fetchImpl,timeout:10000}, async (response,range,active) => {
        await readRangeBody(response, 1, active);
        const etag = response.headers.get('etag');
        return {total:range.total, etag:etag?.startsWith('"') ? etag : null};
      });
      signal.throwIfAborted();
      return {...candidate,...info,attempt:index+1};
    } catch (error) {
      signal.throwIfAborted();
      last = error;
      report('probe', candidate, index+1, error);
    }
  }
  throw last;
}

// One probed representation per decoder. The loopback server streams bounded ranges.
async function rangeProxy(source, {signal, check, fetchImpl, onFailure}) {
  const token = randomBytes(24).toString('hex');
  const requests = new Set();
  let failure = null;
  const server = createServer(async (req,res) => {
    if (req.url !== '/'+token || !['GET','HEAD'].includes(req.method) || requests.size >= 2 || failure) {
      res.writeHead(503).end();
      return;
    }
    const requested = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? 'bytes=0-');
    const start = Number(requested?.[1]);
    const end = requested?.[2] ? Math.min(Number(requested[2]), source.total-1) : source.total-1;
    if (!requested || !Number.isSafeInteger(start) || (requested[2] && !Number.isSafeInteger(Number(requested[2]))) || start > end) {
      res.writeHead(416, {'content-range':'bytes */'+source.total}).end();
      return;
    }

    const controller = new AbortController();
    requests.add(controller);
    const stop = () => controller.abort();
    req.once('aborted',stop);
    res.once('close',stop);
    const combined = AbortSignal.any([signal,controller.signal]);
    const headers = {
      'content-type':'video/mp4',
      'accept-ranges':'bytes',
      'content-range':'bytes '+start+'-'+end+'/'+source.total,
      'content-length':end-start+1,
      'cache-control':'no-store',
    };
    try {
      let offset = start;
      do {
        combined.throwIfAborted();
        await check?.();
        combined.throwIfAborted();
        if (req.method === 'HEAD') {
          res.writeHead(206,headers);
          break;
        }
        const last = offset + Math.min(chunkSize-1,end-offset);
        offset = await withRange(source.url, offset, last, {signal:combined,fetchImpl,timeout:65000}, async (response,range,active) => {
          const etag = response.headers.get('etag');
          if (range.total !== source.total || (source.etag && etag && etag !== source.etag)) {
            throw new RangeFailure('BILI_FULL_PROXY_RANGE', response.status);
          }
          if (!res.headersSent) res.writeHead(206,headers);
          await readRangeBody(response, range.end-offset+1, active, async bytes => {
            if (!res.write(bytes)) await once(res,'drain',{signal:active});
          });
          return range.end+1;
        });
      } while (offset <= end);
      res.end();
    } catch (error) {
      if (!combined.aborted && !failure) {
        failure = error;
        onFailure(error);
      }
      if (!res.headersSent && !res.destroyed) res.writeHead(503).end();
      else res.destroy();
    } finally {
      requests.delete(controller);
      req.off('aborted',stop);
      res.off('close',stop);
    }
  });
  await new Promise((resolve,reject) => {
    server.once('error',reject);
    server.listen(0,'127.0.0.1',resolve);
  });
  return {
    url:'http://127.0.0.1:'+server.address().port+'/'+token,
    get failure() { return failure; },
    async close() {
      for (const controller of requests) controller.abort();
      const closed = new Promise(resolve => server.close(resolve));
      server.closeAllConnections();
      await closed;
    },
  };
}

export function createBiliFullMedia({tools,playback,validateUrl=mediaUrl,fetchImpl=fetch,workerPath,resolveVerifiedExecutable,emitDiagnostic=()=>{}}) {
  let active = false;
  return async function fullSampling({scope,video,config,sheets,signal,check,onSheet,stopAfterSheets}) {
    if (active) throw fail('BILI_MEDIA_BUSY');
    active = true;
    let proxy, worker;
    const lifetime = new AbortController();
    const combined = AbortSignal.any([signal,lifetime.signal].filter(Boolean));
    const guard = async () => {
      combined.throwIfAborted();
      await check?.();
      combined.throwIfAborted();
    };
    const report = (stage, candidate, attempt, error) => {
      const status = error instanceof RangeFailure ? error.status : null;
      try { emitDiagnostic({stage,node:candidate?.node??null,port:candidate?.port??null,status:status??null,attempt,code:error.code}); }
      catch {}
    };
    try {
      await guard();
      const verified = resolveVerifiedExecutable ? await resolveVerifiedExecutable({signal:combined}) : {executable:join(tools,'ffmpeg.exe')};
      await guard();
      const data = await playback({scope,video,signal:combined});
      if (!data || data.is_preview || !(data.timelength > 0) || Math.abs(data.timelength/1000-video.duration) > 4) {
        throw fail('BILI_FULL_ORIGINAL_UNAVAILABLE');
      }
      const tracks = [...(data.dash?.video ?? [])].filter(track => track.baseUrl || track.base_url)
        .sort((a,b) => (a.bandwidth??0)-(b.bandwidth??0));
      const mux = data.durl?.length === 1 && /mp4/i.test(data.format??'') ? data.durl[0] : null;
      const source = await selectSource(mediaCandidates(tracks[0]??mux,validateUrl), {signal:combined,check,fetchImpl,report});
      let rejectUpstream;
      proxy = await rangeProxy(source,{
        signal:combined,check,fetchImpl,
        onFailure(error) {
          if (error instanceof RangeFailure) report('stream',source,source.attempt,error);
          rejectUpstream?.(error);
        },
      });
      await guard();
      const executable = resolveVerifiedExecutable ? (await resolveVerifiedExecutable({signal:combined})).executable : verified.executable;
      await guard();
      if (executable !== verified.executable) throw fail('FFMPEG_COMPONENT_CHANGED');
      worker = new Worker(workerPath??new URL('./bili-full-media-worker.mjs',import.meta.url),{
        workerData:{executable,url:proxy.url,duration:video.duration,config,sheets,stopAfterSheets},
      });

      return await new Promise((resolve,reject) => {
        let settled = false;
        let chain = Promise.resolve();
        const finish = (fn,value) => {
          if (settled) return;
          settled = true;
          combined.removeEventListener('abort',abort);
          fn(value);
        };
        const abort = () => finish(reject,combined.reason??fail('BILI_FULL_PAUSED'));
        const failWorker = error => { void chain.then(() => finish(reject,proxy.failure??error)); };
        rejectUpstream = failWorker;
        combined.addEventListener('abort',abort,{once:true});
        if (combined.aborted) abort();
        worker.on('message',msg => {
          if (settled) return;
          if (msg.type === 'sheet') {
            chain = chain.then(async () => {
              await guard();
              if (proxy.failure) throw proxy.failure;
              await onSheet({...msg.sheet,png:Buffer.from(msg.sheet.png)});
              if (!settled && !combined.aborted) worker.postMessage({type:'ack',sequence:msg.sequence});
            }).catch(error => finish(reject,error));
          } else if (msg.type === 'done') {
            void chain.then(() => {
              if (proxy.failure) finish(reject,proxy.failure);
              else finish(resolve,{visual:'original-video',audio:'unavailable',emitted:msg.emitted,transcript:[]});
            });
          } else if (msg.type === 'error') failWorker(fail(msg.code));
        });
        worker.once('error',failWorker);
        worker.once('exit',code => failWorker(fail(code?'BILI_FULL_DECODE_INCOMPLETE':'BILI_FULL_FRAMES_MISSING')));
      });
    } catch (error) {
      if(error.name==='TimeoutError')throw fail('BILI_FULL_MEDIA_TIMEOUT');
      if (combined.aborted || (typeof error.code==='string'&&error.code.startsWith('FFMPEG_COMPONENT_')) || (typeof error.code==='string'&&error.code.startsWith('BILI_FULL_'))) throw error;
      throw fail('BILI_FULL_ORIGINAL_UNAVAILABLE');
    } finally {
      lifetime.abort();
      try {
        if (worker && worker.threadId !== -1) {
          let timer;
          const exited = new Promise(resolve => worker.once('exit',resolve));
          try {
            worker.postMessage({type:'abort'});
            await Promise.race([exited,new Promise(resolve => { timer = setTimeout(resolve,2000); })]);
          } finally {
            clearTimeout(timer);
            if (worker.threadId !== -1) await worker.terminate();
          }
        }
      } finally {
        try { await proxy?.close(); } finally { active = false; }
      }
    }
  };
}
