// Vanity server.
// Serves the website and runs a queue of vanity searches on this machine's GPU (WebGPU via Dawn),
// falling back to CPU threads. Results are sealed to the requesting browser (RSA-OAEP + AES-GCM),
// kept only in memory, and removed after RESULT_TTL_SECONDS.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Worker } from 'node:worker_threads';
import { randomBytes, webcrypto } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
await import('./engine/pattern.js');
await import('./engine/gpu-engine.js');
const { VanityPattern: VP, VanityGPU } = globalThis;
const subtle = webcrypto.subtle;

const env = (k, d) => (process.env[k] === undefined || process.env[k] === '' ? d : process.env[k]);
const CFG = {
  port: +env('PORT', 8080),
  host: env('HOST', '0.0.0.0'),
  engine: env('ENGINE', 'auto'),                       // auto | gpu | cpu
  cpuThreads: Math.max(1, +env('CPU_THREADS', os.cpus().length)),
  maxExpectedSec: +env('MAX_EXPECTED_SECONDS', 3600),       // refuse names whose average search is longer
  maxRunSec: +env('MAX_RUN_SECONDS', 6 * 3600),            // hard cap per job (each job also stops at 5x its average)
  maxQueue: +env('MAX_QUEUE', 25),
  maxJobsPerIp: +env('MAX_JOBS_PER_IP', 1),
  resultTtlSec: +env('RESULT_TTL_SECONDS', 3600),
  abandonSec: +env('ABANDON_SECONDS', 600),
  trustProxy: env('TRUST_PROXY', '0') === '1',
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString(), ...a);

/* ---------------- engines ---------------- */
async function makeGpuEngine() {
  const { create, globals } = await import('webgpu');
  Object.assign(globalThis, globals);
  const wgsl = await readFile(path.join(ROOT, 'engine', 'vanity.wgsl'), 'utf8');
  const g = await VanityGPU.create(wgsl, {
    gpu: create([]),
    onLost: () => { log('GPU device lost, exiting so the process manager restarts us'); process.exit(1); },
  });
  const st = await g.selfTest();
  if (!st.ok) throw new Error('GPU self-test failed');
  await VanityGPU.bench(g, 2500, 200);
  const eng = {
    kind: 'gpu', device: g.vendor || 'GPU', rate: g.rate,
    async grind(job, isActive, onProgress) {
      let hit = null;
      await VanityGPU.grind(g, {
        pre: job.a.pre.sets, suf: job.a.suf.sets, match: VP.matcher(job.a.pre.sets, job.a.suf.sets), targetMs: 200,
        isActive: () => !hit && isActive(),
        onBatch: b => {
          eng.rate = 0.8 * eng.rate + 0.2 * (b.n / (b.dt / 1000));
          onProgress(b.n, eng.rate);
          if (b.hits.length) hit = b.hits[0];
        },
      });
      return hit;
    },
  };
  return eng;
}

async function makeCpuEngine() {
  const workers = Array.from({ length: CFG.cpuThreads }, () => new Worker(new URL('./engine/cpu-worker.mjs', import.meta.url)));
  let runId = 0, handler = null;
  workers.forEach(w => w.on('message', m => handler && handler(m)));
  const startAll = (id, pre, suf) => workers.forEach(w => w.postMessage({ type: 'start', runId: id, pre, suf }));
  const stopAll = () => workers.forEach(w => w.postMessage({ type: 'stop' }));

  let count = 0; const bid = ++runId;
  handler = m => { if (m.runId === bid && m.type === 'progress') count += m.n; };
  startAll(bid, [''], []);
  await sleep(400); count = 0; await sleep(1600); stopAll();
  const eng = {
    kind: 'cpu', device: `${CFG.cpuThreads} CPU threads`, rate: count / 1.6,
    grind(job, isActive, onProgress) {
      return new Promise(resolve => {
        const id = ++runId; let done = false, winN = 0, winT = Date.now();
        const finish = hit => { if (done) return; done = true; clearInterval(timer); stopAll(); handler = null; resolve(hit); };
        handler = m => {
          if (m.runId !== id) return;
          if (m.type === 'progress') { winN += m.n; onProgress(m.n, eng.rate); }
          else if (m.type === 'found') finish({ address: m.address, secret: new Uint8Array(m.secret) });
        };
        const timer = setInterval(() => {
          const t = Date.now();
          if (t - winT >= 2000) { eng.rate = 0.7 * eng.rate + 0.3 * (winN / ((t - winT) / 1000)); winN = 0; winT = t; }
          if (!isActive()) finish(null);
        }, 250);
        startAll(id, job.a.pre.sets, job.a.suf.sets);
      });
    },
  };
  return eng;
}

let engine = null;
async function initEngine() {
  if (CFG.engine !== 'cpu') {
    try { engine = await makeGpuEngine(); }
    catch (e) {
      if (CFG.engine === 'gpu') throw e;
      log('GPU engine unavailable (' + (e && e.message) + '), using CPU threads');
    }
  }
  if (!engine) engine = await makeCpuEngine();
  log(`engine: ${engine.kind} (${engine.device}), ~${Math.round(engine.rate).toLocaleString()} keys/sec`);
}

/* ---------------- sealing ---------------- */
const b64 = u8 => Buffer.from(u8).toString('base64');
async function importRecipient(spkiB64) {
  const key = await subtle.importKey('spki', Buffer.from(String(spkiB64), 'base64'), { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt']);
  if (key.algorithm.modulusLength < 3072) throw new Error('weak key');
  return key;
}
async function seal(secret, rsaKey) {
  const aes = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt']);
  const iv = randomBytes(12);
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, aes, secret));
  const raw = new Uint8Array(await subtle.exportKey('raw', aes));
  const wrapped = new Uint8Array(await subtle.encrypt({ name: 'RSA-OAEP' }, rsaKey, raw));
  raw.fill(0);
  return { wrappedKey: b64(wrapped), iv: b64(iv), ciphertext: b64(ct) };
}

/* ---------------- jobs ---------------- */
const jobs = new Map();
const queue = [];
let current = null;

function view(j) {
  const pos = queue.indexOf(j);
  const rate = j.status === 'running' ? (j.rate || engine.rate) : engine.rate;
  return {
    id: j.id, status: j.status, prefix: j.a.preRaw, suffix: j.a.sufRaw, anyCase: j.a.anyCase,
    odds: j.a.p, tries: j.tries, rate: Math.round(rate),
    ahead: pos >= 0 ? pos + (current ? 1 : 0) : 0,
    elapsed: j.startedAt ? Math.round(((j.finishedAt || Date.now()) - j.startedAt) / 1000) : 0,
    avgSeconds: Math.round(1 / (j.a.p * engine.rate)),
    address: j.status === 'done' ? j.address : undefined,
    sealed: j.status === 'done' ? j.sealed : undefined,
    error: j.error || undefined,
  };
}

async function runNext() {
  if (current || !queue.length) return;
  const job = queue.shift();
  current = job; job.status = 'running'; job.startedAt = Date.now();
  const limitMs = Math.min(CFG.maxRunSec, 5 / (job.a.p * engine.rate) + 120) * 1000;
  try {
    const hit = await engine.grind(job,
      () => job.status === 'running' && Date.now() - job.startedAt < limitMs,
      (n, rate) => { job.tries += n; job.rate = rate; });
    if (hit && VP.matcher(job.a.pre.sets, job.a.suf.sets)(hit.address)) {
      job.sealed = await seal(hit.secret, job.rsa);
      job.address = hit.address;
      hit.secret.fill(0);
      job.status = 'done';
      log(`job ${job.id.slice(0, 8)} done after ${job.tries.toLocaleString()} keys`);
    } else if (job.status === 'running') {
      job.status = 'failed'; job.error = 'time-limit';
    }
  } catch (e) {
    log('job failed', e); job.status = 'failed'; job.error = 'engine';
  } finally {
    job.finishedAt = Date.now(); job.rsa = null; current = null;
    setImmediate(runNext);
  }
}

function cancel(job, reason) {
  if (job.status === 'queued') { const i = queue.indexOf(job); if (i >= 0) queue.splice(i, 1); job.finishedAt = Date.now(); }
  if (job.status === 'queued' || job.status === 'running') { job.status = 'canceled'; job.error = reason; job.rsa = null; }
}

setInterval(() => {
  const t = Date.now();
  for (const j of jobs.values()) {
    if ((j.status === 'queued' || j.status === 'running') && t - j.seenAt > CFG.abandonSec * 1000) cancel(j, 'abandoned');
    if (j.finishedAt && t - j.finishedAt > CFG.resultTtlSec * 1000) jobs.delete(j.id);
  }
}, 30_000).unref();

/* ---------------- http ---------------- */
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.wgsl': 'text/plain; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.txt': 'text/plain; charset=utf-8' };
const CSP = [
  "default-src 'self'", "script-src 'self' 'unsafe-inline'", "worker-src 'self' blob:",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com", "font-src https://fonts.gstatic.com",
  "connect-src 'self'", "img-src 'self' data:", "frame-ancestors 'none'", "base-uri 'none'", "form-action 'none'",
].join('; ');
const BASE_HEADERS = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': CSP };

function send(res, code, body, headers = {}) {
  const isObj = typeof body === 'object' && !(body instanceof Buffer);
  res.writeHead(code, { ...BASE_HEADERS, 'Content-Type': isObj ? 'application/json' : 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(isObj ? JSON.stringify(body) : body);
}
function clientIp(req) {
  if (CFG.trustProxy) { const f = req.headers['x-forwarded-for']; if (f) return String(f).split(',')[0].trim(); }
  return req.socket.remoteAddress || '';
}
function readJson(req, limit = 8192) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { reject(new Error('too-large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { reject(new Error('bad-json')); } });
    req.on('error', reject);
  });
}

async function createJob(req, res) {
  let body;
  try { body = await readJson(req); } catch { return send(res, 400, { error: 'bad-request' }); }
  const a = VP.analyze(body.prefix, body.suffix, !!body.anyCase);
  if (a.error) return send(res, 400, { error: a.error, bad: a.bad });
  if (a.empty) return send(res, 400, { error: 'empty' });
  if (engine.kind === 'gpu' && a.pre.sets.length && /^1+$/.test(a.pre.sets[0])) return send(res, 400, { error: 'prefix-one' });
  const avgSeconds = 1 / (a.p * engine.rate);
  if (avgSeconds > CFG.maxExpectedSec) return send(res, 400, { error: 'too-slow', avgSeconds: Math.round(avgSeconds), maxSeconds: CFG.maxExpectedSec });
  const ip = clientIp(req);
  const active = [...jobs.values()].filter(j => j.ip === ip && (j.status === 'queued' || j.status === 'running')).length;
  if (active >= CFG.maxJobsPerIp) return send(res, 429, { error: 'one-at-a-time' });
  if (queue.length >= CFG.maxQueue) return send(res, 503, { error: 'queue-full' });
  let rsa;
  try { rsa = await importRecipient(body.recipientKey); } catch { return send(res, 400, { error: 'bad-key' }); }
  const job = { id: randomBytes(16).toString('hex'), a, rsa, ip, status: 'queued', tries: 0, rate: 0, created: Date.now(), seenAt: Date.now() };
  jobs.set(job.id, job); queue.push(job);
  log(`job ${job.id.slice(0, 8)} queued: "${a.preRaw}…${a.sufRaw}" anyCase=${a.anyCase} avg≈${Math.round(avgSeconds)}s`);
  setImmediate(runNext);
  send(res, 201, view(job));
}

async function serveStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath);
  if (rel === '/' || rel === '') rel = '/index.html';
  const isEngine = rel.startsWith('/engine/');
  const baseDir = isEngine ? path.join(ROOT, 'engine') : path.join(ROOT, 'public');
  const file = path.normalize(path.join(baseDir, isEngine ? rel.slice('/engine/'.length) : rel));
  if (!file.startsWith(baseDir + path.sep)) return send(res, 404, 'Not found');
  const ext = path.extname(file);
  if (!TYPES[ext] || (isEngine && !['.js', '.wgsl'].includes(ext))) return send(res, 404, 'Not found');
  try {
    const data = await readFile(file);
    res.writeHead(200, { ...BASE_HEADERS, 'Content-Type': TYPES[ext], 'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300' });
    res.end(req.method === 'HEAD' ? undefined : data);
  } catch { send(res, 404, 'Not found'); }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    if (p === '/api/status' && req.method === 'GET') {
      return send(res, 200, { engine: engine.kind, device: engine.device, rate: Math.round(engine.rate), queue: queue.length + (current ? 1 : 0), maxExpectedSeconds: CFG.maxExpectedSec, maxTotal: VP.MAX_TOTAL });
    }
    if (p === '/api/jobs' && req.method === 'POST') return createJob(req, res);
    const m = p.match(/^\/api\/jobs\/([0-9a-f]{32})$/);
    if (m) {
      const job = jobs.get(m[1]);
      if (!job) return send(res, 404, { error: 'gone' });
      if (req.method === 'GET') { job.seenAt = Date.now(); return send(res, 200, view(job)); }
      if (req.method === 'DELETE') { cancel(job, 'canceled'); return send(res, 200, view(job)); }
      return send(res, 405, { error: 'method' });
    }
    if (p.startsWith('/api/')) return send(res, 404, { error: 'not-found' });
    if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res, p);
    send(res, 405, 'Method not allowed');
  } catch (e) {
    log('request error', e); if (!res.headersSent) send(res, 500, { error: 'server' });
  }
});

await initEngine();
server.listen(CFG.port, CFG.host, () => log(`Vanity server listening on http://${CFG.host}:${CFG.port}`));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { log('shutting down'); server.close(); process.exit(0); });
