// Serves the app and keeps patients on disk, one JSON file each. No dependencies.
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT || 8080);
const WEB_DIR = process.env.WEB_DIR || path.join(__dirname, '..');
const DATA_DIR = path.join(process.env.DATA_DIR || path.join(__dirname, '..', 'data'), 'patients');
const PASSWORD = process.env.APP_PASSWORD || '';
const MAX_BODY = 1024 * 1024;

// ---- static files: an explicit list, read once ---------------------------------

const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
const files = new Map();

function addFile(url, file) {
  const body = fs.readFileSync(file);
  const etag = `"${crypto.createHash('sha256').update(body).digest('hex').slice(0, 20)}"`;
  files.set(url, { body, etag, type: TYPES[path.extname(file)] });
}

addFile('/', path.join(WEB_DIR, 'index.html'));
addFile('/index.html', path.join(WEB_DIR, 'index.html'));
addFile('/style.css', path.join(WEB_DIR, 'style.css'));
for (const name of fs.readdirSync(path.join(WEB_DIR, 'js'))) {
  if (name.endsWith('.js')) addFile('/js/' + name, path.join(WEB_DIR, 'js', name));
}

// ---- storage -------------------------------------------------------------------

const ID = /^[a-z0-9]{6,40}$/;
const store = new Map(); // id -> { rev, patient }
const boot = crypto.randomBytes(6).toString('hex');
let changes = 0;

const fileOf = (id) => path.join(DATA_DIR, id + '.json');

function loadAll() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.accessSync(DATA_DIR, fs.constants.W_OK);
  for (const name of fs.readdirSync(DATA_DIR)) {
    if (!name.endsWith('.json')) continue;
    try {
      const entry = JSON.parse(fs.readFileSync(path.join(DATA_DIR, name), 'utf8'));
      const patient = cleanPatient(entry.patient);
      if (!Number.isInteger(entry.rev) || patient.id + '.json' !== name) throw new Error('unexpected content');
      store.set(patient.id, { rev: entry.rev, patient });
    } catch (err) {
      // Leave the file alone so that it can be inspected and repaired.
      console.error(`Skipped ${name}: ${err.message}`);
    }
  }
}

// Written to a temporary file, flushed, then renamed: never half a patient on disk.
function writeEntry(id, entry) {
  const tmp = fileOf(id) + '.tmp';
  const fd = fs.openSync(tmp, 'w', 0o600);
  try {
    fs.writeSync(fd, JSON.stringify(entry));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, fileOf(id));
}

class BadRequest extends Error {}

function cleanPatient(p) {
  const fail = (what) => { throw new BadRequest(`invalid ${what}`); };
  if (!p || typeof p !== 'object') fail('patient');
  if (typeof p.id !== 'string' || !ID.test(p.id)) fail('id');
  for (const f of ['nama', 'ruangan', 'rm']) if (typeof p[f] !== 'string' || p[f].length > 200) fail(f);
  if (typeof p.start !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(p.start)) fail('start');
  if (!Number.isInteger(p.dayCount) || p.dayCount < 1 || p.dayCount > 100000) fail('dayCount');
  if (p.step !== 180 && p.step !== 60) fail('step');
  if (!Array.isArray(p.extra) || p.extra.length > 1440 || p.extra.some((t) => !/^\d{2}:\d{2}$/.test(t))) fail('extra');
  if (!p.readings || typeof p.readings !== 'object' || Array.isArray(p.readings)) fail('readings');
  const readings = Object.entries(p.readings);
  if (readings.length > 20000) fail('readings');
  for (const [key, raw] of readings) {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(key) || typeof raw !== 'string' || raw.length > 16) fail('reading');
  }
  return {
    id: p.id, nama: p.nama, ruangan: p.ruangan, rm: p.rm, start: p.start, dayCount: p.dayCount, step: p.step,
    extra: [...p.extra], readings: Object.fromEntries(readings),
  };
}

// ---- http ----------------------------------------------------------------------

const HEADERS = {
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data: blob:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...HEADERS, ...headers });
  res.end(body);
}

const json = (res, status, value, headers = {}) =>
  send(res, status, JSON.stringify(value), { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers });

const digest = (s) => crypto.createHash('sha256').update(s).digest();
const expected = digest(PASSWORD);

// Any user name; only the password is checked.
function allowed(req) {
  if (!PASSWORD) return true;
  const m = /^Basic (.+)$/i.exec(req.headers.authorization || '');
  if (!m) return false;
  const text = Buffer.from(m[1], 'base64').toString('utf8');
  return crypto.timingSafeEqual(digest(text.slice(text.indexOf(':') + 1)), expected);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new BadRequest('body too large'));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/healthz') return send(res, 200, 'ok');

  if (!allowed(req)) {
    // Slow down guessing.
    if (req.headers.authorization) await new Promise((r) => setTimeout(r, 800));
    return send(res, 401, 'Password required', { 'WWW-Authenticate': 'Basic realm="Kurva Suhu", charset="UTF-8"' });
  }

  if (url.pathname === '/api/patients') {
    if (req.method !== 'GET') return send(res, 405);
    const etag = `"${boot}-${changes}"`;
    if (req.headers['if-none-match'] === etag) return send(res, 304, undefined, { ETag: etag });
    return json(res, 200, { patients: [...store.values()] }, { ETag: etag });
  }

  const m = /^\/api\/patients\/([a-z0-9]{6,40})$/.exec(url.pathname);
  if (m) {
    const id = m[1];
    if (req.method === 'PUT') {
      // A JSON content type makes browsers refuse cross-site requests.
      if (!/^application\/json\b/.test(req.headers['content-type'] || '')) return send(res, 415);
      let body;
      try {
        body = JSON.parse(await readBody(req));
      } catch (err) {
        throw err instanceof BadRequest ? err : new BadRequest('invalid JSON');
      }
      const patient = cleanPatient(body?.patient);
      if (patient.id !== id) throw new BadRequest('id mismatch');
      const current = store.get(id) ?? null;
      if (body.rev !== (current?.rev ?? 0)) return json(res, 409, { current });
      const entry = { rev: (current?.rev ?? 0) + 1, patient };
      writeEntry(id, entry);
      store.set(id, entry);
      changes++;
      return json(res, 200, { rev: entry.rev });
    }
    if (req.method === 'DELETE') {
      const current = store.get(id);
      if (!current) return send(res, 404);
      if (url.searchParams.get('rev') !== String(current.rev)) return json(res, 409, { current });
      fs.rmSync(fileOf(id), { force: true });
      store.delete(id);
      changes++;
      return send(res, 204);
    }
    return send(res, 405);
  }

  const file = files.get(url.pathname);
  if (!file) return send(res, 404, 'Not found');
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405);
  const headers = { 'Content-Type': file.type, ETag: file.etag, 'Cache-Control': 'no-cache' };
  if (req.headers['if-none-match'] === file.etag) return send(res, 304, undefined, headers);
  return send(res, 200, req.method === 'HEAD' ? undefined : file.body, headers);
}

try {
  loadAll();
} catch (err) {
  console.error(`Cannot use the data folder ${DATA_DIR}: ${err.message}`);
  process.exit(1);
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    if (!(err instanceof BadRequest)) console.error(err);
    if (!res.headersSent) json(res, err instanceof BadRequest ? 400 : 500, { error: err instanceof BadRequest ? err.message : 'server error' });
    else res.destroy();
  });
});

server.listen(PORT, () => {
  console.log(`Kurva Suhu on port ${PORT}, ${store.size} patients in ${DATA_DIR}`);
  if (!PASSWORD) console.warn('APP_PASSWORD is not set: anyone on the network can read and change the data.');
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    server.closeIdleConnections();
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
