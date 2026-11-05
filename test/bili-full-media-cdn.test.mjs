import test from 'node:test';
import assert from 'node:assert/strict';
import {createBiliFullMedia} from '../src/buddy-plugin-services/bili-full-media.mjs';

const sliceSize=8*1024*1024;
const mcdn='https://xy-test.mcdn.bilivideo.cn:8082/v1/resource/video.m4s?os=mcdn&sig=test%2Btoken';
const edge='https://xx-test.edge.mountaintoys.cn:4483/video.m4s?sig=edge%2Btoken';
const upos='https://upos-test.bilivideo.com/video.m4s?sig=upos%2Btoken';
const genericWorkerError='BILI_FULL_ORIGINAL_UNAVAILABLE';
const decoder=new URL('data:text/javascript,'+encodeURIComponent(`
  import assert from 'node:assert/strict';
  import {parentPort,workerData} from 'node:worker_threads';
  try {
    const reply=await fetch(workerData.url,{headers:{range:'bytes=0-'}});
    assert.equal(reply.status,206);
    const bytes=new Uint8Array(await reply.arrayBuffer());
    assert.equal(bytes.length,workerData.config.expectedBytes);
    assert.equal(bytes[0],0x61);
    if(bytes.length>${sliceSize}){
      assert.equal(bytes[${sliceSize}-1],0x61);
      assert.equal(bytes[${sliceSize}],0x62);
      assert.equal(bytes.at(-1),0x62);
    }
    parentPort.postMessage({type:'done',emitted:0});
  } catch {
    parentPort.postMessage({type:'error',code:'${genericWorkerError}'});
  } finally {
    parentPort.close();
  }
`));

function partial(from,to,total){
  const bytes=new Uint8Array(to-from+1).fill(from>=sliceSize?0x62:0x61);
  return new Response(bytes,{status:206,headers:{
    'content-range':`bytes ${from}-${to}/${total}`,
    'content-length':String(bytes.length),
    'content-type':'video/mp4',
  }});
}

function fixture(t,{tracks,total=3115861,reply,signal}={}){
  const attempts=[],diagnostics=[];
  const acquire=createBiliFullMedia({
    playback:async()=>({timelength:6000,dash:{video:tracks}}),
    resolveVerifiedExecutable:async()=>({executable:'test-decoder'}),
    workerPath:decoder,
    emitDiagnostic:row=>diagnostics.push(row),
    fetchImpl:async(url,options)=>{
      const headers=new Headers(options.headers);
      const range=headers.get('range');
      attempts.push({url:String(url),range});
      assert.equal(options.redirect,'error');
      assert.equal(headers.has('cookie'),false);
      const bounds=/^bytes=(\d+)-(\d+)$/.exec(range);
      assert.ok(bounds,`unexpected Range ${range}`);
      const from=Number(bounds[1]),to=Number(bounds[2]);
      return reply?.({url:String(url),range,from,to,signal:options.signal})??partial(from,to,total);
    },
  });
  return {attempts,diagnostics,run:()=>acquire({
    scope:{},video:{duration:6,cid:123},config:{expectedBytes:total},sheets:[],
    signal:signal?AbortSignal.any([signal,t.signal]):t.signal,onSheet:async()=>{},
  })};
}

test('uses HTTPS CDN addresses with the reported host and port pairs',async t=>{
  for(const url of [mcdn,edge])await t.test(new URL(url).host,async st=>{
    const f=fixture(st,{tracks:[{baseUrl:url,bandwidth:100}]});
    await f.run();
    assert.deepEqual(f.attempts,[{url,range:'bytes=0-0'},{url,range:'bytes=0-3115860'}]);
  });
});

test('tries the same track HTTPS 443 backup before mcdn and keeps the next usable CDN pinned',async t=>{
  const anotherTrack='https://upos-other.bilivideo.com/different-encode.m4s';
  const invalid='https://xy-test.mcdn.bilivideo.cn:9999/not-permitted.m4s';
  const f=fixture(t,{
    tracks:[{base_url:mcdn,backup_url:[invalid,upos,mcdn],bandwidth:100},{baseUrl:anotherTrack,bandwidth:200}],
    reply:({url})=>url===upos?new Response(null,{status:403}):undefined,
  });
  await f.run();
  assert.deepEqual(f.attempts,[
    {url:upos,range:'bytes=0-0'},
    {url:mcdn,range:'bytes=0-0'},
    {url:mcdn,range:'bytes=0-3115860'},
  ]);
  assert.deepEqual(f.diagnostics,[{stage:'probe',node:'standard',port:443,status:403,attempt:1,code:'BILI_FULL_MEDIA_HTTP'}]);
});

test('does not fetch addresses with an unapproved host and port combination',async t=>{
  const f=fixture(t,{tracks:[{baseUrl:'https://upos-test.bilivideo.com:8082/video.m4s',bandwidth:100}]});
  await assert.rejects(f.run(),{code:'BILI_FULL_MEDIA_ORIGIN'});
  assert.deepEqual(f.attempts,[]);
});

test('keeps large streams in bounded contiguous ranges and clamps the last request to EOF',async t=>{
  const f=fixture(t,{tracks:[{baseUrl:upos,bandwidth:100}],total:sliceSize+5});
  await f.run();
  assert.deepEqual(f.attempts.map(x=>x.range),['bytes=0-0',`bytes=0-${sliceSize-1}`,`bytes=${sliceSize}-${sliceSize+4}`]);
});

test('reports the pinned upstream range failure instead of a generic decoder error',async t=>{
  const cases={
    '200 with a plausible Content-Range':()=>new Response(new Uint8Array(4),{status:200,headers:{'content-range':'bytes 0-3/4'}}),
    'changed total':()=>partial(0,3,5),
    'short body':()=>new Response(new Uint8Array(3),{status:206,headers:{'content-range':'bytes 0-3/4'}}),
  };
  for(const [name,response] of Object.entries(cases))await t.test(name,async st=>{
    const spare='https://upos-backup.bilivideo.com/video.m4s';
    const f=fixture(st,{
      tracks:[{baseUrl:upos,backupUrl:[spare],bandwidth:100}],total:4,
      reply:({range})=>range==='bytes=0-0'?undefined:response(),
    });
    await assert.rejects(f.run(),{code:'BILI_FULL_PROXY_RANGE'});
    assert.deepEqual(f.attempts,[{url:upos,range:'bytes=0-0'},{url:upos,range:'bytes=0-3'}]);
  });
});

test('cancellation during CDN selection propagates without trying a backup',async t=>{
  const ctl=new AbortController();
  const reason=Object.assign(new Error('Fixture pause'),{code:'TEST_BILI_PAUSE'});
  const f=fixture(t,{
    tracks:[{baseUrl:upos,backupUrl:[mcdn],bandwidth:100}],signal:ctl.signal,
    reply:({signal})=>{ctl.abort(reason);signal.throwIfAborted();},
  });
  await assert.rejects(f.run(),{code:'TEST_BILI_PAUSE'});
  assert.deepEqual(f.attempts,[{url:upos,range:'bytes=0-0'}]);
});
