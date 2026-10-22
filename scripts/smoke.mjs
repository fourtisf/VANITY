// End-to-end check of a running server: status, a real Fast mode job, sealed delivery, and key verification.
// Usage: node scripts/smoke.mjs [baseUrl]   (default http://localhost:8080)
await import('../engine/pattern.js');
const { VanityPattern: VP } = globalThis;
const base = (process.argv[2] || 'http://localhost:8080').replace(/\/$/, '');
const S = crypto.subtle;
const fail = msg => { console.error('FAIL:', msg); process.exit(1); };

const status = await fetch(base + '/api/status').then(r => r.json()).catch(e => fail('cannot reach ' + base + ' (' + e.message + ')'));
console.log(`status: engine=${status.engine} device=${status.device} rate=${status.rate.toLocaleString()} keys/sec queue=${status.queue}`);
if (status.engine !== 'gpu') console.warn('note: server is running on CPU. On a GPU machine check `vulkaninfo --summary`.');

const page = await fetch(base + '/').then(r => r.text());
if (!page.includes('id="pre"')) fail('website did not load');
for (const f of ['engine/pattern.js', 'engine/gpu-engine.js', 'engine/vanity.wgsl', 'legal.html', 'robots.txt', 'og.png', 'icon-192.png', 'apple-touch-icon.png', 'favicon.ico', 'fonts/nunito.woff2', 'wallets/phantom.svg']) {
  const r = await fetch(base + '/' + f); if (!r.ok) fail(f + ' not served (' + r.status + ')');
}
if (page.includes('{{')) fail('page placeholders were not filled in');
console.log('website, legal page, fonts, logos and engine files: ok');

const kp = await S.generateKey({ name: 'RSA-OAEP', modulusLength: 3072, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, false, ['encrypt', 'decrypt']);
const spki = Buffer.from(await S.exportKey('spki', kp.publicKey)).toString('base64');
const prefix = 'A', suffix = 'x';
const res = await fetch(base + '/api/jobs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prefix, suffix, anyCase: true, recipientKey: spki }) });
const job = await res.json();
if (res.status !== 201) fail('job not created: ' + JSON.stringify(job));
if (status.pay) {
  // A paid server holds the job until the transfer lands, so check the payment request and the RPC link, then cancel.
  if (job.status !== 'unpaid' || !job.pay || job.pay.to !== status.pay.to || !(job.pay.lamports > 0)) fail('job is not waiting for payment: ' + JSON.stringify(job));
  const bh = await fetch(base + '/api/blockhash').then(r => r.json()).catch(e => ({ error: e.message }));
  await fetch(base + '/api/jobs/' + job.id, { method: 'DELETE' });
  if (!bh.blockhash) fail('server cannot reach the Solana RPC: ' + JSON.stringify(bh));
  console.log(`fast mode payment request: ok (${job.pay.amount} SOL to ${job.pay.to}; job canceled without paying)`);
  console.log('ALL CHECKS PASSED');
  process.exit(0);
}
const t0 = Date.now();
let j;
for (;;) {
  j = await fetch(base + '/api/jobs/' + job.id).then(r => r.json());
  if (j.status !== 'queued' && j.status !== 'running') break;
  if (Date.now() - t0 > 120000) fail('job took longer than 2 minutes');
  await new Promise(r => setTimeout(r, 400));
}
if (j.status !== 'done') fail('job ended as ' + j.status + ' ' + (j.error || ''));

const raw = await S.decrypt({ name: 'RSA-OAEP' }, kp.privateKey, Buffer.from(j.sealed.wrappedKey, 'base64'));
const aes = await S.importKey('raw', raw, { name: 'AES-GCM' }, false, ['decrypt']);
const sk = new Uint8Array(await S.decrypt({ name: 'AES-GCM', iv: Buffer.from(j.sealed.iv, 'base64') }, aes, Buffer.from(j.sealed.ciphertext, 'base64')));
const pkcs8 = new Uint8Array([0x30,0x2e,0x02,0x01,0x00,0x30,0x05,0x06,0x03,0x2b,0x65,0x70,0x04,0x22,0x04,0x20, ...sk.slice(0, 32)]);
const key = await S.importKey('pkcs8', pkcs8, { name: 'Ed25519' }, true, ['sign']);
const pub = Buffer.from((await S.exportKey('jwk', key)).x, 'base64url');
const addr = VP.b58(pub);
const a = VP.analyze(prefix, suffix, true);
if (addr !== j.address) fail('key does not produce the delivered address');
if (!VP.matcher(a.pre.sets, a.suf.sets)(addr)) fail('address does not match the pattern');
console.log(`fast mode job: ok (${j.address}, ${j.tries.toLocaleString()} keys, ${((Date.now() - t0) / 1000).toFixed(1)}s)`);
console.log('ALL CHECKS PASSED');
