import { createServer } from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const COOKIE_NAME = 'conpera_demo_session';
const ACCOUNT = Object.freeze({ name: 'Conpera Creator', email: 'creator@example.test' });
const SCOPES = Object.freeze(['profile:read', 'balance:read']);
const UNRESERVED = /^[A-Za-z0-9._~-]+$/;
const ID = /^[A-Za-z0-9_-]{43}$/;
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff',
};

const token = () => randomBytes(32).toString('base64url');
const hash = (value) => createHash('sha256').update(value).digest('base64url');

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function send(res, status, payload, extraHeaders = {}) {
  res.writeHead(status, {
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    ...(payload !== undefined ? { 'Content-Type': 'application/json; charset=utf-8' } : {}),
    ...extraHeaders,
  });
  res.end(payload === undefined ? undefined : JSON.stringify(payload));
}

function sessionCookie(value, maxAge) {
  // Intentionally local HTTP only: production must use HTTPS and Secure cookies.
  return `${COOKIE_NAME}=${value}; HttpOnly; SameSite=Strict; Path=/api/demo; Max-Age=${maxAge}`;
}

function getCookie(req) {
  const matches = (req.headers.cookie ?? '').split(';')
    .map((part) => part.trim()).filter((part) => part.startsWith(`${COOKIE_NAME}=`));
  if (matches.length !== 1) return null;
  const value = matches[0].slice(COOKIE_NAME.length + 1);
  return ID.test(value) ? value : null;
}

async function readJson(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) {
    throw new HttpError(415, 'unsupported_media_type', 'Use application/json.');
  }
  if (Number(req.headers['content-length'] ?? 0) > 8192) {
    throw new HttpError(413, 'payload_too_large', 'Request body exceeds 8 KiB.');
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 8192) throw new HttpError(413, 'payload_too_large', 'Request body exceeds 8 KiB.');
    chunks.push(chunk);
  }
  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'invalid_json', 'Request body must be valid JSON.');
  }
  if (!body || Array.isArray(body) || typeof body !== 'object') {
    throw new HttpError(400, 'invalid_request', 'Request body must be a JSON object.');
  }
  return body;
}

function requireFields(body, fields) {
  if (Object.keys(body).some((key) => !fields.includes(key)) ||
      fields.some((key) => typeof body[key] !== 'string')) {
    throw new HttpError(400, 'invalid_request', `Only ${fields.join(', ')} are accepted.`);
  }
}

function isWithin(directory, candidate) {
  const path = relative(directory, candidate);
  return path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

/**
 * Isolated, in-memory demo authorization service. Never reads real credentials or
 * contacts an external service. Call .listen(port, '127.0.0.1') on the result.
 * The injectable clock exists for deterministic expiry tests.
 */
export function createDemoServer({
  now = Date.now,
  distDir = resolve(here, '../dist'),
  requestTtlMs = 5 * 60 * 1000,
  codeTtlMs = 60 * 1000,
  sessionTtlMs = 60 * 60 * 1000,
} = {}) {
  const requests = new Map();
  const codes = new Map();
  const sessions = new Map();
  const distRoot = resolve(distDir);

  function prune() {
    const timestamp = now();
    for (const [key, value] of requests) if (value.expiresAt <= timestamp) requests.delete(key);
    for (const [key, value] of codes) if (value.expiresAt <= timestamp) codes.delete(key);
    for (const [key, value] of sessions) if (value.expiresAt <= timestamp) sessions.delete(key);
  }

  function getSession(req, res) {
    const cookie = getCookie(req);
    const session = cookie ? sessions.get(hash(cookie)) : undefined;
    if (!session || session.expiresAt <= now()) {
      if (cookie) sessions.delete(hash(cookie));
      // A delayed GET 401 must not clear a newer login cookie. Only explicit
      // logout and the demo expiry action send a cookie deletion header.
      throw new HttpError(401, 'unauthenticated', 'Demo session is missing or expired.');
    }
    return session;
  }

  const server = createServer(async (req, res) => {
    try {
      const localPort = req.socket.localPort;
      const hosts = new Set(['127.0.0.1:4317', '127.0.0.1:4318', `127.0.0.1:${localPort}`]);
      if (!hosts.has(req.headers.host)) throw new HttpError(403, 'invalid_host', 'Local demo hosts only.');
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
        const origins = new Set([...hosts].map((host) => `http://${host}`));
        if (!origins.has(req.headers.origin)) {
          throw new HttpError(403, 'invalid_origin', 'A trusted local Origin is required.');
        }
      }

      let rawPath;
      try {
        rawPath = decodeURIComponent((req.url ?? '/').split('?')[0]);
      } catch {
        throw new HttpError(400, 'invalid_path', 'Invalid URL encoding.');
      }
      if (!rawPath.startsWith('/') || rawPath.includes('\0') || rawPath.includes('\\') ||
          rawPath.split('/').some((part) => part === '..' || part === '.')) {
        throw new HttpError(400, 'invalid_path', 'Invalid request path.');
      }
      const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
      const method = req.method;
      prune();

      if (pathname === '/api/demo/authorizations' && method === 'POST') {
        const body = await readJson(req);
        requireFields(body, ['codeChallenge', 'state']);
        if (!ID.test(body.codeChallenge) || Buffer.from(body.codeChallenge, 'base64url').toString('base64url') !== body.codeChallenge ||
            body.state.length < 32 || body.state.length > 128 || !UNRESERVED.test(body.state)) {
          throw new HttpError(400, 'invalid_request', 'A canonical S256 challenge and 32–128 character state are required.');
        }
        if (requests.size >= 1000) throw new HttpError(429, 'too_many_requests', 'Too many pending demo authorizations.');
        const requestId = token();
        requests.set(requestId, { challenge: body.codeChallenge, state: body.state, expiresAt: now() + requestTtlMs, approved: false });
        send(res, 201, { requestId, authorizationUrl: `/authorize?request=${requestId}` });
        return;
      }

      const match = /^\/api\/demo\/authorizations\/([A-Za-z0-9_-]{43})(\/approve)?$/.exec(pathname);
      if (match) {
        const [, requestId, approval] = match;
        const request = requests.get(requestId);
        if (!request) throw new HttpError(404, 'authorization_not_found', 'Authorization request is missing or expired.');
        if (!approval && method === 'GET') {
          send(res, 200, { clientName: 'Conpera Switch', scopes: SCOPES, account: ACCOUNT, state: request.state });
          return;
        }
        if (!approval && method === 'DELETE') {
          requests.delete(requestId);
          if (request.codeHash) codes.delete(request.codeHash);
          send(res, 204);
          return;
        }
        if (approval && method === 'POST') {
          if (request.approved) throw new HttpError(409, 'already_approved', 'This authorization was already approved.');
          const code = token();
          const codeHash = hash(code);
          request.approved = true;
          request.codeHash = codeHash;
          codes.set(codeHash, { challenge: request.challenge, expiresAt: now() + codeTtlMs, requestId });
          send(res, 200, { code, state: request.state });
          return;
        }
        throw new HttpError(405, 'method_not_allowed', 'Unsupported method.');
      }

      if (pathname === '/api/demo/session') {
        if (method === 'POST') {
          const body = await readJson(req);
          requireFields(body, ['code', 'codeVerifier']);
          if (!ID.test(body.code) || body.codeVerifier.length < 43 || body.codeVerifier.length > 128 || !UNRESERVED.test(body.codeVerifier)) {
            throw new HttpError(400, 'invalid_request', 'A valid code and RFC 7636 verifier are required.');
          }
          const codeHash = hash(body.code);
          const authorization = codes.get(codeHash);
          // Every exchange attempt consumes a valid code, including wrong PKCE.
          codes.delete(codeHash);
          if (authorization) requests.delete(authorization.requestId);
          if (!authorization || authorization.expiresAt <= now() ||
              !timingSafeEqual(Buffer.from(hash(body.codeVerifier)), Buffer.from(authorization.challenge))) {
            throw new HttpError(400, 'invalid_grant', 'Authorization code or PKCE verifier is invalid or expired.');
          }
          const oldCookie = getCookie(req);
          if (oldCookie) sessions.delete(hash(oldCookie));
          const cookie = token();
          const session = { user: ACCOUNT, expiresAt: now() + sessionTtlMs };
          sessions.set(hash(cookie), session);
          send(res, 200, { user: session.user, expiresAt: new Date(session.expiresAt).toISOString() }, {
            'Set-Cookie': sessionCookie(cookie, Math.floor(sessionTtlMs / 1000)),
          });
          return;
        }
        if (method === 'GET') {
          const session = getSession(req, res);
          send(res, 200, { user: session.user, expiresAt: new Date(session.expiresAt).toISOString() });
          return;
        }
        if (method === 'DELETE') {
          const cookie = getCookie(req);
          if (cookie) sessions.delete(hash(cookie));
          send(res, 204, undefined, { 'Set-Cookie': sessionCookie('', 0) });
          return;
        }
        throw new HttpError(405, 'method_not_allowed', 'Unsupported method.');
      }

      if (pathname === '/api/demo/session/expire' && method === 'POST') {
        getSession(req, res);
        sessions.delete(hash(getCookie(req)));
        send(res, 204, undefined, { 'Set-Cookie': sessionCookie('', 0) });
        return;
      }
      if (pathname === '/api/demo/balance' && method === 'GET') {
        getSession(req, res);
        send(res, 200, { balance: 128.5, currency: 'CNY', updatedAt: new Date(now()).toISOString() });
        return;
      }
      if (pathname.startsWith('/api/')) throw new HttpError(404, 'not_found', 'Unknown demo API endpoint.');

      if (!['GET', 'HEAD'].includes(method)) throw new HttpError(405, 'method_not_allowed', 'Unsupported method.');
      let candidate = resolve(distRoot, `.${rawPath}`);
      if (!isWithin(distRoot, candidate)) throw new HttpError(400, 'invalid_path', 'Invalid request path.');
      try {
        if (!(await stat(candidate)).isFile()) candidate = resolve(distRoot, 'index.html');
      } catch {
        if (extname(rawPath)) throw new HttpError(404, 'not_found', 'File not found.');
        candidate = resolve(distRoot, 'index.html');
      }
      let actual;
      try {
        const [resolvedRoot, resolvedFile] = await Promise.all([realpath(distRoot), realpath(candidate)]);
        if (!isWithin(resolvedRoot, resolvedFile)) throw new HttpError(403, 'invalid_path', 'File is outside the demo build.');
        actual = resolvedFile;
      } catch (error) {
        if (error instanceof HttpError) throw error;
        throw new HttpError(404, 'build_not_found', 'Demo build not found. Run npm run build or use the Vite development server.');
      }
      const content = await readFile(actual);
      res.writeHead(200, {
        'Content-Type': MIME[extname(actual)] ?? 'application/octet-stream',
        'Content-Length': content.length,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
      });
      res.end(method === 'HEAD' ? undefined : content);
    } catch (error) {
      if (res.headersSent) {
        res.end();
        return;
      }
      send(res, error instanceof HttpError ? error.status : 500, {
        error: error instanceof HttpError ? error.code : 'internal_error',
        message: error instanceof HttpError ? error.message : 'Unexpected local demo error.',
      });
    }
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  createDemoServer().listen(4318, '127.0.0.1', () => {
    console.log('Conpera Switch demo: http://127.0.0.1:4318');
  });
}
