import http from 'node:http';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describeConnectionFailure, isSupportedType, openConnection } from './lib/drivers/index.js';
import { runScript } from './lib/runner.js';
import { createUsageCounter } from './lib/usage.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const usage = createUsageCounter(path.join(process.env.DATA_DIR || path.join(ROOT, 'data'), 'usage.json'));
const FIRST_PORT = Number(process.env.PORT) || 5757;
const PORT_ATTEMPTS = 10;
const MAX_JSON_BYTES = 64 * 1024;
const MAX_SCRIPT_BYTES = 500 * 1024 * 1024; // close to the longest string Node can hold

const STATIC_FILES = {
  '/': ['public/index.html', 'text/html; charset=utf-8'],
  '/app.js': ['public/app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['public/style.css', 'text/css; charset=utf-8'],
  '/favicon.svg': ['public/favicon.svg', 'image/svg+xml'],
};

// Database logos live in public/logos. They are served only through <img>, so a
// browser never runs anything inside them. Drop in your own file with the same
// name to change a logo.
const LOGO_DIR = path.join(ROOT, 'public', 'logos');
const LOGO_TYPES = { '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp' };

const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
};

// Connection details, including the password, stay in this process's memory
// only. Each file opens its own connection, so the password is needed all run.
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

// The server only listens on this machine, but any web page open in a browser
// can still send requests to localhost. These two checks shut that out.
function isTrustedRequest(req) {
  const hosts = [`127.0.0.1:${listeningPort}`, `localhost:${listeningPort}`];
  if (!hosts.includes(req.headers.host)) return false;
  const origin = req.headers.origin;
  return !origin || hosts.some((host) => origin === `http://${host}`);
}

function requireSession(req) {
  const session = sessions.get(req.headers['x-session']);
  if (!session) throw new RequestError(401, 'This connection has ended. Connect again.');
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

async function handleConnect(req, res) {
  const config = parseConnectionForm(await readJson(req));
  let connection;
  try {
    connection = await openConnection(config);
    const version = await connection.version();
    const token = randomUUID();
    sessions.set(token, { config, stoppedRunId: null });
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

  // A run sends one request per script, so only its first request counts as a run.
  const isNewRun = session.countedRunId !== runId;
  session.countedRunId = runId;
  usage.recordScript({ newRun: isNewRun, newUser: isNewRun && url.searchParams.get('newUser') === '1' });

  res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'application/x-ndjson; charset=utf-8' });

  // A closed browser tab counts as a stop request.
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
  // Only a plain filename with a known image extension, so nothing outside the
  // logos folder can be reached.
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

// Scripts can run for hours, and the response stays open that whole time.
server.requestTimeout = 0;
server.timeout = 0;

function openBrowser(url) {
  spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
}

function listen(port, attemptsLeft) {
  // Each handler removes the other, so a failed attempt on one port leaves
  // nothing behind to fire when a later attempt succeeds.
  const onListening = () => {
    server.off('error', onError);
    listeningPort = port;
    const url = `http://localhost:${port}`;
    const { users, runs, scripts } = usage.totals();
    console.log(`DB AutoRun is running at ${url}`);
    console.log(`Used so far: ${users} users, ${runs} runs, ${scripts} scripts.`);
    console.log('Close this window to stop it.');
    if (process.argv.includes('--open')) openBrowser(url);
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
  // Only reachable from this computer, never from the network.
  server.listen(port, '127.0.0.1');
}

listen(FIRST_PORT, PORT_ATTEMPTS);
