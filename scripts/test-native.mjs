import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

// Compiles a disposable Swift harness, chooses a loopback port, and always stops
// the harness. Requires macOS + Swift and an existing `npm run build` output.
const project = fileURLToPath(new URL('..', import.meta.url));
await access(join(project, 'dist/index.html')).catch(() => {
  throw new Error('Web build missing. Run npm run build before this test.');
});
const scratch = await mkdtemp(join(tmpdir(), 'conpera-native-test-'));
let server;
let count = 0;
const check = (condition, label) => {
  assert.ok(condition, label);
  count += 1;
  console.log(`PASS: ${label}`);
};

async function compile() {
  const compiler = spawn('swiftc', [
    '-swift-version', '6',
    join(project, 'native/LocalDemoServer.swift'),
    join(project, 'native/tests/main.swift'),
    '-o', join(scratch, 'native-test-server'),
  ], { cwd: project, stdio: 'inherit' });
  const [code, signal] = await once(compiler, 'exit');
  assert.equal(code, 0, `Swift compile failed (${signal ?? code})`);
}

async function startServer() {
  server = spawn(join(scratch, 'native-test-server'), [join(project, 'dist')], {
    cwd: project, stdio: ['ignore', 'pipe', 'pipe'],
  });
  return await new Promise((resolve, reject) => {
    let output = '';
    let errors = '';
    const timer = setTimeout(() => reject(new Error('Native server startup timed out.')), 10_000);
    const done = (error, value) => {
      clearTimeout(timer);
      server.off('exit', earlyExit);
      server.off('error', failed);
      server.stdout.off('data', read);
      error ? reject(error) : resolve(value);
    };
    const earlyExit = code => done(new Error(`Native server exited (${code}): ${errors}`));
    const failed = error => done(error);
    const read = data => {
      output += data.toString();
      const match = output.match(/^http:\/\/127\.0\.0\.1:\d+\/$/m);
      if (match) done(null, new URL(match[0]));
    };
    server.stderr.on('data', data => { errors += data.toString(); });
    server.stdout.on('data', read);
    server.once('exit', earlyExit);
    server.once('error', failed);
  });
}

async function stopServer() {
  if (!server || server.exitCode !== null || server.signalCode !== null) return;
  const exit = once(server, 'exit');
  server.kill('SIGTERM');
  const result = await Promise.race([exit.then(() => true), delay(2_000).then(() => false)]);
  if (!result) {
    server.kill('SIGKILL');
    await exit;
  }
}

try {
  await compile();
  const base = await startServer();
  const port = Number(base.port);
  const origin = base.origin;

  function request(method, path, { payload, cookie, suppliedOrigin = origin } = {}) {
    return new Promise((resolve, reject) => {
      const headers = { Connection: 'close' };
      if (!['GET', 'HEAD'].includes(method)) headers.Origin = suppliedOrigin;
      if (cookie) headers.Cookie = cookie;
      const body = payload === undefined ? undefined : JSON.stringify(payload);
      if (body !== undefined) {
        headers['Content-Type'] = 'application/json';
        headers['Content-Length'] = Buffer.byteLength(body);
      }
      const req = httpRequest({ hostname: '127.0.0.1', port, path, method, headers }, response => {
        const chunks = [];
        response.on('data', data => chunks.push(data));
        response.on('error', reject);
        response.on('end', () => {
          try {
            const bytes = Buffer.concat(chunks);
            const parsed = response.headers['content-type']?.startsWith('application/json')
              ? JSON.parse(bytes.toString()) : bytes;
            resolve({ status: response.statusCode, body: parsed, headers: response.headers });
          } catch (error) { reject(error); }
        });
      });
      req.setTimeout(5_000, () => req.destroy(new Error('HTTP request timed out.')));
      req.on('error', reject);
      req.end(body);
    });
  }

  function rawRequest(wire, fragmented = false) {
    return new Promise((resolve, reject) => {
      const socket = connect({ host: '127.0.0.1', port });
      const chunks = [];
      socket.setTimeout(5_000, () => socket.destroy(new Error('Raw HTTP request timed out.')));
      socket.on('error', reject);
      socket.on('data', data => chunks.push(data));
      socket.on('end', () => {
        const bytes = Buffer.concat(chunks);
        const status = Number(bytes.toString('ascii', 0, 40).split(' ')[1]);
        resolve({ status, bytes });
      });
      socket.on('connect', async () => {
        try {
          if (!fragmented) { socket.write(wire); return; }
          for (let offset = 0; offset < wire.length; offset += 17) {
            socket.write(wire.subarray(offset, offset + 17));
            await delay(2);
          }
        } catch (error) { socket.destroy(); reject(error); }
      });
    });
  }

  const page = await request('GET', '/');
  check(page.status === 200 && page.body.includes(Buffer.from('<html')) && page.headers.connection === 'close', 'bundled HTML and connection close');
  const head = await request('HEAD', '/');
  check(head.status === 200 && head.body.length === 0 && Number(head.headers['content-length']) === page.body.length, 'HEAD correct Content-Length');
  check((await request('GET', '/api/demo/session')).status === 401, 'unauthenticated session');
  check((await request('POST', '/api/demo/authorizations', { payload: {}, suppliedOrigin: `http://localhost:${port}` })).status === 403, 'strict Origin');
  check((await rawRequest(Buffer.from(`GET / HTTP/1.1\r\nHost: evil.test:${port}\r\n\r\n`))).status === 403, 'strict Host');
  check((await rawRequest(Buffer.from(`GET / HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Length: 0\r\nContent-Length: 0\r\n\r\n`))).status === 400, 'duplicate dangerous headers');
  check((await rawRequest(Buffer.from(`POST / HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n`))).status === 400, 'reject chunked');
  check((await rawRequest(Buffer.from(`POST / HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Length: 9223372036854775807\r\n\r\n`))).status === 413, 'oversized length cannot overflow');
  check((await request('GET', '/%2e%2e/package.json')).status === 400, 'encoded path traversal rejected');

  const verifier = 'a'.repeat(43);
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const state = 'b'.repeat(43);
  const payload = Buffer.from(JSON.stringify({ codeChallenge: challenge, state }));
  const wire = Buffer.concat([
    Buffer.from(`POST /api/demo/authorizations HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nOrigin: ${origin}\r\nContent-Type: application/json\r\nContent-Length: ${payload.length}\r\n\r\n`),
    payload,
  ]);
  const fragmented = await rawRequest(wire, true);
  const authorization = JSON.parse(fragmented.bytes.subarray(fragmented.bytes.indexOf('\r\n\r\n') + 4).toString());
  const authorizationPath = `/api/demo/authorizations/${authorization.requestId}`;
  check(fragmented.status === 201 && authorization.requestId.length === 43, 'fragmented request reassembled');
  check((await request('GET', authorizationPath)).body.state === state, 'authorization state read');
  const grant = await request('POST', `${authorizationPath}/approve`);
  check(grant.status === 200 && grant.body.state === state, 'approval code issued');
  check((await request('POST', `${authorizationPath}/approve`)).status === 409, 'repeat approval refused');
  const session = await request('POST', '/api/demo/session', { payload: { code: grant.body.code, codeVerifier: verifier } });
  const setCookie = session.headers['set-cookie']?.[0] ?? '';
  const cookie = setCookie.split(';')[0];
  check(session.status === 200 && ['HttpOnly', 'SameSite=Strict', 'Path=/api/demo'].every(flag => setCookie.includes(flag)), 'PKCE exchange HttpOnly session');
  check((await request('POST', '/api/demo/session', { payload: { code: grant.body.code, codeVerifier: verifier } })).status === 400, 'authorization code single use');
  check((await request('GET', '/api/demo/balance', { cookie })).body.balance === 128.5, 'authenticated mock balance');
  check((await request('POST', '/api/demo/session/expire', { cookie })).status === 204 && (await request('GET', '/api/demo/balance', { cookie })).status === 401, 'expiry revokes session');

  const second = await request('POST', '/api/demo/authorizations', { payload: { codeChallenge: challenge, state } });
  const secondGrant = await request('POST', `/api/demo/authorizations/${second.body.requestId}/approve`);
  check((await request('POST', '/api/demo/session', { payload: { code: secondGrant.body.code, codeVerifier: 'z'.repeat(43) } })).status === 400
    && (await request('POST', '/api/demo/session', { payload: { code: secondGrant.body.code, codeVerifier: verifier } })).status === 400, 'wrong verifier consumes code');
  check((await request('DELETE', '/api/demo/session', { cookie })).status === 204, 'logout clears session');
  console.log(`\n${count} native HTTP checks passed.`);
} finally {
  await stopServer();
  await rm(scratch, { recursive: true, force: true });
}
