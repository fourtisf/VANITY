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
const fail = msg => { console.error('FAIL:', msg); if (server) server.kill(); rmSync(PAID_JOBS_FILE, { force: true }); rmSync(PAID_JOBS_FILE + '.history', { force: true }); process.exit(1); };

/* ---- fake RPC: the test lands transactions on it ---- */
const PAY_TO = key(), SYSTEM = '11111111111111111111111111111111';
const byRef = new Map(), byId = new Map();
// indexed: false plays an RPC that has the transaction but has not indexed it under the reference yet.
function addTx(reference, lamports, { err = null, sig = VP.b58(randomBytes(64)), indexed = true, payer = key() } = {}) {
  const keys = [payer, PAY_TO, ...(reference ? [reference] : []), SYSTEM];
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
const wallet = generateKeyPairSync('ed25519'), walletAddress = VP.b58(wallet.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32));
function signedTransfer({ to = PAY_TO, lamports, reference }) {
  const { publicKey, privateKey } = wallet;
  const keys = [publicKey.export({ format: 'der', type: 'spki' }).subarray(-32), b58dec(to), ...(reference ? [b58dec(reference)] : [])];
  const data = Buffer.alloc(12); data.writeUInt32LE(2, 0); data.writeBigUInt64LE(BigInt(lamports), 4);
  const msg = Buffer.from([1, 0, keys.length - 1, keys.length + 1, ...Buffer.concat(keys), ...Buffer.alloc(32), ...randomBytes(32),
    1, keys.length, keys.length, ...keys.map((_, i) => i), data.length, ...data]);
  const tx = Buffer.concat([Buffer.from([1]), sign(null, msg, privateKey), msg]).toString('base64');
  sent.set(tx, { reference, lamports, sig: VP.b58(Buffer.from(tx, 'base64').subarray(1, 65)), payer: walletAddress });
  return tx;
}
function relayed(b64) {
  const t = sent.get(b64);
  if (!t) return undefined;
  addTx(t.reference, t.lamports, { sig: t.sig, payer: t.payer });
  return t.sig;
}

/* ---- server under test ---- */
const port = 20000 + Math.floor(Math.random() * 20000), base = `http://127.0.0.1:${port}`;
const savedJobs = () => { try { return JSON.parse(readFileSync(PAID_JOBS_FILE, 'utf8')).map(j => j.id); } catch { return []; } };
async function startServer() {
  server = spawn(process.execPath, [fileURLToPath(new URL('../server.js', import.meta.url))], {
    env: { ...process.env, ENV_FILE: path.join(tmpdir(), 'no-such.env'), ENGINE: 'cpu', CPU_THREADS: '2', HOST: '127.0.0.1', PORT: String(port), PAY_TO, PAID_JOBS_FILE, HISTORY_FILE: PAID_JOBS_FILE + '.history', TRUST_PROXY: '1', MAX_UNPAID: '1', SLICE_SECONDS: '2',
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

// My addresses: the paying wallet signs a fresh challenge and gets back the address it paid for; nobody else does.
const history = async (signer = wallet.privateKey, reuse) => {
  const { message } = reuse || await api('/api/history/challenge', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ wallet: walletAddress }) });
  const signature = sign(null, Buffer.from(message), signer).toString('base64');
  return { message, res: await api('/api/history', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ wallet: walletAddress, message, signature }) }) };
};
const h1 = await history();
if (h1.res.code !== 200 || !h1.res.addresses.some(h => h.address === j4.address && h.prefix === 'A')) fail('paying wallet does not see its address: ' + JSON.stringify(h1.res));
if ((await history(undefined, { message: h1.message })).res.code !== 401) fail('a used sign-in message worked twice');
if ((await history(generateKeyPairSync('ed25519').privateKey)).res.code !== 401) fail('another key signed in as the paying wallet');
console.log('address history: the paying wallet signs in and sees its address; reused or foreign signatures refused: ok');

// Key backups: only the page of a paid job leaves one, once, for the paying wallet. Signed in, the wallet adds keypair-file
// backups and removes addresses; a backup locked by a wallet that signs differently from before is refused.
const post = (p, body) => api(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const chk = randomBytes(16).toString('base64');
const blob = (c = chk) => ({ host: 'vanity.example', iv: randomBytes(12).toString('base64'), ct: randomBytes(80).toString('base64'), chk: c });
const jobVault = blob();
if ((await post(`/api/jobs/${job4.id}/vault`, { wallet: key(), vault: jobVault })).code !== 409) fail('another wallet left a key backup for a paid job');
if ((await post(`/api/jobs/${job4.id}/vault`, { wallet: walletAddress, vault: { ...jobVault, ct: 'short' } })).code !== 400) fail('a malformed key backup was taken');
if ((await post(`/api/jobs/${job4.id}/vault`, { wallet: walletAddress, vault: jobVault, mode: 'token' })).code !== 200) fail('key backup of a paid job refused');
if ((await post(`/api/jobs/${job4.id}/vault`, { wallet: walletAddress, vault: blob() })).code !== 409) fail('a key backup was replaced');
const h2 = await history();
const mineJ4 = h2.res.addresses.find(h => h.address === j4.address);
if (!mineJ4 || mineJ4.vault.ct !== jobVault.ct || mineJ4.mode !== 'token' || !/^[0-9a-f]{48}$/.test(h2.res.token)) fail('key backup not listed for its wallet: ' + JSON.stringify(h2.res));
const token = h2.res.token, fileAddr = key(), handAddr = key(), oddAddr = key();
if ((await post('/api/vault', { token: 'f'.repeat(48), items: [{ address: fileAddr }] })).code !== 401) fail('changes taken without signing in');
const added = await post('/api/vault', { token, items: [{ address: fileAddr, vault: blob() }, { address: handAddr, pl: 2 }, { address: oddAddr, vault: blob(randomBytes(16).toString('base64')) }, { address: 'nope' }] });
const [rf, rh, ro, rn] = added.results || [];
if (added.code !== 200 || rf.entry.kind !== 'file' || !rf.entry.vault || rh.entry.kind !== 'manual' || rh.entry.prefix !== handAddr.slice(0, 2) || ro.error !== 'mismatch' || rn.error !== 'bad-address')
  fail('adding addresses: ' + JSON.stringify(added));
if ((await post('/api/vault/delete', { token, address: fileAddr })).code !== 200) fail('remove refused');
const h3 = (await history()).res.addresses.map(h => h.address);
if (h3.includes(fileAddr) || !h3.includes(handAddr) || h3.includes(oddAddr)) fail('wallet list after changes: ' + JSON.stringify(h3));
console.log('key backups: one per paid job from its paying wallet; signed-in adds and removes; a wallet that signs differently refused: ok');

// Long paid searches are accepted, and the engine takes turns: a one-key search paid after a days-long one is
// done within a turn or two, and the long one keeps going.
const pay = async (j, ms) => { report(j.id, addTx(j.pay.reference, j.pay.lamports)); return watch(j.id, ms); };
const long = await newJob('Abcdef', false, '10.0.0.5');
if (long.code !== 201 || !(long.avgSeconds > 3600)) fail('a long paid search was refused: ' + JSON.stringify(long));
if ((await pay(long)).status !== 'running') fail('long search did not start');
await sleep(3000);
const short = await newJob('A', true, '10.0.0.6');
const t0 = Date.now(); await pay(short);
let sj; do { sj = await api('/api/jobs/' + short.id); await sleep(200); } while (sj.status !== 'done' && Date.now() - t0 < 15000);
if (sj.status !== 'done') fail('a short search waited behind a long one: ' + sj.status);
const triesThen = (await api('/api/jobs/' + long.id)).tries;
await sleep(5000);
const lj = await api('/api/jobs/' + long.id);
if (lj.status !== 'running' || !(lj.tries > triesThen)) fail('the long search did not go on: ' + JSON.stringify({ status: lj.status, tries: lj.tries, triesThen }));
if ((await api('/api/jobs/' + long.id, { method: 'DELETE' })).status !== 'canceled') fail('long search not canceled');
console.log(`long paid search accepted (${Math.round(long.avgSeconds / 3600)} h average); a short one paid after it was done in ${((Date.now() - t0) / 1000 - 5).toFixed(1)}s: ok`);

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

server.kill(); rpc.close(); rmSync(PAID_JOBS_FILE, { force: true }); rmSync(PAID_JOBS_FILE + '.history', { force: true });
console.log('ALL PAYMENT CHECKS PASSED');
