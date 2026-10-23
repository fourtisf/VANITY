// Browser end-to-end check of Fast mode payments: the real page in Chromium, fake Wallet Standard wallets, and a
// fake Solana RPC that only learns about a payment when the page's own transaction is "sent". The transaction is
// decoded and signed with @solana/web3.js, so a malformed one fails here the way a real wallet would refuse it.
// Needs: npm i --no-save --omit=optional playwright@1.56.1 @solana/web3.js@1.98.4 && npx playwright install chromium
// Usage: node scripts/browser-test.mjs [screenshotDir]
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomBytes, createPrivateKey, sign } from 'node:crypto';
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
const fail = msg => { console.error('FAIL:', msg); server?.kill(); browser?.close(); rmSync(PAID_JOBS_FILE, { force: true }); rmSync(PAID_JOBS_FILE + '.history', { force: true }); process.exit(1); };
const check = (ok, what) => { if (!ok) fail(what); };

/* ---- fake RPC ---- */
const PAY_TO = key(), BLOCKHASH = key();
const byAddr = new Map(), byId = new Map(), lamportsOf = new Map();
const rpc = http.createServer((req, res) => {
  let body = ''; req.on('data', c => body += c); req.on('end', () => {
    const { id, method, params } = JSON.parse(body);
    const result = method === 'getLatestBlockhash' ? { context: { slot: 1 }, value: { blockhash: BLOCKHASH, lastValidBlockHeight: 100 } }
      : method === 'getSignaturesForAddress' ? (byAddr.get(params[0]) || [])
      : method === 'getTransaction' ? (byId.get(params[0]) || null)
      : method === 'sendTransaction' ? landTx(web3.Transaction.from(Buffer.from(params[0], 'base64')))
      : method === 'getMultipleAccounts' ? { context: { slot: 1 }, value: params[0].map(a => lamportsOf.has(a) ? { lamports: lamportsOf.get(a), owner: '11111111111111111111111111111111', data: ['', 'base64'], executable: false } : null) } : null;
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
  });
});
await new Promise(r => rpc.listen(0, '127.0.0.1', r));

const port = 20000 + Math.floor(Math.random() * 20000), base = `http://127.0.0.1:${port}`;
server = spawn(process.execPath, [path.join(root, 'server.js')], {
  env: { ...process.env, ENV_FILE: path.join(tmpdir(), 'no-such.env'), ENGINE: 'cpu', CPU_THREADS: '2', HOST: '127.0.0.1', PORT: String(port), PAY_TO, PAID_JOBS_FILE, HISTORY_FILE: PAID_JOBS_FILE + '.history',
    SITE_NAME: 'Test Vanity', SITE_URL: 'https://vanity.example', CONTACT_EMAIL: 'help@vanity.example', SOLANA_RPC: `http://127.0.0.1:${rpc.address().port}` },
  stdio: ['ignore', 'pipe', 'inherit'],
});
await new Promise(r => server.stdout.on('data', d => { if (String(d).includes('listening')) r(); }));

/* ---- the "wallet": refuses the first payment, then signs and lands the transaction once released ---- */
const payer = web3.Keypair.generate();
const payerKey = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(payer.secretKey.slice(0, 32))]), format: 'der', type: 'pkcs8' });
const signMsg = async bytes => Array.from(sign(null, Buffer.from(bytes), payerKey));
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
  landTx(tx);
  return Array.from(tx.signature);
}
// The fake chain: a signed transfer becomes a confirmed transaction the server can look up.
function landTx(tx) {
  if (!tx.verifySignatures()) throw new Error('signature does not verify');
  const t = web3.SystemInstruction.decodeTransfer(tx.instructions.find(ix => ix.programId.equals(web3.SystemProgram.programId)));
  const keys = tx.compileMessage().accountKeys.map(k => k.toBase58()), sig = VP.b58(tx.signature);
  const pre = keys.map(() => 1e9), post = [...pre], i = keys.indexOf(t.toPubkey.toBase58());
  post[0] -= 5000 + Number(t.lamports); if (i >= 0) post[i] += Number(t.lamports);
  byId.set(sig, { slot: 1, meta: { err: null, fee: 5000, preBalances: pre, postBalances: post, loadedAddresses: { writable: [], readonly: [] } }, transaction: { signatures: [sig], message: { accountKeys: keys } } });
  for (const k of keys) byAddr.set(k, [{ signature: sig, err: null }, ...(byAddr.get(k) || [])]);
  return sig;
}
// A wallet that cannot send by itself (its error reads "[object Object]") but can sign: the page has our server send it.
let signedOnly = 0;
async function signTx(txBytes) { const tx = web3.Transaction.from(Buffer.from(txBytes)); tx.partialSign(payer); signedOnly++; return Array.from(tx.serialize()); }
const signOnlyWallet = (address, pub) => {
  const account = { address, publicKey: new Uint8Array(pub), chains: ['solana:mainnet'], features: ['solana:signAndSendTransaction', 'solana:signTransaction'] };
  const wallet = { version: '1.0.0', name: 'Bitget Wallet', icon: 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" rx="3" fill="#00F0FF"/></svg>'),
    chains: ['solana:mainnet'], accounts: [], features: {
      'standard:connect': { version: '1.0.0', connect: async () => ({ accounts: [account] }) },
      'solana:signAndSendTransaction': { version: '1.0.0', supportedTransactionVersions: ['legacy', 0], signAndSendTransaction: async () => { throw new Error({ code: -32603, message: 'Internal JSON-RPC error.' }); } },
      'solana:signTransaction': { version: '1.0.0', supportedTransactionVersions: ['legacy', 0], signTransaction: async ({ transaction }) => [{ signedTransaction: new Uint8Array(await window.__signTx(Array.from(transaction))) }] },
    } };
  const cb = ({ register }) => register(wallet);
  try { window.dispatchEvent(new CustomEvent('wallet-standard:register-wallet', { detail: cb })); } catch {}
  try { window.addEventListener('wallet-standard:app-ready', ({ detail }) => cb(detail)); } catch {}
};
// Same two-way handshake as @wallet-standard/wallet registerWallet().
const fakeWallet = (name, address, pub) => {
  const account = { address, publicKey: new Uint8Array(pub), chains: ['solana:mainnet'], features: ['solana:signAndSendTransaction'] };
  const icon = 'data:image/svg+xml,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" rx="3" fill="${name === 'Phantom' ? '#AB9FF2' : '#F5A623'}"/></svg>`);
  const wallet = {
    version: '1.0.0', name, icon, chains: ['solana:mainnet', 'solana:devnet'], accounts: [],
    features: {
      'standard:connect': { version: '1.0.0', connect: async ({ silent } = {}) => { window.__connects = (window.__connects || 0) + 1; return { accounts: silent ? [] : [account] }; } },
      'solana:signAndSendTransaction': { version: '1.0.0', supportedTransactionVersions: ['legacy', 0],
        signAndSendTransaction: async ({ transaction, chain }) => [{ signature: new Uint8Array(await window.__sendTx(Array.from(transaction), chain)) }] },
      'solana:signMessage': { version: '1.0.0', signMessage: async ({ message }) => [{ signedMessage: message, signature: new Uint8Array(await window.__signMsg(Array.from(message))) }] },
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
await page.exposeFunction('__signMsg', signMsg);
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
check(await page.getAttribute('.xbtn', 'href') === 'https://x.com/platesfun' && /CA\s*Coming soon/.test(await page.textContent('.tokenbar')) && /Follow @platesfun/.test(await page.textContent('.tokenbar')), 'X link or CA missing: ' + await page.textContent('.tokenbar'));
console.log('site details, contact, preview tags, fonts, X link and CA: ok');

/* ---- header: the visitor connects their own wallet; nothing from the site owner is needed ---- */
await page.waitForSelector('#hdrWallet:not([hidden])', { timeout: 30000 });
check(/Connect wallet/.test(await page.textContent('#hdrWallet')), 'header Connect wallet button');
await page.click('#hdrWallet');
await page.waitForSelector('#walletDlg[open]');
await page.click('#walletList .wrow:has-text("Late Wallet")');
await page.waitForFunction(() => document.querySelector('#hdrWallet').classList.contains('on'), null, { timeout: 10000 }).catch(() => fail('header did not show the connected wallet'));
check((await page.textContent('#hdrWallet')).includes('…'), 'header shows the short address');
await page.screenshot({ path: path.join(shots, 'header-connected.png'), clip: { x: 0, y: 0, width: 1280, height: 90 } });
// Opening the site again never connects a wallet by itself: the last one is only listed first.
await page.reload({ waitUntil: 'load' });
await page.evaluate(walletArgs('Late Wallet'));
await page.waitForSelector('#hdrWallet:not([hidden])', { timeout: 30000 });
await page.waitForTimeout(1500);
check(!(await page.evaluate(() => window.__connects)) && /Connect wallet/.test(await page.textContent('#hdrWallet')), 'a wallet connected without being clicked');
await page.click('#hdrWallet');
await page.waitForSelector('#walletDlg[open]');
check(await page.$eval('#walletList .wrow', e => `${e.querySelector('span').textContent}:${e.querySelector('em').textContent}`) === 'Late Wallet:Last used', 'last wallet not listed first');
await page.click('#walletList .wrow:has-text("Late Wallet")');
await page.waitForFunction(() => document.querySelector('#hdrWallet').classList.contains('on'), null, { timeout: 10000 }).catch(() => fail('reconnecting by click failed'));
await page.click('#hdrWallet');
await page.click('#hdrMenu [data-m="disconnect"]');
await page.waitForFunction(() => !document.querySelector('#hdrWallet').classList.contains('on'));
console.log('header Connect wallet, connected address, no connection without a click, disconnect: ok');

/* ---- start a paid search: with payments on, every search is paid and runs on the server ---- */
await page.waitForFunction(() => /our server/.test(document.querySelector('#pill').textContent), null, { timeout: 30000 }).catch(() => fail('paid site did not switch to the server'));
check(await page.isHidden('#fast'), 'paid site still offers the free search on the device');
check(/We find it for you/.test(await page.textContent('.hero p')) && /sealed to you/.test(await page.textContent('#safe h2')), 'paid site still promises keys made on the device');
check(await page.evaluate(() => document.querySelector('#pill').textContent) && !(await page.content()).includes('{{'), 'paid page placeholders');
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
lamportsOf.set(payer.publicKey.toBase58(), 0);
await page.click('#walletList .wrow:has-text("Phantom")');
await page.waitForFunction(() => /has 0 SOL, and this search costs 0\.01 SOL/.test(document.querySelector('#payMsg').textContent), null, { timeout: 10000 }).catch(async () => fail('an empty wallet was not reported: ' + await page.textContent('#payMsg')));
check(calls === 0, 'the wallet was asked to pay from an empty account');
lamportsOf.set(payer.publicKey.toBase58(), 2e9);
await page.click('#payBtn');
await page.waitForFunction(() => /You cancelled the payment in your wallet\. Press Pay to try again\./.test(document.querySelector('#payMsg').textContent), null, { timeout: 10000 }).catch(async () => fail('a refused payment was not reported: ' + await page.textContent('#payMsg')));
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

/* ---- the result: address and key, backed up to the paying wallet; My addresses opens in its own tab ---- */
check(await page.locator('.res [data-act="fund"]').count() === 0, 'result still offers Add SOL');
check(await page.getAttribute('.res .sub a[href="addresses"]', 'target') === '_blank' && await page.getAttribute('nav.nav a[href="addresses"]', 'target') === '_blank', 'My addresses would leave the result page');
await page.waitForFunction(() => /^Backed up to /.test(document.querySelector('.res [data-vault]').textContent), null, { timeout: 10000 })
  .catch(async () => fail('key not backed up: ' + await page.textContent('.res')));
await page.click('.res [data-act="reveal"]');
const secret58 = (await page.textContent('.res [data-secret]')).trim();
check(secret58.length > 80, 'key not shown');
await page.click('.res [data-act="copyKey"]');
await page.locator('.res').screenshot({ path: path.join(shots, 'result.png') });
console.log('result: key backed up to the paying wallet, no Add SOL, My addresses opens in a new tab: ok');

/* ---- My addresses: empty until the paying wallet signs in; then its addresses, and each key from its backup ---- */
lamportsOf.set(address.trim(), 5e7);
const mine = page;   // the key was copied, so leaving the result page asks nothing
await mine.goto(base + '/addresses', { waitUntil: 'load' });
await mine.waitForSelector('#gate:not([hidden])', { timeout: 10000 }).catch(() => fail('My addresses does not ask to connect a wallet'));
check(await mine.locator('.item').count() === 0 && await mine.isHidden('#bar') && await mine.isHidden('#add'), 'My addresses shows addresses before a wallet signs in');
await mine.screenshot({ path: path.join(shots, 'my-addresses-locked.png'), fullPage: true });
const signIn = async () => {
  await mine.click('#walletBtn');
  await mine.waitForSelector('#who:not([hidden])', { timeout: 10000 }).catch(async () => fail('wallet sign-in: ' + await mine.textContent('#walletMsg')));
};
await signIn();
const item = mine.locator(`.item[data-addr="${address.trim()}"]`);
await item.waitFor({ timeout: 5000 }).catch(() => fail('paid address not listed for its wallet'));
check(/Wallet/.test(await item.textContent()) && /Key backed up/.test(await item.textContent()), 'My addresses tags: ' + await item.textContent());
await item.locator('[data-act="key"]').click();
await item.locator('[data-key]').waitFor({ timeout: 10000 }).catch(async () => fail('key not shown: ' + await item.textContent()));
check((await item.locator('[data-key]').textContent()).trim() === secret58, 'the key from the backup is not the key of the result');
await mine.click('#balBtn');
await mine.waitForFunction(() => /0\.05 SOL in total/.test(document.querySelector('#total').textContent), null, { timeout: 10000 }).catch(async () => fail('balances: ' + await mine.textContent('#bar')));
check(/0\.05 SOL/.test(await item.locator('.bal').textContent()), 'address balance not shown');
await mine.screenshot({ path: path.join(shots, 'my-addresses.png'), fullPage: true });
mine.once('dialog', d => d.accept());
await item.locator('[data-act="del"]').click();
await mine.waitForSelector('#empty:not([hidden])', { timeout: 5000 }).catch(() => fail('Remove did not empty the list'));
// Addresses made before: a downloaded keypair file (its key is checked against its address and backed up to the wallet),
// a broken one, a downloaded list, and a pasted address.
const kp = web3.Keypair.generate(), kp2 = web3.Keypair.generate(), broken = Array.from(web3.Keypair.generate().secretKey), listed = key(), pasted = kp2.publicKey.toBase58();
broken[63] ^= 1;
await mine.setInputFiles('#files', [
  { name: kp.publicKey.toBase58() + '.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(Array.from(kp.secretKey))) },
  { name: 'broken.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(broken)) },
  { name: 'my-addresses.csv', mimeType: 'text/csv', buffer: Buffer.from(`address,type,starts_with,ends_with,made,key_saved\n${listed},wallet,${listed.slice(0, 2)},,2026-10-20T10:00:00.000Z,yes\n`) },
]);
await mine.waitForFunction(() => /Added 2 addresses\. 1 key backed up/.test(document.querySelector('#addMsg').textContent), null, { timeout: 10000 })
  .catch(async () => fail('import: ' + await mine.textContent('#addMsg')));
check(/Skipped: broken\.json \(its key and address do not match\)/.test(await mine.textContent('#addMsg')), 'broken keypair file not refused: ' + await mine.textContent('#addMsg'));
const fromFile = await mine.textContent(`.item[data-addr="${kp.publicKey.toBase58()}"]`);
check(/From a keypair file/.test(fromFile) && /Key backed up/.test(fromFile), 'keypair file entry: ' + fromFile);
check(/Wallet/.test(await mine.textContent(`.item[data-addr="${listed}"]`)) && /No key backup/.test(await mine.textContent(`.item[data-addr="${listed}"]`)), 'list entry missing');
await mine.fill('#paste', pasted); await mine.click('#pasteBtn');
await mine.waitForSelector(`.item[data-addr="${pasted}"]`, { timeout: 5000 }).catch(() => fail('pasted address not added'));
check(await mine.locator('.item').count() === 3, 'three addresses after adding');
// An address without a backup takes the key saved when it was made: another address's key is refused, its own is backed up.
const pItem = mine.locator(`.item[data-addr="${pasted}"]`);
check(/No key backup/.test(await pItem.textContent()) && !(await pItem.locator('[data-act="key"]').count()), 'pasted address: ' + await pItem.textContent());
await pItem.locator('[data-act="addKey"]').click();
await pItem.locator('[data-keyin]').fill(VP.b58(kp.secretKey));
await pItem.locator('[data-act="saveKey"]').click();
await mine.waitForFunction(a => /belongs to another address/.test(document.querySelector(`.item[data-addr="${a}"]`).textContent), pasted, { timeout: 5000 })
  .catch(async () => fail('a key of another address was taken: ' + await pItem.textContent()));
await pItem.locator('[data-keyin]').fill(VP.b58(kp2.secretKey));
await pItem.locator('[data-act="saveKey"]').click();
await pItem.locator('[data-key]').waitFor({ timeout: 10000 }).catch(async () => fail('added key not shown: ' + await pItem.textContent()));
check((await pItem.locator('[data-key]').textContent()).trim() === VP.b58(kp2.secretKey) && /Key backed up/.test(await pItem.textContent()), 'added key: ' + await pItem.textContent());
// Another visit is empty again until the wallet signs in; then the list comes from the server, and the imported key opens.
await mine.reload({ waitUntil: 'load' });
await mine.waitForSelector('#gate:not([hidden])', { timeout: 10000 });
check(await mine.locator('.item').count() === 0, 'list shown after a reload without signing in');
await signIn();
await mine.waitForFunction(() => document.querySelectorAll('.item').length === 3, null, { timeout: 5000 }).catch(async () => fail('wallet list after sign-in: ' + await mine.locator('.item').count()));
check(!(await mine.locator(`.item[data-addr="${address.trim()}"]`).count()), 'a removed address came back');
const kpItem = mine.locator(`.item[data-addr="${kp.publicKey.toBase58()}"]`);
await kpItem.locator('[data-act="key"]').click();
await kpItem.locator('[data-key]').waitFor({ timeout: 10000 }).catch(async () => fail('imported key not shown: ' + await kpItem.textContent()));
check((await kpItem.locator('[data-key]').textContent()).trim() === VP.b58(kp.secretKey), 'imported key does not match its file');
await mine.screenshot({ path: path.join(shots, 'my-addresses-added.png'), fullPage: true });
await mine.click('#outBtn');
await mine.waitForSelector('#gate:not([hidden])', { timeout: 5000 });
check(await mine.locator('.item').count() === 0, 'list still shown after disconnecting');
console.log('My addresses: empty until the wallet signs in, its key backup opens, balances, remove, add from files, a list and a paste, a saved key added to an address, signed out again: ok');

/* ---- a wallet that can only sign (Bitget's "[object Object]"): the server sends its signed payment ---- */
const bp = await browser.newPage();
bp.on('pageerror', e => fail('page error: ' + e.message));
await bp.exposeFunction('__signTx', signTx);
await bp.addInitScript(`(${signOnlyWallet})(${JSON.stringify(payer.publicKey.toBase58())}, ${JSON.stringify(Array.from(payer.publicKey.toBytes()))})`);
await bp.goto(base + '/', { waitUntil: 'load' });
await bp.fill('#pre', 'B');
await bp.waitForSelector('#go:not([disabled])', { timeout: 30000 });
await bp.click('#go');
await bp.waitForSelector('#paybox:not([hidden])', { timeout: 15000 }).catch(() => fail('pay box never appeared for the sign-only wallet'));
await bp.click('#payBtn');
await bp.waitForSelector('#walletDlg[open]');
await bp.click('#walletList .wrow:has-text("Bitget Wallet")');
await bp.waitForSelector('.res', { timeout: 60000 }).catch(async () => fail('sign-only wallet: no result; pay msg: ' + await bp.textContent('#payMsg')));
check(signedOnly === 1 && /^[Bb]/.test((await bp.textContent('.res .kv .v')).trim()), 'sign-only wallet payment');
await bp.close();
console.log('wallet that cannot send ("[object Object]"): signed payment sent by the server, key delivered: ok');

/* ---- phone without a wallet: reopen the page inside the wallet app ---- */
const phone = await browser.newContext({ ...devices['iPhone 13'] });
const mp = await phone.newPage();
mp.on('pageerror', e => fail('phone page error: ' + e.message));
await mp.goto(base + '/', { waitUntil: 'load' });
await mp.fill('#pre', 'Ab'); await mp.fill('#suf', 'x');
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

/* ---- free Fast mode (no PAY_TO): the header wallet is still there ---- */
const freePort = port + 1, CA = key();
const freeServer = spawn(process.execPath, [path.join(root, 'server.js')], {
  env: { ...process.env, ENV_FILE: path.join(tmpdir(), 'no-such.env'), ENGINE: 'cpu', CPU_THREADS: '2', HOST: '127.0.0.1', PORT: String(freePort), PAY_TO: '', TOKEN_CA: CA, X_URL: 'off',
    SOLANA_RPC: `http://127.0.0.1:${rpc.address().port}` },
  stdio: ['ignore', 'pipe', 'inherit'],
});
await new Promise(r => freeServer.stdout.on('data', d => { if (String(d).includes('listening')) r(); }));
const fp = await browser.newPage();
fp.on('pageerror', e => fail('free page error: ' + e.message));
await fp.goto(`http://127.0.0.1:${freePort}/`, { waitUntil: 'load' });
await fp.waitForSelector('#hdrWallet:not([hidden])', { timeout: 30000 });
check(!!(await fp.evaluate(() => fetch('api/blockhash').then(r => r.json()))).blockhash, 'no blockhash without PAY_TO');
check(await fp.textContent('.tokenbar code') === CA && !(await fp.locator('.xbtn, .xfollow').count()), 'TOKEN_CA or X_URL=off not applied');
// A word that would take more than a day on this device cannot be started.
await fp.waitForFunction(() => /keys\/sec/.test(document.querySelector('#sSub').textContent), null, { timeout: 30000 });
await fp.fill('#pre', 'pumppump');
await fp.waitForFunction(() => document.querySelector('#go').disabled && /Too long/.test(document.querySelector('#goText').textContent), null, { timeout: 5000 })
  .catch(async () => fail('an impossible word could be started: ' + await fp.textContent('#goText')));
check(/too long to search in a browser/.test(await fp.textContent('#slow')), 'no explanation for the blocked word');
// It offers shorter words that finish in minutes; picking one fills it in and can be started.
await fp.click('#slow .try button >> nth=0', { timeout: 5000 }).catch(async () => fail('no quicker word offered: ' + await fp.textContent('#slow')));
const quick = await fp.inputValue('#pre');
check(quick && quick.length < 8 && 'pumppump'.startsWith(quick), `quicker word: ${quick}`);
await fp.waitForSelector('#go:not([disabled])', { timeout: 5000 }).catch(() => fail('the quicker word cannot be started'));
await fp.fill('#pre', '');
// Ideas: words that look rare but are quick. Start and End ideas fill only their own side, so they combine;
// a second click clears that side.
await fp.click('#ideas button[data-pre="CHAD"]', { timeout: 5000 }).catch(() => fail('no quick ideas shown'));
check(await fp.inputValue('#pre') === 'CHAD', 'idea not filled in');
await fp.waitForSelector('#go:not([disabled])', { timeout: 5000 }).catch(() => fail('the idea cannot be started'));
// With a start chosen, End offers only short endings, which keep the combined search quick.
const ends = await fp.$$eval('#ideas .irow[data-side="suf"] button', bs => bs.map(b => b.dataset.suf));
check(ends.length && ends.every(w => w.length <= 2), 'End ideas after a start: ' + ends.join(', '));
await fp.click(`#ideas button[data-suf="${ends[0]}"]`);
check(await fp.inputValue('#pre') === 'CHAD' && await fp.inputValue('#suf') === ends[0], 'an End idea replaced the start');
check(await fp.$eval('#ideas button[data-pre="CHAD"]', b => b.classList.contains('on')), 'chosen idea not highlighted');
await fp.click('#ideas button[data-pre="CHAD"]');
check(await fp.inputValue('#pre') === '' && await fp.inputValue('#suf') === ends[0], 'second click did not clear the start');
await fp.fill('#suf', '');
check(!(await fp.locator('.tab').count()) && !/Token address/.test(await fp.textContent('body')), 'the Token address tab is still there');
await fp.waitForSelector('#fast:not([hidden])', { timeout: 30000 });
await fp.click('#fast'); await fp.fill('#pre', 'A');
await fp.waitForSelector('#go:not([disabled])', { timeout: 30000 });
await fp.click('#go');
await fp.waitForSelector('.res', { timeout: 60000 }).catch(() => fail('free Fast mode gave no result'));
check(await fp.isHidden('#paybox') && await fp.isVisible('.res'), 'free mode: no pay box');
check(/Your own graphics card finds it/.test(await fp.textContent('.hero p')), 'free site lost its on-device wording');
freeServer.kill();
console.log('free Fast mode: header wallet, no payment: ok');

/* ---- legal page ---- */
const legal = await browser.newPage();
await legal.goto(base + '/legal#refunds', { waitUntil: 'load' });
check((await legal.textContent('#refunds')).includes('help@vanity.example') && !(await legal.content()).includes('{{'), 'legal page not filled in');
check((await legal.textContent('#terms')).includes('The search runs on our server') && !(await legal.content()).includes('On-device searches'), 'paid legal page still describes free on-device searches');
console.log('legal page: ok');

await browser.close(); server.kill(); rpc.close(); rmSync(PAID_JOBS_FILE, { force: true }); rmSync(PAID_JOBS_FILE + '.history', { force: true });
console.log('ALL BROWSER CHECKS PASSED');
