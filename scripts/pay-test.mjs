// Fast mode payment check against a fake Solana RPC: limits, the payment window, short, failed and unrelated
// payments, a payment the page reports, one found by its reference alone, sealed delivery, the same transfer
// offered for a second job, and a paid job surviving a restart. Starts its own server on CPU threads.
// Usage: node scripts/pay-test.mjs
import http from 'node:http';
import { spawn } from 'node:child_process';
import { randomBytes, generateKeyPairSync, sign } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
await import('../engine/pattern.js');
const { VanityPattern: VP } = globalThis;
const S = crypto.subtle;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const key = () => VP.b58(randomBytes(32));
let server;
const PAID_JOBS_FILE = path.join(tmpdir(), `vanity-paid-${process.pid}.json`);
const fail = msg => { console.error('FAIL:', msg); if (server) server.kill(); rmSync(PAID_JOBS_FILE, { force: true }); process.exit(1); };

/* ---- fake RPC: the test lands transactions on it ---- */
const PAY_TO = key(), SYSTEM = '11111111111111111111111111111111';
const byRef = new Map(), byId = new Map();
// indexed: false plays an RPC that has the transaction but has not indexed it under the reference yet.
function addTx(reference, lamports, { err = null, sig = VP.b58(randomBytes(64)), indexed = true } = {}) {
  const keys = [key(), PAY_TO, ...(reference ? [reference] : []), SYSTEM];
  const pre = keys.map(() => 1e9), post = [...pre];
  if (!err) { post[0] -= 5000 + lamports; post[1] += lamports; } else post[0] -= 5000;
  byId.set(sig, { slot: 1, blockTime: Math.floor(Date.now() / 1000),
    meta: { err, fee: 5000, preBalances: pre, postBalances: post, loadedAddresses: { writable: [], readonly: [] } },
    transaction: { signatures: [sig], message: { accountKeys: keys } } });
  if (reference && indexed) byRef.set(reference, [{ signature: sig, err }, ...(byRef.get(reference) || [])]);
  return sig;
}
const rpc = http.createServer((req, res) => {
  let body = ''; req.on('data', c => body += c); req.on('end', () => {
    const { id, method, params } = JSON.parse(body);
    const result = method === 'getLatestBlockhash' ? { context: { slot: 1 }, value: { blockhash: key(), lastValidBlockHeight: 100 } }
      : method === 'getSignaturesForAddress' ? (byRef.get(params[0]) || [])
      : method === 'getTransaction' ? (byId.get(params[0]) || null)
      : method === 'sendTransaction' ? relayed(params[0]) : undefined;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(result === undefined ? { jsonrpc: '2.0', id, error: { code: -32601, message: 'no ' + method } } : { jsonrpc: '2.0', id, result }));
  });
});
await new Promise(r => rpc.listen(0, '127.0.0.1', r));

// A transfer signed the way a wallet signs the page's transaction (legacy, one System transfer from the signer).
const b58dec = s => { let n = 0n; for (const c of s) n = n * 58n + BigInt(VP.ALPH.indexOf(c)); const out = []; while (n) { out.unshift(Number(n & 255n)); n >>= 8n; } while (out.length < 32) out.unshift(0); return Buffer.from(out); };
const sent = new Map();   // base64 transaction -> what it pays (the fake chain lands it when sent)
function signedTransfer({ to = PAY_TO, lamports, reference }) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const keys = [publicKey.export({ format: 'der', type: 'spki' }).subarray(-32), b58dec(to), ...(reference ? [b58dec(reference)] : [])];
  const data = Buffer.alloc(12); data.writeUInt32LE(2, 0); data.writeBigUInt64LE(BigInt(lamports), 4);
  const msg = Buffer.from([1, 0, keys.length - 1, keys.length + 1, ...Buffer.concat(keys), ...Buffer.alloc(32), ...randomBytes(32),
    1, keys.length, keys.length, ...keys.map((_, i) => i), data.length, ...data]);
  const tx = Buffer.concat([Buffer.from([1]), sign(null, msg, privateKey), msg]).toString('base64');
  sent.set(tx, { reference, lamports, sig: VP.b58(Buffer.from(tx, 'base64').subarray(1, 65)) });
  return tx;
}
function relayed(b64) {
  const t = sent.get(b64);
  if (!t) return undefined;
  addTx(t.reference, t.lamports, { sig: t.sig });
  return t.sig;
}

/* ---- server under test ---- */
const port = 20000 + Math.floor(Math.random() * 20000), base = `http://127.0.0.1:${port}`;
const savedJobs = () => { try { return JSON.parse(readFileSync(PAID_JOBS_FILE, 'utf8')).map(j => j.id); } catch { return []; } };
async function startServer() {
  server = spawn(process.execPath, [fileURLToPath(new URL('../server.js', import.meta.url))], {
    env: { ...process.env, ENV_FILE: path.join(tmpdir(), 'no-such.env'), ENGINE: 'cpu', CPU_THREADS: '2', HOST: '127.0.0.1', PORT: String(port), PAY_TO, PAID_JOBS_FILE, TRUST_PROXY: '1', MAX_UNPAID: '1',
      CONTACT_EMAIL: 'help@example.com', SOLANA_RPC: `http://127.0.0.1:${rpc.address().port}` },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((resolve, reject) => {
    server.stdout.on('data', d => { if (process.env.VERBOSE) process.stdout.write(d); if (String(d).includes('listening')) resolve(); });
    server.on('exit', c => reject(new Error('server exited ' + c)));
  }).catch(e => fail(e.message));
}
await startServer();

const api = (p, opts = {}, ip = '10.0.0.1') => fetch(base + p, { ...opts, headers: { 'x-forwarded-for': ip, ...(opts.headers || {}) } }).then(async r => ({ code: r.status, ...(await r.json()) }));
const status = await api('/api/status');
if (!status.pay || status.pay.to !== PAY_TO) fail('status does not announce payments: ' + JSON.stringify(status));
const bh = await api('/api/blockhash');
if (!bh.blockhash) fail('no blockhash: ' + JSON.stringify(bh));
console.log('status and blockhash: ok');

const kp = await S.generateKey({ name: 'RSA-OAEP', modulusLength: 3072, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, false, ['encrypt', 'decrypt']);
const spki = Buffer.from(await S.exportKey('spki', kp.publicKey)).toString('base64');
const newJob = (prefix = 'A', anyCase = true, ip) => api('/api/jobs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prefix, suffix: '', anyCase, recipientKey: spki }) }, ip);
const report = (id, signature) => api(`/api/jobs/${id}/paid`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ signature }) });
async function watch(id, ms = 3500) {
  let j; const t0 = Date.now();
  do { j = await api('/api/jobs/' + id); if (j.status !== 'unpaid') break; await sleep(300); } while (Date.now() - t0 < ms);
  return j;
}

const job = await newJob();
if (job.code !== 201 || job.status !== 'unpaid' || !job.pay) fail('job not waiting for payment: ' + JSON.stringify(job));
const { lamports, reference } = job.pay;
if (!(lamports >= 1e7) || !(job.pay.expiresIn > 880 && job.pay.expiresIn <= 900) || job.pay.chain !== 'solana:mainnet') fail('bad payment request: ' + JSON.stringify(job.pay));
if ((await newJob('A', true, '10.0.0.1')).code !== 429) fail('a second unpaid job from the same visitor was accepted');
if ((await newJob('A', true, '10.0.0.2')).code !== 503) fail('MAX_UNPAID was not enforced');
if ((await report(job.id, 'not-a-signature')).code !== 400) fail('a malformed signature was accepted');
console.log(`payment request: ok (${job.pay.amount} SOL, ${job.pay.expiresIn}s to pay); visitor and unpaid limits hold`);

// Each refused payment is reported by "the page", so the server checks it within 2 seconds.
for (const [what, sig] of [
  ['a short payment', addTx(reference, lamports - 1)],
  ['a failed payment', addTx(reference, lamports, { err: { InstructionError: [0, 'Custom'] } })],
  ['a payment without the reference', addTx(null, lamports)],
]) {
  await report(job.id, sig);
  if ((await watch(job.id)).status !== 'unpaid') fail('job started on ' + what);
}
console.log('short, failed and unrelated payments are refused');

const sig = addTx(reference, lamports, { indexed: false });
await report(job.id, sig);
let j = await watch(job.id);
if (j.status === 'unpaid' || j.paid !== sig) fail('reported payment not accepted: ' + JSON.stringify(j));
for (const t0 = Date.now(); j.status === 'queued' || j.status === 'running'; j = await api('/api/jobs/' + job.id)) {
  if (Date.now() - t0 > 120000) fail('paid job took longer than 2 minutes');
  await sleep(300);
}
if (j.status !== 'done') fail('paid job ended as ' + j.status + ' ' + (j.error || ''));
const raw = await S.decrypt({ name: 'RSA-OAEP' }, kp.privateKey, Buffer.from(j.sealed.wrappedKey, 'base64'));
const aes = await S.importKey('raw', raw, { name: 'AES-GCM' }, false, ['decrypt']);
const sk = new Uint8Array(await S.decrypt({ name: 'AES-GCM', iv: Buffer.from(j.sealed.iv, 'base64') }, aes, Buffer.from(j.sealed.ciphertext, 'base64')));
const pkcs8 = new Uint8Array([0x30,0x2e,0x02,0x01,0x00,0x30,0x05,0x06,0x03,0x2b,0x65,0x70,0x04,0x22,0x04,0x20, ...sk.slice(0, 32)]);
const pub = Buffer.from((await S.exportKey('jwk', await S.importKey('pkcs8', pkcs8, { name: 'Ed25519' }, true, ['sign']))).x, 'base64url');
if (VP.b58(pub) !== j.address || !/^[Aa]/.test(j.address)) fail('delivered key does not match ' + j.address);
if (savedJobs().length) fail('delivered job still saved for a restart');
console.log(`reported payment and paid job: ok (${j.address})`);

const job2 = await newJob();
if (job2.code !== 201) fail('second job not created: ' + JSON.stringify(job2));
addTx(job2.pay.reference, job2.pay.lamports, { sig });
await report(job2.id, sig);
if ((await watch(job2.id)).status !== 'unpaid') fail('one transfer paid for two jobs');
const gone = await api('/api/jobs/' + job2.id, { method: 'DELETE' });
if (gone.status !== 'canceled') fail('unpaid job not canceled: ' + JSON.stringify(gone));
console.log('reused transfer refused, unpaid job canceled: ok');

// A wallet that signs but cannot send: the page hands the signed payment to the server, which sends only an exact
// payment for that job.
const job4 = await newJob();
if (job4.code !== 201) fail('relay job not created: ' + JSON.stringify(job4));
const relay = tx => api(`/api/jobs/${job4.id}/send`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ transaction: tx }) });
const r4 = job4.pay.reference, l4 = job4.pay.lamports;
for (const [what, tx, code] of [
  ['garbage', Buffer.from('not a transaction').toString('base64'), 400],
  ['a transfer to someone else', signedTransfer({ to: key(), lamports: l4, reference: r4 }), 400],
  ['a short transfer', signedTransfer({ lamports: l4 - 1, reference: r4 }), 400],
  ['a transfer without the reference', signedTransfer({ lamports: l4 }), 400],
]) if ((await relay(tx)).code !== code) fail('the server relayed ' + what);
const good = await relay(signedTransfer({ lamports: l4, reference: r4 }));
if (good.code !== 200 || !good.signature) fail('valid payment not relayed: ' + JSON.stringify(good));
let j4 = await watch(job4.id);
if (j4.paid !== good.signature) fail('relayed payment not accepted: ' + JSON.stringify(j4));
for (const t0 = Date.now(); j4.status === 'queued' || j4.status === 'running'; j4 = await api('/api/jobs/' + job4.id)) {
  if (Date.now() - t0 > 120000) fail('relayed job took longer than 2 minutes');
  await sleep(300);
}
if ((await relay(signedTransfer({ lamports: l4, reference: r4 }))).code !== 409) fail('a paid job took another payment');
console.log('signed payment sent by the server: only an exact payment for the job, then paid: ok');

// A payment the page never reported (it closed first) is found by its reference within ~10 seconds,
// and a paid job that is still searching comes back after a restart under the same id.
const slow = VP.analyze('Abcd', '', false);
if (1 / (slow.p * status.rate) < 20) fail('test pattern too easy for this machine');
const job3 = await newJob('Abcd', false);
const sig3 = addTx(job3.pay.reference, job3.pay.lamports);
if ((await watch(job3.id, 13000)).paid !== sig3) fail('unreported payment not found by its reference');
if (!savedJobs().includes(job3.id)) fail('paid job not saved for a restart');
server.kill('SIGTERM'); await new Promise(r => server.once('exit', r));
await startServer();
const back = await api('/api/jobs/' + job3.id);
if (!['queued', 'running'].includes(back.status) || back.paid !== sig3) fail('paid job lost in a restart: ' + JSON.stringify(back));
if ((await api('/api/jobs/' + job3.id, { method: 'DELETE' })).status !== 'canceled' || savedJobs().length) fail('canceled paid job still saved');
console.log('unreported payment found, paid job survives a restart: ok');

server.kill(); rpc.close(); rmSync(PAID_JOBS_FILE, { force: true });
console.log('ALL PAYMENT CHECKS PASSED');
