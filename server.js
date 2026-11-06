#!/usr/bin/env node
import http from 'node:http';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describeConnectionFailure, isSupportedType, openConnection } from './lib/drivers/index.js';
import { runScript } from './lib/runner.js';
import { createUsageCounter } from './lib/usage.js';
import { resolveSafely } from './lib/netguard.js';
import { createRateLimiter } from './lib/ratelimit.js';

const IS_PUBLIC = (process.env.APP_MODE || (process.env.RENDER ? 'public' : 'local')).toLowerCase() === 'public';
const PUBLIC_HOST = (process.env.PUBLIC_HOST || process.env.RENDER_EXTERNAL_HOSTNAME || '').trim();
const PUBLIC_ORIGIN = PUBLIC_HOST ? `https://${PUBLIC_HOST}` : '';
const BIND_HOST = IS_PUBLIC ? '0.0.0.0' : '127.0.0.1';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const usage = createUsageCounter(path.join(process.env.DATA_DIR || path.join(ROOT, 'data'), 'usage.json'));
const FIRST_PORT = Number(process.env.PORT) || 5757;
const PORT_ATTEMPTS = IS_PUBLIC ? 1 : 10;
const MAX_JSON_BYTES = 64 * 1024;
const MAX_SCRIPT_BYTES = (IS_PUBLIC ? 5 : 500) * 1024 * 1024;
const STATEMENT_TIMEOUT_MS = IS_PUBLIC ? 60000 : 0;
const SESSION_IDLE_MS = 30 * 60 * 1000;
const MAX_SESSIONS = 500;

const connectLimiter = IS_PUBLIC ? createRateLimiter({ windowMs: 60000, max: 15 }) : null;

const STATIC_FILES = {
  '/': ['public/index.html', 'text/html; charset=utf-8'],
  '/app.js': ['public/app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['public/style.css', 'text/css; charset=utf-8'],
  '/favicon.svg': ['public/favicon.svg', 'image/svg+xml'],
};

const LOGO_DIR = path.join(ROOT, 'public', 'logos');
const LOGO_TYPES = { '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp' };

const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
};

const sessions = new Map();
let listeningPort = FIRST_PORT;

class RequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function sendJson(res, status, body) {
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

async function readBody(req, limit) {
  const declared = Number(req.headers['content-length']);
  if (declared > limit) {
    req.resume();
    throw new RequestError(413, `File is too large. The limit is ${Math.round(limit / 1024 / 1024)} MB.`);
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      throw new RequestError(413, `File is too large. The limit is ${Math.round(limit / 1024 / 1024)} MB.`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(req) {
  try {
    return JSON.parse((await readBody(req, MAX_JSON_BYTES)).toString('utf8') || '{}');
  } catch (error) {
    if (error instanceof RequestError) throw error;
    throw new RequestError(400, 'Request body is not valid JSON.');
  }
}

function isTrustedRequest(req) {
  if (IS_PUBLIC) {
    if (req.method === 'GET') return true;
    const origin = req.headers.origin;
    if (!origin) return false;
    if (PUBLIC_ORIGIN) return origin === PUBLIC_ORIGIN;
    try {
      return new URL(origin).host === req.headers.host;
    } catch {
      return false;
    }
  }
  const hosts = [`127.0.0.1:${listeningPort}`, `localhost:${listeningPort}`];
  if (!hosts.includes(req.headers.host)) return false;
  const origin = req.headers.origin;
  return !origin || hosts.some((host) => origin === `http://${host}`);
}

function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length) return forwarded.split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

function requireSession(req) {
  const session = sessions.get(req.headers['x-session']);
  if (!session) throw new RequestError(401, 'This connection has ended. Connect again.');
  session.lastUsed = Date.now();
  return session;
}

function parseConnectionForm(form) {
  const type = String(form.type ?? '');
  if (!isSupportedType(type)) throw new RequestError(400, 'Choose a database type.');

  const server = String(form.server ?? '').trim();
  if (!server) throw new RequestError(400, 'Enter the server name.');

  const port = Number(form.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new RequestError(400, 'Enter a port between 1 and 65535.');
  }

  const user = String(form.user ?? '').trim();
  if (!user) throw new RequestError(400, 'Enter the user name.');

  const database = String(form.database ?? '').trim();
  if (type === 'oracle' && !database) throw new RequestError(400, 'Enter the Oracle service name.');

  return {
    type,
    server,
    port,
    user,
    database,
    password: String(form.password ?? ''),
    encrypt: Boolean(form.encrypt),
    verifyCertificate: Boolean(form.verifyCertificate),
    sysdba: Boolean(form.sysdba),
  };
}

function hostToResolve(config) {
  if (config.type === 'mssql') return config.server.split(',')[0].split('\\')[0].trim();
  return config.server;
}

async function handleConnect(req, res) {
  if (connectLimiter) {
    const { allowed, retryAfterMs } = connectLimiter.check(clientIp(req));
    if (!allowed) {
      const seconds = Math.ceil(retryAfterMs / 1000);
      res.writeHead(429, { ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Retry-After': String(seconds) });
      res.end(JSON.stringify({ error: `Too many connection attempts. Wait ${seconds} seconds and try again.` }));
      return;
    }
  }

  const config = parseConnectionForm(await readJson(req));

  if (IS_PUBLIC) {
    if (sessions.size >= MAX_SESSIONS) {
      sendJson(res, 503, { error: 'The server is busy right now. Try again in a few minutes.' });
      return;
    }
    try {

      config.resolvedHost = await resolveSafely(hostToResolve(config));
    } catch (error) {
      sendJson(res, 400, { error: error.message });
      return;
    }
    config.statementTimeoutMs = STATEMENT_TIMEOUT_MS;
  }

  let connection;
  try {
    connection = await openConnection(config);
    const version = await connection.version();
    const token = randomUUID();
    sessions.set(token, { config, stoppedRunId: null, lastUsed: Date.now() });
    sendJson(res, 200, { token, version });
  } catch (error) {
    sendJson(res, 400, { error: describeConnectionFailure(error, config) });
  } finally {
    await connection?.close().catch(() => {});
  }
}

async function handleRun(req, res, url) {
  const session = requireSession(req);
  const runId = url.searchParams.get('runId');
  const bytes = await readBody(req, MAX_SCRIPT_BYTES);

  const isNewRun = session.countedRunId !== runId;
  session.countedRunId = runId;
  usage.recordScript({ newRun: isNewRun, newUser: isNewRun && url.searchParams.get('newUser') === '1' });

  res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'application/x-ndjson; charset=utf-8' });

  let clientGone = false;
  res.on('close', () => {
    clientGone = true;
  });

  await runScript({
    config: session.config,
    bytes,
    continueOnError: url.searchParams.get('onError') === 'continue',
    transaction: url.searchParams.get('transaction') === '1',
    emit: (event) => {
      if (!clientGone) res.write(`${JSON.stringify(event)}\n`);
    },
    isStopped: () => clientGone || session.stoppedRunId === runId,
  });
  res.end();
}

async function serveStatic(res, pathname) {
  const [file, contentType] = STATIC_FILES[pathname];
  const content = await readFile(path.join(ROOT, file));
  res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': contentType });
  res.end(content);
}

async function serveLogo(res, pathname) {
  const name = pathname.slice('/logos/'.length);
  const ext = path.extname(name).toLowerCase();

  if (!/^[a-z0-9_-]+$/i.test(path.basename(name, ext)) || !Object.hasOwn(LOGO_TYPES, ext)) {
    sendJson(res, 404, { error: 'Not found.' });
    return;
  }
  try {
    const content = await readFile(path.join(LOGO_DIR, name));
    res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': LOGO_TYPES[ext], 'Cache-Control': 'max-age=3600' });
    res.end(content);
  } catch {
    sendJson(res, 404, { error: 'Not found.' });
  }
}

async function route(req, res) {
  if (!isTrustedRequest(req)) {
    sendJson(res, 403, { error: 'Request refused.' });
    return;
  }
  const url = new URL(req.url, 'http://localhost');
  const { pathname } = url;

  if (req.method === 'GET' && Object.hasOwn(STATIC_FILES, pathname)) {
    await serveStatic(res, pathname);
  } else if (req.method === 'GET' && pathname.startsWith('/logos/')) {
    await serveLogo(res, pathname);
  } else if (req.method === 'GET' && pathname === '/api/usage') {
    sendJson(res, 200, usage.totals());
  } else if (req.method === 'GET' && pathname === '/api/info') {
    sendJson(res, 200, { public: IS_PUBLIC });
  } else if (req.method === 'POST' && pathname === '/api/connect') {
    await handleConnect(req, res);
  } else if (req.method === 'POST' && pathname === '/api/run') {
    await handleRun(req, res, url);
  } else if (req.method === 'POST' && pathname === '/api/stop') {
    const session = requireSession(req);
    session.stoppedRunId = (await readJson(req)).runId;
    sendJson(res, 200, {});
  } else if (req.method === 'POST' && pathname === '/api/disconnect') {
    sessions.delete(req.headers['x-session']);
    sendJson(res, 200, {});
  } else {
    sendJson(res, 404, { error: 'Not found.' });
  }
}

const server = http.createServer((req, res) => {
  route(req, res).catch((error) => {
    const status = error instanceof RequestError ? error.status : 500;
    if (status === 500) console.error(error);
    if (res.headersSent) res.end();
    else sendJson(res, status, { error: error.message });
  });
});

server.requestTimeout = 0;
server.timeout = 0;

function openBrowser(url) {
  if (process.platform !== 'win32') return;
  try {
    const child = spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
  } catch {

  }
}

if (IS_PUBLIC) {
  setInterval(() => {
    const cutoff = Date.now() - SESSION_IDLE_MS;
    for (const [token, session] of sessions) {
      if (session.lastUsed < cutoff) sessions.delete(token);
    }
    connectLimiter?.prune();
  }, 60000).unref();
}

function listen(port, attemptsLeft) {

  const onListening = () => {
    server.off('error', onError);
    listeningPort = port;
    const { users, runs, scripts } = usage.totals();
    if (IS_PUBLIC) {
      console.log(`DB AutoRun (public mode) is listening on ${BIND_HOST}:${port}${PUBLIC_HOST ? ` for ${PUBLIC_HOST}` : ''}`);
      console.log(`Used so far: ${users} users, ${runs} runs, ${scripts} scripts.`);
    } else {
      const url = `http://localhost:${port}`;
      console.log('');
      console.log(`  DB AutoRun is running. Open this in your browser:`);
      console.log(`  ${url}`);
      console.log('');
      console.log(`  Used so far: ${users} users, ${runs} runs, ${scripts} scripts.`);
      console.log('  Keep this window open while you use it. Press Ctrl+C to stop.');
      if (!process.argv.includes('--no-open')) openBrowser(url);
    }
  };
  const onError = (error) => {
    server.off('listening', onListening);
    if (error.code === 'EADDRINUSE' && attemptsLeft > 1) {
      listen(port + 1, attemptsLeft - 1);
    } else {
      console.error(`Could not start the server: ${error.message}`);
      process.exit(1);
    }
  };
  server.once('listening', onListening);
  server.once('error', onError);
  server.listen(port, BIND_HOST);
}

listen(FIRST_PORT, PORT_ATTEMPTS);
