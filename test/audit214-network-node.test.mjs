import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import {gzipSync} from 'node:zlib';
import {createNodeNetworkFetch} from '../src/network-node.mjs';

// Synthetic loopback-only certificate/key, generated for this fixture. It is
// deliberately public test material and never used outside these local servers.
const fixtureKey = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgM9gUteNmLUAa/5TZ
Ojqtd7jj5PK4XCyMOtYWOfWClXuhRANCAARrOwGKi5LiqlL2sN+cD9O01IXToWby
u98H3XdbVAHH1/EjYJ/QfEvsbQr59tdiPmYCs3GDhOUHEijOVoe2riTl
-----END PRIVATE KEY-----`;
const fixtureCert = `-----BEGIN CERTIFICATE-----
MIIBujCCAV+gAwIBAgIUeX49Vh0i5HxCVqlic81BKnhDkMwwCgYIKoZIzj0EAwIw
JDEiMCAGA1UEAwwZYXVkaXQyMTQtbG9vcGJhY2stZml4dHVyZTAeFw0yNjExMTAw
NDE5NDdaFw0zNjExMDcwNDE5NDdaMCQxIjAgBgNVBAMMGWF1ZGl0MjE0LWxvb3Bi
YWNrLWZpeHR1cmUwWTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAARrOwGKi5LiqlL2
sN+cD9O01IXToWbyu98H3XdbVAHH1/EjYJ/QfEvsbQr59tdiPmYCs3GDhOUHEijO
Voe2riTlo28wbTAdBgNVHQ4EFgQUWRyV00XlNDfBUaMUdWw9P29G+AkwHwYDVR0j
BBgwFoAUWRyV00XlNDfBUaMUdWw9P29G+AkwDwYDVR0TAQH/BAUwAwEB/zAaBgNV
HREEEzARhwR/AAABgglsb2NhbGhvc3QwCgYIKoZIzj0EAwIDSQAwRgIhAO3I9Oq2
f6YIqqp3gt8EflCDmvgGQAJDRdXDXXhUPaWlAiEAk57Tc+BBuaLSPgC0JTOCgisn
9LwzYYh57AiTSzXZyaE=
-----END CERTIFICATE-----`;

// These fixtures expose wire behavior through real loopback servers. The only
// product seam under test is the public createNodeNetworkFetch() result.
async function listenServer(t, server, protocol = 'http') {
  const sockets = new Set();
  server.on('connection', socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  });
  return {server, url: `${protocol}://127.0.0.1:${server.address().port}`};
}

const serve = (t, handler) => listenServer(t, http.createServer(handler));

async function echoRequest(req, res) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({
    method: req.method,
    headers: req.headers,
    body: Buffer.concat(chunks).toString('utf8'),
    bytes: Buffer.concat(chunks).length,
  }));
}

async function serveProxy(t) {
  const hits = [];
  const {server, url} = await serve(t, (req, res) => {
    hits.push({method: req.method, url: req.url});
    const upstream = http.request(req.url, {method: req.method, headers: req.headers}, reply => {
      res.writeHead(reply.statusCode, reply.headers);
      reply.pipe(res);
    });
    upstream.on('error', error => res.destroy(error));
    req.pipe(upstream);
  });
  const tunnels = new Set();
  t.after(() => { for (const socket of tunnels) socket.destroy(); });
  server.on('connect', (req, socket, head) => {
    hits.push({method: req.method, url: req.url});
    const target = new URL(`http://${req.url}`);
    const upstream = net.connect(Number(target.port), target.hostname, () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    tunnels.add(upstream);
    upstream.once('close', () => tunnels.delete(upstream));
    upstream.on('error', error => socket.destroy(error));
    socket.once('close', () => upstream.destroy());
  });
  return {url, hits};
}

test('F7a buffered POST bodies carry their byte Content-Length on the wire', {timeout: 5000}, async t => {
  const {url} = await serve(t, echoRequest);
  const adapter = createNodeNetworkFetch();
  const cases = [
    {name: 'Buffer', body: () => Buffer.from('abc'), text: 'abc', length: '3'},
    {name: 'empty POST', body: () => undefined, text: '', length: '0'},
    {name: 'multibyte string', body: () => '鲸鱼', text: '鲸鱼', length: '6'},
    {name: 'URL-encoded form', body: () => new URLSearchParams({message: '鲸 鱼', answer: '42'}),
      text: 'message=%E9%B2%B8+%E9%B1%BC&answer=42', length: '37'},
  ];
  for (const entry of cases) {
    await t.test(entry.name, async t => {
      const control = await (await fetch(`${url}/native`, {method: 'POST', body: entry.body()})).json();
      assert.equal(control.headers['content-length'], entry.length, 'Node 24 native fetch control');
      const observed = await (await adapter(`${url}/adapter`, {method: 'POST', body: entry.body()})).json();
      t.diagnostic(JSON.stringify({native: control, adapter: observed}));
      assert.equal(observed.body, entry.text);
      assert.equal(String(observed.bytes), entry.length);
      assert.equal(observed.headers['content-length'], entry.length);
      assert.equal(observed.headers['transfer-encoding'], undefined);
    });
  }
});

test('F7b default fetch request headers reach the origin through a real proxy', {timeout: 5000}, async t => {
  const origin = await serve(t, echoRequest);
  const proxy = await serveProxy(t);
  const adapter = createNodeNetworkFetch({resolveRoute: async () => [{kind: 'http', url: proxy.url}]});
  const observed = await (await adapter(`${origin.url}/defaults`)).json();
  t.diagnostic(JSON.stringify({proxyHits: proxy.hits, observed}));
  assert.equal(proxy.hits.length, 1, 'request must traverse the real proxy');
  assert.deepEqual({
    userAgent: observed.headers['user-agent'],
    accept: observed.headers.accept,
    acceptEncoding: observed.headers['accept-encoding'],
  }, {userAgent: 'node', accept: '*/*', acceptEncoding: 'gzip, deflate'});
});

test('F7b explicit request headers survive the adapter and proxy', {timeout: 5000}, async t => {
  const origin = await serve(t, echoRequest);
  const proxy = await serveProxy(t);
  const adapter = createNodeNetworkFetch({resolveRoute: async () => [{kind: 'http', url: proxy.url}]});
  const observed = await (await adapter(`${origin.url}/explicit`, {headers: {
    'User-Agent': 'audit214-synthetic', Accept: 'application/json', 'Accept-Encoding': 'identity',
  }})).json();
  assert.equal(proxy.hits.length, 1);
  assert.deepEqual({
    userAgent: observed.headers['user-agent'],
    accept: observed.headers.accept,
    acceptEncoding: observed.headers['accept-encoding'],
  }, {userAgent: 'audit214-synthetic', accept: 'application/json', acceptEncoding: 'identity'});
});

test('F7b an explicit adapter userAgent fills only a missing request User-Agent', {timeout: 5000}, async t => {
  const origin = await serve(t, echoRequest);
  const adapter = createNodeNetworkFetch({userAgent: 'AI-Buddy/214-synthetic'});
  const defaults = await (await adapter(`${origin.url}/service-default`)).json();
  const explicit = await (await adapter(`${origin.url}/request-override`, {headers: {'User-Agent': 'request-override'}})).json();
  assert.deepEqual([defaults.headers['user-agent'], explicit.headers['user-agent']], ['AI-Buddy/214-synthetic', 'request-override']);
});

test('F7d Response exposes its final URL and actual redirect-follow state', {timeout: 5000}, async t => {
  const origin = await serve(t, (req, res) => {
    if (req.url === '/start') res.writeHead(302, {location: '/final'}).end();
    else res.end('final response');
  });
  const adapter = createNodeNetworkFetch();
  for (const entry of [
    {path: '/final', redirect: 'follow', expectedPath: '/final', status: 200, redirected: false},
    {path: '/start', redirect: 'follow', expectedPath: '/final', status: 200, redirected: true},
    {path: '/start', redirect: 'manual', expectedPath: '/start', status: 302, redirected: false},
  ]) {
    await t.test(`${entry.path} (${entry.redirect})`, async t => {
      const response = await adapter(`${origin.url}${entry.path}`, {redirect: entry.redirect});
      const cloned = response.clone();
      await cloned.text();
      await response.text();
      const observed = {url: response.url, redirected: response.redirected, status: response.status};
      t.diagnostic(JSON.stringify(observed));
      assert.deepEqual(observed, {
        url: `${origin.url}${entry.expectedPath}`, redirected: entry.redirected, status: entry.status,
      });
      assert.deepEqual({url: cloned.url, redirected: cloned.redirected}, {
        url: `${origin.url}${entry.expectedPath}`, redirected: entry.redirected,
      }, 'public Response.clone preserves fetch metadata');
    });
  }
});

test('F7d cross-origin redirects continue to strip synthetic credentials', {timeout: 5000}, async t => {
  const destination = await serve(t, echoRequest);
  const origin = await serve(t, (_, res) => res.writeHead(302, {location: `${destination.url}/final`}).end());
  const proxy = await serveProxy(t);
  const adapter = createNodeNetworkFetch({resolveRoute: async () => [{kind: 'http', url: proxy.url}]});
  const response = await adapter(`${origin.url}/start`, {headers: {
    Authorization: 'Bearer synthetic-audit214', Cookie: 'synthetic=214',
    'Proxy-Authorization': 'Basic c3ludGhldGlj', 'X-Audit': '214',
  }});
  const observed = await response.json();
  assert.equal(proxy.hits.length, 2);
  assert.equal(observed.headers.authorization, undefined);
  assert.equal(observed.headers.cookie, undefined);
  assert.equal(observed.headers['proxy-authorization'], undefined);
  assert.equal(observed.headers['x-audit'], '214');
});

async function timeoutOutcome(t, adapter, url) {
  const controller = new AbortController();
  // Fixture watchdog only: it makes the currently missing product timeout go
  // red quickly, without giving the production request a total-time deadline.
  const guard = setTimeout(() => controller.abort(Object.assign(new Error('Fixture watchdog: adapter did not time out'), {
    code: 'TEST_WATCHDOG',
  })), 400);
  const started = performance.now();
  let error;
  try {
    const response = await adapter(url, {signal: controller.signal});
    await response.body?.cancel();
  } catch (cause) {
    error = cause;
  } finally {
    clearTimeout(guard);
  }
  const elapsedMs = performance.now() - started;
  t.diagnostic(JSON.stringify({elapsedMs, error: {name: error?.name, code: error?.code, technical: error?.technical}}));
  return {error, elapsedMs};
}

async function assertPeerClosed(closed) {
  let guard;
  const observed = await Promise.race([
    closed,
    new Promise(resolve => {guard = setTimeout(() => resolve(false), 150);}),
  ]);
  clearTimeout(guard);
  assert.equal(observed, true, 'timeout must close the real pending socket promptly');
}

test('F7c configured connection deadline covers a stalled real TLS handshake', {timeout: 3000}, async t => {
  let accepted = 0, clientHelloBytes = 0;
  let closePeer;
  const closed = new Promise(resolve => {closePeer = resolve;});
  const {url} = await listenServer(t, net.createServer(socket => {
    accepted++;
    socket.once('close', () => closePeer(true));
    socket.on('data', chunk => {clientHelloBytes += chunk.length;});
  }), 'https');
  const adapter = createNodeNetworkFetch({connectTimeoutMs: 60, headersTimeoutMs: 2000});
  const {error, elapsedMs} = await timeoutOutcome(t, adapter, url);
  assert.equal(accepted, 1, 'fixture must accept a real TCP connection');
  assert.ok(clientHelloBytes > 0, 'TLS negotiation must actually start');
  assert.equal(error?.code, 'NETWORK_TIMEOUT');
  assert.ok(elapsedMs < 300, 'connection timeout must occur before the fixture watchdog');
  await assertPeerClosed(closed);
});

test('F7c configured connection deadline covers a stalled proxy CONNECT handshake', {timeout: 3000}, async t => {
  let connects = 0;
  const timers = new Set();
  let closePeer;
  const closed = new Promise(resolve => {closePeer = resolve;});
  t.after(() => { for (const timer of timers) clearTimeout(timer); });
  const proxy = await serve(t, (_, res) => res.end());
  proxy.server.on('connect', (_, socket) => {
    connects++;
    socket.once('close', () => closePeer(true));
    socket.resume(); // Observe peer EOF even while the fixture withholds CONNECT's reply.
    socket.once('end', () => socket.end()); // Upgraded HTTP sockets may allow half-open writes.
    // Node's native proxy Agent can still be acquiring its socket when an
    // AbortSignal fires. Release this intentionally silent fixture connection
    // after the watchdog too, so a broken adapter cannot hang the test runner.
    timers.add(setTimeout(() => socket.destroy(), 500));
  });
  const adapter = createNodeNetworkFetch({
    connectTimeoutMs: 60, headersTimeoutMs: 2000,
    resolveRoute: async () => [{kind: 'http', url: proxy.url}],
  });
  const {error, elapsedMs} = await timeoutOutcome(t, adapter, 'https://127.0.0.1:443/fixture');
  assert.equal(connects, 1, 'fixture must receive the real CONNECT request');
  assert.equal(error?.code, 'NETWORK_TIMEOUT');
  assert.ok(elapsedMs < 300, 'proxy handshake timeout must occur before the fixture watchdog');
  await assertPeerClosed(closed);
});

test('F7c configured response-headers deadline rejects a silent HTTP origin', {timeout: 3000}, async t => {
  let requests = 0;
  let closePeer;
  const closed = new Promise(resolve => {closePeer = resolve;});
  const origin = await serve(t, req => {
    requests++;
    req.socket.once('close', () => closePeer(true));
  });
  const adapter = createNodeNetworkFetch({connectTimeoutMs: 60, headersTimeoutMs: 90});
  const {error, elapsedMs} = await timeoutOutcome(t, adapter, `${origin.url}/silent`);
  assert.equal(requests, 1, 'fixture must receive a real HTTP request');
  assert.equal(error?.code, 'NETWORK_TIMEOUT');
  assert.ok(elapsedMs < 300, 'headers timeout must occur before the fixture watchdog');
  await assertPeerClosed(closed);
});

test('F7c healthy slow response bodies survive connection and headers deadlines', {timeout: 3000}, async t => {
  const timers = new Set();
  t.after(() => { for (const timer of timers) clearTimeout(timer); });
  const origin = await serve(t, (_, res) => {
    res.writeHead(200, {'content-type': 'text/plain'});
    res.write('first/');
    timers.add(setTimeout(() => res.write('second/'), 130));
    timers.add(setTimeout(() => res.end('third'), 270));
  });
  const adapter = createNodeNetworkFetch({connectTimeoutMs: 60, headersTimeoutMs: 90});
  const controller = new AbortController();
  const guard = setTimeout(() => controller.abort(new Error('fixture stream watchdog')), 1500);
  t.after(() => clearTimeout(guard));
  const started = performance.now();
  const response = await adapter(`${origin.url}/slow`, {signal: controller.signal});
  assert.equal(await response.text(), 'first/second/third');
  assert.ok(performance.now() - started >= 250, 'body must remain healthy beyond both configured deadlines');
});

test('F7e gzip decoding keeps native-style encoding and length headers through real HTTPS CONNECT', {timeout: 5000}, async t => {
  const plain = 'synthetic gzip response';
  const compressed = gzipSync(plain);
  const origin = await listenServer(t, https.createServer({key: fixtureKey, cert: fixtureCert}, (_, res) => {
    res.writeHead(200, {'content-type': 'text/plain', 'content-encoding': 'gzip', 'content-length': compressed.length});
    res.end(compressed);
  }), 'https');
  const proxy = await serveProxy(t);
  const adapter = createNodeNetworkFetch({ca: fixtureCert, resolveRoute: async () => [{kind: 'http', url: proxy.url}]});
  const response = await adapter(`${origin.url}/gzip`);
  assert.equal(await response.text(), plain);
  assert.equal(response.headers.get('content-encoding'), 'gzip');
  assert.equal(response.headers.get('content-length'), String(compressed.length));
  assert.deepEqual(proxy.hits, [{method: 'CONNECT', url: new URL(origin.url).host}]);
});
