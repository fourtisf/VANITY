// Vanity server.
// Serves the website and runs a queue of vanity searches on this machine's GPU (WebGPU via Dawn),
// falling back to CPU threads. Results are sealed to the requesting browser (RSA-OAEP + AES-GCM),
// kept only in memory, and removed after RESULT_TTL_SECONDS.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { readFileSync, writeFileSync, renameSync, readdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Worker } from 'node:worker_threads';
import { randomBytes, webcrypto } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { siteConfig, renderPage, hasContact } from './site.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
// Settings can live in a .env file next to server.js (copy .env.example); variables set in the environment win.
if (typeof process.loadEnvFile === 'function') {
  try { process.loadEnvFile(process.env.ENV_FILE || path.join(ROOT, '.env')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
}
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
  maxUnpaid: +env('MAX_UNPAID', 50),                   // jobs waiting for payment at once (not counted in MAX_QUEUE)
  payWindowSec: +env('PAY_WINDOW_SECONDS', 900),      // how long a job waits for its payment
  maxJobsPerIp: +env('MAX_JOBS_PER_IP', 1),
  resultTtlSec: +env('RESULT_TTL_SECONDS', 3600),
  paidResultTtlSec: +env('PAID_RESULT_TTL_SECONDS', 86400),
  abandonSec: +env('ABANDON_SECONDS', 600),
  trustProxy: env('TRUST_PROXY', '0') === '1',
  payTo: env('PAY_TO', ''),                            // Solana address that receives Fast mode payments; empty = free
  priceSol: +env('PRICE_SOL', 0.01),                   // price per job...
  priceSolPerHour: +env('PRICE_SOL_PER_HOUR', 0.1),    // ...plus this much per hour of average search time
  cluster: env('SOLANA_CLUSTER', 'mainnet'),           // mainnet | devnet | testnet
};
if (!['mainnet', 'devnet', 'testnet'].includes(CFG.cluster)) throw new Error(`SOLANA_CLUSTER must be mainnet, devnet or testnet, not ${CFG.cluster}`);
CFG.rpc = env('SOLANA_RPC', `https://api.${CFG.cluster === 'mainnet' ? 'mainnet-beta' : CFG.cluster}.solana.com`);
CFG.paidFile = env('PAID_JOBS_FILE', path.join(ROOT, 'paid-jobs.json'));
const SITE = siteConfig();
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
  const libs = await Promise.all(workers.map(w => new Promise((ok, fail) => {
    w.once('error', fail);
    w.on('message', m => m.type === 'ready' && ok(m.lib));
  })));
  let runId = 0, handler = null;
  workers.forEach(w => w.on('message', m => handler && handler(m)));
  const startAll = (id, pre, suf) => workers.forEach(w => w.postMessage({ type: 'start', runId: id, pre, suf }));
  const stopAll = () => workers.forEach(w => w.postMessage({ type: 'stop' }));

  let count = 0; const bid = ++runId;
  handler = m => { if (m.runId === bid && m.type === 'progress') count += m.n; };
  startAll(bid, [''], []);
  await sleep(400); count = 0; await sleep(1600); stopAll();
  const eng = {
    kind: 'cpu', device: `${CFG.cpuThreads} CPU threads, ${libs[0]}`, rate: count / 1.6,
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

// On Linux the GPU engine runs on Vulkan. With no Vulkan driver installed (a server without a GPU) there is
// nothing to try, and trying only fills the error log with Dawn's "Found no drivers" warnings.
function hasVulkanDriver() {
  if (['VK_ICD_FILENAMES', 'VK_DRIVER_FILES', 'VK_ADD_DRIVER_FILES'].some(k => env(k, ''))) return true;
  const split = (v, d) => (process.env[v] || d).split(':').filter(Boolean);
  const dirs = [...split('XDG_CONFIG_DIRS', '/etc/xdg'), '/etc', ...split('XDG_DATA_DIRS', '/usr/local/share:/usr/share'),
    path.join(os.homedir(), '.local/share'), '/usr/share'];
  return dirs.some(d => { try { return readdirSync(path.join(d, 'vulkan/icd.d')).some(f => f.endsWith('.json')); } catch { return false; } });
}

let engine = null;
async function initEngine() {
  if (CFG.engine === 'auto' && process.platform === 'linux' && !hasVulkanDriver()) log('no GPU driver (Vulkan) on this machine, using CPU threads');
  else if (CFG.engine !== 'cpu') {
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

/* ---------------- payments ---------------- */
// Solana Pay: each job gets a fresh reference key. The browser's transfer to PAY_TO lists it as an extra
// read-only account, so the payment is found with getSignaturesForAddress(reference) and checked on chain.
function b58dec(s) {
  let n = 0n;
  for (const c of s) { const d = VP.ALPH.indexOf(c); if (d < 0) return null; n = n * 58n + BigInt(d); }
  const out = []; while (n) { out.unshift(Number(n & 255n)); n >>= 8n; }
  for (const c of s) { if (c !== '1') break; out.unshift(0); }
  return Uint8Array.from(out);
}
if (CFG.payTo && (b58dec(CFG.payTo) || []).length !== 32) throw new Error(`PAY_TO is not a Solana address: ${CFG.payTo}`);
if (CFG.payTo && !(CFG.priceSol >= 0 && CFG.priceSolPerHour >= 0)) throw new Error('PRICE_SOL and PRICE_SOL_PER_HOUR must be numbers of 0 or more');

const sol = lamports => (lamports / 1e9).toFixed(9).replace(/\.?0+$/, '');
const priceLamports = avgSeconds => Math.round(Math.round((CFG.priceSol + CFG.priceSolPerHour * avgSeconds / 3600) * 1e9) / 1e5) * 1e5;   // to the nearest 0.0001 SOL
const usedSigs = new Map();   // payment signature -> time accepted, so one transfer pays for one job

async function rpc(method, params) {
  const r = await fetch(CFG.rpc, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(10_000),
  });
  if (!r.ok) throw new Error(`${method}: HTTP ${r.status}`);
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}

let blockhash = { at: 0, value: null };
function latestBlockhash() {
  if (Date.now() - blockhash.at > 10_000) {
    blockhash = { at: Date.now(), value: rpc('getLatestBlockhash', [{ commitment: 'confirmed' }]).then(r => r.value.blockhash) };
    blockhash.value.catch(() => { blockhash.at = 0; });
  }
  return blockhash.value;
}

// Accepts a confirmed, successful transaction that lists the job's reference and raised PAY_TO by the price.
async function acceptPayment(job, signature) {
  if (usedSigs.has(signature)) return false;
  const tx = await rpc('getTransaction', [signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 }]);
  if (!tx || !tx.meta || tx.meta.err) return false;
  const { writable = [], readonly = [] } = tx.meta.loadedAddresses || {};
  const keys = [...tx.transaction.message.accountKeys, ...writable, ...readonly];
  const i = keys.indexOf(CFG.payTo);
  if (!keys.includes(job.pay.reference) || i < 0 || tx.meta.postBalances[i] - tx.meta.preBalances[i] < job.pay.lamports) return false;
  if (job.status !== 'unpaid' || usedSigs.has(signature)) return false;
  usedSigs.set(signature, Date.now());
  job.paid = { signature, payer: keys[0] };
  job.status = 'queued'; queue.push(job);
  log(`job ${job.id.slice(0, 8)} paid ${sol(job.pay.lamports)} SOL by ${keys[0]} (${signature})`);
  savePaid(); setImmediate(runNext);
  return true;
}

// The signature the page got from the wallet is checked first; the reference lookup also finds a payment
// whose page closed before it could report one.
async function findPayment(job) {
  if (job.pay.hint && await acceptPayment(job, job.pay.hint)) return;
  const sigs = await rpc('getSignaturesForAddress', [job.pay.reference, { limit: 20, commitment: 'confirmed' }]);
  for (const s of sigs) if (!s.err && s.signature !== job.pay.hint && await acceptPayment(job, s.signature)) return;
}

// Looks for the payment every 2 seconds once the page reports one, otherwise every 10; callers share a running check.
function checkPayment(job) {
  const p = job.pay;
  if (job.status === 'unpaid' && !p.check && Date.now() - p.checkedAt >= (p.hint ? 2000 : 10_000)) {
    p.check = findPayment(job)
      .catch(e => { log(`job ${job.id.slice(0, 8)} payment check failed: ${e.message}`); return false; })
      .finally(() => { p.check = null; p.checkedAt = Date.now(); });
  }
  return p.check || Promise.resolve();
}

// Paid jobs whose result has not reached the browser are saved, so a restart runs them again instead of losing
// the payment. Only the request is saved (pattern, the browser's public key, the payment), never a key or a result.
function savePaid() {
  const list = [...jobs.values()].filter(j => j.paid && !j.delivered && ['queued', 'running', 'done'].includes(j.status)).map(j => ({
    id: j.id, prefix: j.a.preRaw, suffix: j.a.sufRaw, anyCase: j.a.anyCase, recipientKey: j.spki, ip: j.ip, created: j.created,
    pay: { lamports: j.pay.lamports, reference: j.pay.reference }, paid: j.paid,
  }));
  try { writeFileSync(CFG.paidFile + '.tmp', JSON.stringify(list)); renameSync(CFG.paidFile + '.tmp', CFG.paidFile); }
  catch (e) { log('could not save paid jobs:', e.message); }
}
async function loadPaid() {
  let list;
  try { list = JSON.parse(readFileSync(CFG.paidFile, 'utf8')); } catch { return; }
  for (const p of list) {
    try {
      const job = { id: p.id, a: VP.analyze(p.prefix, p.suffix, p.anyCase), rsa: await importRecipient(p.recipientKey), spki: p.recipientKey, ip: p.ip,
        status: 'queued', tries: 0, rate: 0, created: p.created, seenAt: Date.now(), pay: { ...p.pay, expiresAt: 0, checkedAt: 0, check: null }, paid: p.paid };
      jobs.set(job.id, job); queue.push(job); usedSigs.set(p.paid.signature, Date.now());
      log(`job ${job.id.slice(0, 8)} resumed after a restart (paid by ${p.paid.payer})`);
    } catch (e) { log(`could not resume paid job ${p.id}: ${e.message}`); }
  }
}

function payInfo(j) {
  return { to: CFG.payTo, lamports: j.pay.lamports, amount: sol(j.pay.lamports), reference: j.pay.reference, chain: 'solana:' + CFG.cluster,
    expiresIn: Math.max(0, Math.round((j.pay.expiresAt - Date.now()) / 1000)) };
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
    pay: j.status === 'unpaid' ? payInfo(j) : undefined,
    paid: j.paid ? j.paid.signature : undefined,
    error: j.error || undefined,
  };
}

async function runNext() {
  if (current || !queue.length) return;
  const job = queue.shift();
  current = job; job.status = 'running'; job.startedAt = Date.now();
  // Free jobs stop at 5x their average; paid ones keep going to MAX_RUN_SECONDS so a slow run still delivers.
  const limitMs = (job.paid ? CFG.maxRunSec : Math.min(CFG.maxRunSec, 5 / (job.a.p * engine.rate) + 120)) * 1000;
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
      if (job.paid) log(`job ${job.id.slice(0, 8)} hit the time limit; it was paid by ${job.paid.payer} (${job.paid.signature})`);
    }
  } catch (e) {
    log(`job ${job.id.slice(0, 8)} failed${job.paid ? `; it was paid by ${job.paid.payer} (${job.paid.signature})` : ''}`, e); job.status = 'failed'; job.error = 'engine';
  } finally {
    job.finishedAt = Date.now(); job.rsa = null; current = null;
    if (job.paid) savePaid();
    setImmediate(runNext);
  }
}

function cancel(job, reason) {
  if (job.status === 'queued' || job.status === 'unpaid') { const i = queue.indexOf(job); if (i >= 0) queue.splice(i, 1); job.finishedAt = Date.now(); }
  if (job.status === 'queued' || job.status === 'running' || job.status === 'unpaid') { job.status = 'canceled'; job.error = reason; job.rsa = null; }
  if (job.paid) savePaid();
}

// Paid jobs keep running when their page goes away; the page picks the result up when it comes back.
setInterval(() => {
  const t = Date.now();
  for (const j of jobs.values()) {
    const idle = t - j.seenAt > CFG.abandonSec * 1000;
    // A transfer sent in the last seconds of the window gets 90 more to confirm.
    const late = j.status === 'unpaid' && t > j.pay.expiresAt + 90_000;
    if (j.status === 'unpaid' && (idle || late)) checkPayment(j).then(ok => { if (ok !== false && j.status === 'unpaid') cancel(j, idle ? 'abandoned' : 'pay-expired'); });
    else if (idle && !j.paid && (j.status === 'queued' || j.status === 'running')) cancel(j, 'abandoned');
    const ttl = (j.paid ? CFG.paidResultTtlSec : CFG.resultTtlSec) * 1000;
    if (j.finishedAt && t - j.finishedAt > ttl) { jobs.delete(j.id); if (j.paid && !j.delivered) savePaid(); }
  }
  for (const [sig, at] of usedSigs) if (t - at > 7 * 86400 * 1000) usedSigs.delete(sig);
}, 30_000).unref();

/* ---------------- http ---------------- */
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.wgsl': 'text/plain; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.txt': 'text/plain; charset=utf-8', '.woff2': 'font/woff2' };
const CSP = [
  "default-src 'self'", "script-src 'self' 'unsafe-inline'", "worker-src 'self' blob:",
  "style-src 'self' 'unsafe-inline'", "font-src 'self'",
  "connect-src 'self'", "img-src 'self' data:", "frame-ancestors 'none'", "base-uri 'none'", "form-action 'none'",
].join('; ');
const BASE_HEADERS = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': CSP };

function send(res, code, body, headers = {}) {
  const isObj = typeof body === 'object' && !(body instanceof Buffer);
  res.writeHead(code, { ...BASE_HEADERS, 'Content-Type': isObj ? 'application/json' : 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(isObj ? JSON.stringify(body) : body);
}
function origin(req) {
  const proto = CFG.trustProxy && req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
  return `${proto}://${String(req.headers.host || 'localhost').replace(/[^A-Za-z0-9.:\[\]-]/g, '')}`;
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
  const open = [...jobs.values()].filter(j => j.status === 'queued' || j.status === 'running' || j.status === 'unpaid');
  if (open.filter(j => j.ip === ip).length >= CFG.maxJobsPerIp) return send(res, 429, { error: 'one-at-a-time' });
  if (queue.length >= CFG.maxQueue || (CFG.payTo && open.filter(j => j.status === 'unpaid').length >= CFG.maxUnpaid)) return send(res, 503, { error: 'queue-full' });
  let rsa;
  try { rsa = await importRecipient(body.recipientKey); } catch { return send(res, 400, { error: 'bad-key' }); }
  const job = { id: randomBytes(16).toString('hex'), a, rsa, spki: String(body.recipientKey), ip, status: 'queued', tries: 0, rate: 0, created: Date.now(), seenAt: Date.now() };
  if (CFG.payTo) {
    job.status = 'unpaid';
    job.pay = { lamports: priceLamports(avgSeconds), reference: VP.b58(randomBytes(32)), expiresAt: Date.now() + CFG.payWindowSec * 1000, checkedAt: Date.now(), check: null };
  }
  jobs.set(job.id, job);
  if (job.status === 'queued') { queue.push(job); setImmediate(runNext); }
  log(`job ${job.id.slice(0, 8)} ${job.pay ? `waiting for ${sol(job.pay.lamports)} SOL` : 'queued'}: "${a.preRaw}…${a.sufRaw}" anyCase=${a.anyCase} avg≈${Math.round(avgSeconds)}s`);
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
    let data = await readFile(file);
    if (ext === '.html') data = renderPage(data.toString('utf8'), SITE, origin(req));
    res.writeHead(200, { ...BASE_HEADERS, 'Content-Type': TYPES[ext], 'Cache-Control': ext === '.html' ? 'no-cache' : ext === '.woff2' ? 'public, max-age=31536000, immutable' : 'public, max-age=300' });
    res.end(req.method === 'HEAD' ? undefined : data);
  } catch { send(res, 404, 'Not found'); }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    if (CFG.trustProxy && req.headers['x-forwarded-proto'] === 'https') res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    if (p === '/api/status' && req.method === 'GET') {
      const pay = CFG.payTo ? { to: CFG.payTo, priceSol: CFG.priceSol, priceSolPerHour: CFG.priceSolPerHour, chain: 'solana:' + CFG.cluster } : null;
      return send(res, 200, { engine: engine.kind, device: engine.device, rate: Math.round(engine.rate), queue: queue.length + (current ? 1 : 0), maxExpectedSeconds: CFG.maxExpectedSec, maxTotal: VP.MAX_TOTAL, pay, chain: 'solana:' + CFG.cluster });
    }
    // Visitors' wallets need a recent blockhash for any transfer the page builds (a payment, or SOL sent to a new address).
    if (p === '/api/blockhash' && req.method === 'GET') {
      try { return send(res, 200, { blockhash: await latestBlockhash() }); }
      catch (e) { log('blockhash failed:', e.message); return send(res, 502, { error: 'rpc' }); }
    }
    if (p === '/api/jobs' && req.method === 'POST') return createJob(req, res);
    const m = p.match(/^\/api\/jobs\/([0-9a-f]{32})(\/paid)?$/);
    if (m) {
      const job = jobs.get(m[1]);
      if (!job) return send(res, 404, { error: 'gone' });
      if (m[2]) {
        // The page reports the signature its wallet returned, so the server checks that transaction right away.
        if (req.method !== 'POST' || !job.pay) return send(res, 405, { error: 'method' });
        let body;
        try { body = await readJson(req, 1024); } catch { return send(res, 400, { error: 'bad-request' }); }
        const sig = String(body.signature || '');
        if (!/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(sig)) return send(res, 400, { error: 'bad-signature' });
        if (job.status === 'unpaid') { job.pay.hint = sig; job.seenAt = Date.now(); checkPayment(job); }
        return send(res, 200, view(job));
      }
      if (req.method === 'GET') {
        job.seenAt = Date.now();
        if (job.status === 'unpaid') checkPayment(job);
        if (job.status === 'done' && job.paid && !job.delivered) { job.delivered = true; savePaid(); }
        return send(res, 200, view(job));
      }
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
if (CFG.payTo) { await loadPaid(); setImmediate(runNext); }
log(CFG.payTo ? `Fast mode payments: ${CFG.priceSol} SOL + ${CFG.priceSolPerHour} SOL/hr to ${CFG.payTo} on ${CFG.cluster} via ${new URL(CFG.rpc).host}` : 'Fast mode is free (set PAY_TO to charge for it)');
if (CFG.payTo && !hasContact(SITE)) log('warning: set CONTACT_EMAIL or CONTACT_TELEGRAM so paying customers can reach you for refunds');
if (CFG.payTo && CFG.cluster === 'mainnet' && !env('SOLANA_RPC', '')) log("warning: payments use Solana's public mainnet RPC, which rate-limits busy sites; set SOLANA_RPC to a provider URL");
server.listen(CFG.port, CFG.host, () => log(`Vanity server listening on http://${CFG.host}:${CFG.port}`));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { log('shutting down'); server.close(); process.exit(0); });
