import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { createDemoServer } from './server.mjs';

const makeVerifier = () => randomBytes(32).toString('base64url');
const challenge = (verifier) => createHash('sha256').update(verifier).digest('base64url');

async function fixture(t, options = {}) {
  let timestamp = Date.parse('2026-10-06T00:00:00.000Z');
  const server = createDemoServer({ now: () => timestamp, ...options });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (path, { method = 'GET', body, cookie, origin = base, ...rest } = {}) => fetch(`${base}${path}`, {
    method,
    headers: { Origin: origin, ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
    ...rest,
  });
  const authorize = async () => {
    const verifier = makeVerifier();
    const state = makeVerifier();
    const created = await call('/api/demo/authorizations', { method: 'POST', body: { codeChallenge: challenge(verifier), state } });
    assert.equal(created.status, 201);
    const request = await created.json();
    const details = await call(`/api/demo/authorizations/${request.requestId}`);
    assert.deepEqual(await details.json(), {
      clientName: 'Conpera Switch', scopes: ['profile:read', 'balance:read'],
      account: { name: 'Conpera Creator', email: 'creator@example.test' }, state,
    });
    const approved = await call(`/api/demo/authorizations/${request.requestId}/approve`, { method: 'POST' });
    assert.equal(approved.status, 200);
    const { code, state: returnedState } = await approved.json();
    assert.equal(returnedState, state);
    return { verifier, code, requestId: request.requestId };
  };
  const login = async () => {
    const authorization = await authorize();
    const response = await call('/api/demo/session', { method: 'POST', body: { code: authorization.code, codeVerifier: authorization.verifier } });
    assert.equal(response.status, 200);
    const cookie = response.headers.get('set-cookie').split(';')[0];
    return { response, cookie, ...authorization };
  };
  return { call, authorize, login, base, advance: (ms) => { timestamp += ms; } };
}

test('PKCE authorization creates an HttpOnly session, exposes profile and demo balance', async (t) => {
  const { call, login } = await fixture(t);
  const { response, cookie } = await login();
  const setCookie = response.headers.get('set-cookie');
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);
  assert.match(setCookie, /Path=\/api\/demo/);
  assert.match(setCookie, /Max-Age=3600/);
  assert.doesNotMatch(setCookie, /Secure/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const session = await response.json();
  assert.deepEqual(session.user, { name: 'Conpera Creator', email: 'creator@example.test' });
  assert.equal(session.expiresAt, '2026-10-06T01:00:00.000Z');
  assert.deepEqual(await (await call('/api/demo/session', { cookie })).json(), session);
  assert.deepEqual(await (await call('/api/demo/balance', { cookie })).json(), {
    balance: 128.5, currency: 'CNY', updatedAt: '2026-10-06T00:00:00.000Z',
  });
});

test('wrong PKCE cannot sign in and consumes the code', async (t) => {
  const { call, authorize } = await fixture(t);
  const { code, verifier } = await authorize();
  const wrong = await call('/api/demo/session', { method: 'POST', body: { code, codeVerifier: makeVerifier() } });
  assert.equal(wrong.status, 400);
  assert.equal(wrong.headers.get('set-cookie'), null);
  const retry = await call('/api/demo/session', { method: 'POST', body: { code, codeVerifier: verifier } });
  assert.equal(retry.status, 400);
  assert.equal((await call('/api/demo/session')).status, 401);
});

test('authorization code is single-use', async (t) => {
  const { call, login } = await fixture(t);
  const { code, verifier } = await login();
  const replay = await call('/api/demo/session', { method: 'POST', body: { code, codeVerifier: verifier } });
  assert.equal(replay.status, 400);
  assert.equal((await replay.json()).error, 'invalid_grant');
});

test('sessions expire by time and the demo expiry action clears access', async (t) => {
  const { call, login, advance } = await fixture(t);
  const first = await login();
  advance(60 * 60 * 1000);
  const expired = await call('/api/demo/session', { cookie: first.cookie });
  assert.equal(expired.status, 401);
  assert.equal(expired.headers.get('set-cookie'), null);
  assert.equal((await call('/api/demo/balance', { cookie: first.cookie })).status, 401);
  const second = await login();
  assert.equal((await call('/api/demo/session/expire', { method: 'POST', cookie: second.cookie })).status, 204);
  assert.equal((await call('/api/demo/session', { cookie: second.cookie })).status, 401);
});

test('stale unauthorized GET responses cannot clear a newly established session cookie', async (t) => {
  const { call, login, advance } = await fixture(t);
  const old = await login();
  advance(60 * 60 * 1000);
  const current = await login();
  for (const path of ['/api/demo/session', '/api/demo/balance']) {
    const stale = await call(path, { cookie: old.cookie });
    assert.equal(stale.status, 401);
    assert.equal(stale.headers.get('set-cookie'), null);
    const missing = await call(path);
    assert.equal(missing.status, 401);
    assert.equal(missing.headers.get('set-cookie'), null);
  }
  assert.equal((await call('/api/demo/session', { cookie: current.cookie })).status, 200);
});

test('logout revokes the session and unauthenticated balance is rejected', async (t) => {
  const { call, login } = await fixture(t);
  assert.equal((await call('/api/demo/balance')).status, 401);
  const { cookie } = await login();
  const logout = await call('/api/demo/session', { method: 'DELETE', cookie });
  assert.equal(logout.status, 204);
  assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal((await call('/api/demo/session', { cookie })).status, 401);
  assert.equal((await call('/api/demo/balance', { cookie })).status, 401);
});

test('cross-site and missing Origin mutations are rejected; development Origin works', async (t) => {
  const { call, base } = await fixture(t);
  const body = { codeChallenge: challenge(makeVerifier()), state: makeVerifier() };
  const foreign = await call('/api/demo/authorizations', { method: 'POST', body, origin: 'https://attacker.example' });
  assert.equal(foreign.status, 403);
  assert.equal((await foreign.json()).error, 'invalid_origin');
  const missing = await fetch(`${base}/api/demo/session`, { method: 'DELETE' });
  assert.equal(missing.status, 403);
  const local = await call('/api/demo/authorizations', { method: 'POST', body, origin: 'http://127.0.0.1:4317' });
  assert.equal(local.status, 201);
  const wrongHostStatus = await new Promise((resolve, reject) => {
    const req = httpRequest(`${base}/api/demo/session`, { headers: { Host: 'attacker.example' } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', reject);
    req.end();
  });
  assert.equal(wrongHostStatus, 403);
});

test('request and code TTLs, cancellation, and duplicate approvals are enforced', async (t) => {
  const { call, authorize, advance } = await fixture(t);
  const initial = await call('/api/demo/authorizations', { method: 'POST', body: { codeChallenge: challenge(makeVerifier()), state: makeVerifier() } });
  const { requestId } = await initial.json();
  advance(5 * 60 * 1000);
  assert.equal((await call(`/api/demo/authorizations/${requestId}`)).status, 404);
  const expiredCode = await authorize();
  assert.equal((await call(`/api/demo/authorizations/${expiredCode.requestId}/approve`, { method: 'POST' })).status, 409);
  advance(60 * 1000);
  assert.equal((await call('/api/demo/session', { method: 'POST', body: { code: expiredCode.code, codeVerifier: expiredCode.verifier } })).status, 400);
  const cancelled = await authorize();
  assert.equal((await call(`/api/demo/authorizations/${cancelled.requestId}`, { method: 'DELETE' })).status, 204);
  assert.equal((await call('/api/demo/session', { method: 'POST', body: { code: cancelled.code, codeVerifier: cancelled.verifier } })).status, 400);
});

test('PKCE input is strict, real credential fields are rejected, and bodies are bounded', async (t) => {
  const { call } = await fixture(t);
  for (const body of [
    { codeChallenge: 'plain', state: makeVerifier() },
    { codeChallenge: challenge(makeVerifier()), state: 'short' },
    { codeChallenge: challenge(makeVerifier()), state: makeVerifier(), email: 'real@example.com' },
    { codeChallenge: '_'.repeat(43), state: makeVerifier() },
  ]) {
    assert.equal((await call('/api/demo/authorizations', { method: 'POST', body })).status, 400);
  }
  assert.equal((await call('/api/demo/authorizations', { method: 'POST', body: { payload: 'x'.repeat(9000) } })).status, 413);
});

test('static serving supports SPA fallback and rejects traversal and symlink escapes', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'conpera-demo-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const distDir = join(directory, 'dist');
  await mkdir(distDir);
  await writeFile(join(distDir, 'index.html'), '<main>demo</main>');
  await writeFile(join(directory, 'secret.txt'), 'outside');
  await symlink(join(directory, 'secret.txt'), join(distDir, 'escape.txt'));
  const { call, base } = await fixture(t, { distDir });
  const fallback = await call('/authorize?request=demo');
  assert.equal(fallback.status, 200);
  assert.equal(await fallback.text(), '<main>demo</main>');
  assert.equal((await call('/missing.js')).status, 404);
  assert.equal((await call('/escape.txt')).status, 403);
  const rawStatus = await new Promise((resolve, reject) => {
    const req = httpRequest(base, { path: '/%2e%2e/secret.txt' }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', reject);
    req.end();
  });
  assert.equal(rawStatus, 400);
});
