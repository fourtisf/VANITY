// Browser end-to-end check of Fast mode payments: the real page in Chromium, fake Wallet Standard wallets, and a
// fake Solana RPC that only learns about a payment when the page's own transaction is "sent". The transaction is
// decoded and signed with @solana/web3.js, so a malformed one fails here the way a real wallet would refuse it.
// Needs: npm i --no-save --omit=optional playwright@1.56.1 @solana/web3.js@1.98.4 && npx playwright install chromium
// Usage: node scripts/browser-test.mjs [screenshotDir]
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { chromium, devices } from 'playwright';
import web3 from '@solana/web3.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const shots = process.argv[2] || path.join(tmpdir(), 'vanity-shots');
mkdirSync(shots, { recursive: true });
await import('../engine/pattern.js');
const VP = globalThis.VanityPattern;
const key = () => VP.b58(randomBytes(32));
const PAID_JOBS_FILE = path.join(tmpdir(), `vanity-browser-${process.pid}.json`);
let server, browser;
const fail = msg => { console.error('FAIL:', msg); server?.kill(); browser?.close(); rmSync(PAID_JOBS_FILE, { force: true }); process.exit(1); };
const check = (ok, what) => { if (!ok) fail(what); };

/* ---- fake RPC ---- */
const PAY_TO = key(), BLOCKHASH = key();
const byAddr = new Map(), byId = new Map();
const rpc = http.createServer((req, res) => {
  let body = ''; req.on('data', c => body += c); req.on('end', () => {
    const { id, method, params } = JSON.parse(body);
    const result = method === 'getLatestBlockhash' ? { context: { slot: 1 }, value: { blockhash: BLOCKHASH, lastValidBlockHeight: 100 } }
      : method === 'getSignaturesForAddress' ? (byAddr.get(params[0]) || [])
      : method === 'getTransaction' ? (byId.get(params[0]) || null) : null;
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
  });
});
await new Promise(r => rpc.listen(0, '127.0.0.1', r));

const port = 20000 + Math.floor(Math.random() * 20000), base = `http://127.0.0.1:${port}`;
server = spawn(process.execPath, [path.join(root, 'server.js')], {
  env: { ...process.env, ENV_FILE: path.join(tmpdir(), 'no-such.env'), ENGINE: 'cpu', CPU_THREADS: '2', HOST: '127.0.0.1', PORT: String(port), PAY_TO, PAID_JOBS_FILE,
    SITE_NAME: 'Test Vanity', SITE_URL: 'https://vanity.example', CONTACT_EMAIL: 'help@vanity.example', SOLANA_RPC: `http://127.0.0.1:${rpc.address().port}` },
  stdio: ['ignore', 'pipe', 'inherit'],
});
await new Promise(r => server.stdout.on('data', d => { if (String(d).includes('listening')) r(); }));

/* ---- the "wallet": refuses the first payment, then signs and lands the transaction once released ---- */
const payer = web3.Keypair.generate();
let calls = 0, sent = null, release;
const sentAll = [];
const approved = new Promise(r => { release = r; });
async function sendTx(txBytes, chain) {
  if (++calls === 1) throw new Error('User rejected the request.');
  await approved;
  const tx = web3.Transaction.from(Buffer.from(txBytes));
  const ix = tx.instructions[0];
  if (tx.instructions.length !== 1 || !ix.programId.equals(web3.SystemProgram.programId)) throw new Error('not one system instruction');
  const t = web3.SystemInstruction.decodeTransfer(ix);
  const keys = tx.compileMessage().accountKeys.map(k => k.toBase58());
  sent = { chain, from: t.fromPubkey.toBase58(), to: t.toPubkey.toBase58(), lamports: Number(t.lamports), blockhash: tx.recentBlockhash,
    feePayer: tx.feePayer?.toBase58(), extra: ix.keys.slice(2).map(k => ({ signer: k.isSigner, writable: k.isWritable })) };
  sentAll.push(sent);
  tx.sign(payer);
  if (!tx.verifySignatures()) throw new Error('signature does not verify');
  const sig = VP.b58(tx.signature);
  const pre = keys.map(() => 1e9), post = [...pre], i = keys.indexOf(PAY_TO);
  post[0] -= 5000 + sent.lamports; if (i >= 0) post[i] += sent.lamports;
  byId.set(sig, { slot: 1, meta: { err: null, fee: 5000, preBalances: pre, postBalances: post, loadedAddresses: { writable: [], readonly: [] } }, transaction: { signatures: [sig], message: { accountKeys: keys } } });
  for (const k of keys) byAddr.set(k, [{ signature: sig, err: null }, ...(byAddr.get(k) || [])]);
  return Array.from(tx.signature);
}
// Same two-way handshake as @wallet-standard/wallet registerWallet().
const fakeWallet = (name, address, pub) => {
  const account = { address, publicKey: new Uint8Array(pub), chains: ['solana:mainnet'], features: ['solana:signAndSendTransaction'] };
  const icon = 'data:image/svg+xml,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" rx="3" fill="${name === 'Phantom' ? '#AB9FF2' : '#F5A623'}"/></svg>`);
  const wallet = {
    version: '1.0.0', name, icon, chains: ['solana:mainnet', 'solana:devnet'], accounts: [],
    features: {
      'standard:connect': { version: '1.0.0', connect: async ({ silent } = {}) => ({ accounts: silent ? [] : [account] }) },
      'solana:signAndSendTransaction': { version: '1.0.0', supportedTransactionVersions: ['legacy', 0],
        signAndSendTransaction: async ({ transaction, chain }) => [{ signature: new Uint8Array(await window.__sendTx(Array.from(transaction), chain)) }] },
    },
  };
  const cb = ({ register }) => register(wallet);
  try { window.dispatchEvent(new CustomEvent('wallet-standard:register-wallet', { detail: cb })); } catch {}
  try { window.addEventListener('wallet-standard:app-ready', ({ detail }) => cb(detail)); } catch {}
};
const walletArgs = name => `(${fakeWallet})(${JSON.stringify(name)}, ${JSON.stringify(payer.publicKey.toBase58())}, ${JSON.stringify(Array.from(payer.publicKey.toBytes()))})`;

browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
page.on('pageerror', e => fail('page error: ' + e.message));
page.on('request', r => { if (!/^(blob|data):/.test(r.url()) && !r.url().startsWith(base)) fail('page reached outside its own server: ' + r.url()); });
await page.exposeFunction('__sendTx', sendTx);
// "Phantom" is installed before the page loads (app-ready path); "Late Wallet" registers after (register-wallet path).
await page.addInitScript(walletArgs('Phantom'));
await page.goto(base + '/', { waitUntil: 'load' });
await page.evaluate(walletArgs('Late Wallet'));

/* ---- site details ---- */
check((await page.title()).includes('Test Vanity'), 'site name missing from the title');
check(await page.textContent('.brand') === 'Test Vanity', 'brand missing from the header');
check(await page.getAttribute('meta[property="og:image"]', 'content') === 'https://vanity.example/og.png', 'og:image not absolute');
check(await page.getAttribute('[data-contact]', 'href') === 'mailto:help@vanity.example', 'contact link missing');
check(await page.evaluate(() => document.fonts.check('700 20px Fredoka')), 'self-hosted font not loaded');
console.log('site details, contact, preview tags and fonts: ok');

/* ---- header: the visitor connects their own wallet; nothing from the site owner is needed ---- */
await page.waitForSelector('#hdrWallet:not([hidden])', { timeout: 30000 });
check(/Connect wallet/.test(await page.textContent('#hdrWallet')), 'header Connect wallet button');
await page.click('#hdrWallet');
await page.waitForSelector('#walletDlg[open]');
await page.click('#walletList .wrow:has-text("Late Wallet")');
await page.waitForFunction(() => document.querySelector('#hdrWallet').classList.contains('on'), null, { timeout: 10000 }).catch(() => fail('header did not show the connected wallet'));
check((await page.textContent('#hdrWallet')).includes('…'), 'header shows the short address');
await page.screenshot({ path: path.join(shots, 'header-connected.png'), clip: { x: 0, y: 0, width: 1280, height: 90 } });
await page.click('#hdrWallet');
await page.click('#hdrMenu [data-m="disconnect"]');
await page.waitForFunction(() => !document.querySelector('#hdrWallet').classList.contains('on'));
console.log('header Connect wallet, connected address, disconnect: ok');

/* ---- start a paid search ---- */
await page.waitForSelector('#fast:not([hidden])', { timeout: 30000 });
await page.click('#fast');
await page.fill('#pre', 'A');
await page.waitForFunction(() => /SOL$/.test(document.querySelector('#sCost').textContent), null, { timeout: 15000 }).catch(() => fail('cost does not show SOL'));
check(/from 0\.01 SOL/.test(await page.textContent('#faqCost')), 'FAQ price missing');
await page.waitForSelector('#go:not([disabled])', { timeout: 30000 });
await page.click('#go');
await page.waitForSelector('#paybox:not([hidden])', { timeout: 15000 }).catch(() => fail('pay box never appeared'));
check(await page.textContent('#payBtnText') === 'Connect wallet', 'pay button should ask to connect first');
await page.waitForFunction(() => /^1[45]:\d\d left$/.test(document.querySelector('#payTime').textContent), null, { timeout: 5000 }).catch(() => fail('no payment countdown'));

// A dropped connection must not lose a search that can be paid for.
await page.route('**/api/jobs/*', r => r.abort());
await page.waitForFunction(() => /Lost contact/.test(document.querySelector('#statusText').textContent), null, { timeout: 15000 }).catch(() => fail('no offline state'));
check(await page.isHidden('#runErr'), 'job failed on a dropped connection');
await page.unroute('**/api/jobs/*');
await page.waitForFunction(() => document.querySelector('#statusText').textContent === 'Waiting for your payment', null, { timeout: 15000 }).catch(() => fail('did not reconnect'));
console.log('pay box, countdown and dropped connection: ok');

/* ---- connect wallet ---- */
await page.click('#payBtn');
await page.waitForSelector('#walletDlg[open]');
const rows = await page.$$eval('#walletList .wrow', els => els.map(e => `${e.querySelector('span').textContent}:${e.querySelector('em').textContent}`));
check(JSON.stringify(rows) === JSON.stringify(['Phantom:Detected', 'Late Wallet:Detected', 'Solflare:Install', 'Backpack:Install']), 'wallet list: ' + rows);
check(await page.$$eval('#walletList img', els => els.every(i => i.complete && i.naturalWidth > 0)), 'a wallet logo did not load');
await page.locator('#walletDlg').screenshot({ path: path.join(shots, 'wallets.png') });
await page.click('#walletList .wrow:has-text("Phantom")');
await page.waitForFunction(() => /didn’t go through/.test(document.querySelector('#payMsg').textContent), null, { timeout: 10000 }).catch(() => fail('a refused payment was not reported'));
check(/^Pay 0\.01 SOL$/.test(await page.textContent('#payBtnText')), 'pay button not offered again after a refusal');
check(await page.textContent('#payWalletName') === 'Phantom' && /…/.test(await page.textContent('#payWalletAddr')), 'connected wallet not shown');
await page.click('#payBtn');
await page.waitForFunction(() => /Approve the payment/.test(document.querySelector('#payMsg').textContent));
await page.locator('#paybox').screenshot({ path: path.join(shots, 'paybox.png') });
release();
await page.waitForSelector('.res', { timeout: 60000 }).catch(async () => fail('no result; pay msg: ' + await page.textContent('#payMsg')));
const address = await page.textContent('.res .kv .v');
const amount = Math.round(0.01 * 1e9);
sent = sentAll[0];
check(sent.chain === 'solana:mainnet', 'chain');
check(sent.from === payer.publicKey.toBase58() && sent.feePayer === sent.from, 'payer');
check(sent.to === PAY_TO && sent.lamports === amount && sent.blockhash === BLOCKHASH, 'transfer');
check(sent.extra.length === 1 && !sent.extra[0].signer && !sent.extra[0].writable, 'reference is one read-only non-signer key');
check(/^[Aa]/.test(address) && await page.isHidden('#paybox'), 'result');
console.log(`connect wallet, refused then approved payment, delivery: ok (${address})`);

/* ---- Add SOL: a plain transfer from the connected wallet to the new address, only once the key is saved ---- */
await page.click('.res [data-act="fund"]');
await page.waitForFunction(() => /Save the private key first/.test(document.querySelector('.res [data-fundmsg]').textContent), null, { timeout: 5000 }).catch(() => fail('Add SOL ran before the key was saved'));
await page.click('.res [data-act="copyKey"]');
await page.fill('.res [data-amt]', '0.05');
await page.click('.res [data-act="fund"]');
await page.waitForFunction(() => /Sent 0\.05 SOL/.test(document.querySelector('.res [data-fundmsg]').textContent), null, { timeout: 15000 }).catch(async () => fail('Add SOL: ' + await page.textContent('.res [data-fundmsg]')));
const fund = sentAll[1];
check(fund && fund.from === payer.publicKey.toBase58() && fund.to === address.trim() && fund.lamports === 5e7 && fund.extra.length === 0, 'Add SOL transfer: ' + JSON.stringify(fund));
await page.locator('.res').screenshot({ path: path.join(shots, 'result-add-sol.png') });
console.log('Add SOL: refused until the key is saved, then a plain transfer to the new address: ok');

/* ---- phone without a wallet: reopen the page inside the wallet app ---- */
const phone = await browser.newContext({ ...devices['iPhone 13'] });
const mp = await phone.newPage();
mp.on('pageerror', e => fail('phone page error: ' + e.message));
await mp.goto(base + '/', { waitUntil: 'load' });
await mp.waitForSelector('#fast:not([hidden])', { timeout: 30000 });
await mp.click('#fast'); await mp.fill('#pre', 'Ab'); await mp.fill('#suf', 'x');
await mp.waitForSelector('#go:not([disabled])', { timeout: 30000 });
await mp.click('#go');
await mp.waitForSelector('#paybox:not([hidden])', { timeout: 15000 });
await mp.click('#payBtn');
await mp.waitForSelector('#walletDlg[open]');
const links = await mp.$$eval('#walletList a.wrow', els => els.map(a => [a.querySelector('span').textContent, a.querySelector('em').textContent, a.href]));
await mp.screenshot({ path: path.join(shots, 'phone-wallets.png') });
const ph = links.find(l => l[0] === 'Phantom');
check(ph && ph[1] === 'Open app' && ph[2].startsWith('https://phantom.app/ul/browse/'), 'phone Phantom link: ' + JSON.stringify(links));
const inner = decodeURIComponent(ph[2].slice('https://phantom.app/ul/browse/'.length).split('?')[0]);
check(links.find(l => l[0] === 'Solflare')[2].startsWith('https://solflare.com/ul/v1/browse/'), 'phone Solflare link');
await phone.close();
// What the wallet app opens: the same page with the search filled in and Fast mode on.
const app = await browser.newPage();
await app.goto(inner.replace('https://vanity.example', base), { waitUntil: 'load' });
await app.waitForFunction(() => document.querySelector('#fast').getAttribute('aria-checked') === 'true', null, { timeout: 30000 }).catch(() => fail('Fast mode not turned on from the wallet link'));
check(await app.inputValue('#pre') === 'Ab' && await app.inputValue('#suf') === 'x' && !app.url().includes('#fast'), 'fields not restored from the wallet link');
console.log('phone: wallet app links and reopened page: ok');

/* ---- free Fast mode (no PAY_TO): the header wallet and Add SOL are still there ---- */
const freePort = port + 1;
const freeServer = spawn(process.execPath, [path.join(root, 'server.js')], {
  env: { ...process.env, ENV_FILE: path.join(tmpdir(), 'no-such.env'), ENGINE: 'cpu', CPU_THREADS: '2', HOST: '127.0.0.1', PORT: String(freePort), PAY_TO: '',
    SOLANA_RPC: `http://127.0.0.1:${rpc.address().port}` },
  stdio: ['ignore', 'pipe', 'inherit'],
});
await new Promise(r => freeServer.stdout.on('data', d => { if (String(d).includes('listening')) r(); }));
const fp = await browser.newPage();
fp.on('pageerror', e => fail('free page error: ' + e.message));
await fp.goto(`http://127.0.0.1:${freePort}/`, { waitUntil: 'load' });
await fp.waitForSelector('#hdrWallet:not([hidden])', { timeout: 30000 });
check(!!(await fp.evaluate(() => fetch('api/blockhash').then(r => r.json()))).blockhash, 'no blockhash without PAY_TO');
await fp.waitForSelector('#fast:not([hidden])', { timeout: 30000 });
await fp.click('#fast'); await fp.fill('#pre', 'A');
await fp.waitForSelector('#go:not([disabled])', { timeout: 30000 });
await fp.click('#go');
await fp.waitForSelector('.res', { timeout: 60000 }).catch(() => fail('free Fast mode gave no result'));
check(await fp.isHidden('#paybox') && await fp.isVisible('.res [data-act="fund"]'), 'free mode: no pay box, Add SOL offered');
freeServer.kill();
console.log('free Fast mode: header wallet, no payment, Add SOL: ok');

/* ---- legal page ---- */
const legal = await browser.newPage();
await legal.goto(base + '/legal.html#refunds', { waitUntil: 'load' });
check((await legal.textContent('#refunds')).includes('help@vanity.example') && !(await legal.content()).includes('{{'), 'legal page not filled in');
console.log('legal page: ok');

await browser.close(); server.kill(); rpc.close(); rmSync(PAID_JOBS_FILE, { force: true });
console.log('ALL BROWSER CHECKS PASSED');
