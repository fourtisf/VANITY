// Real-chain check of Fast mode payments: the page builds the transfer, a test wallet signs it, and it is sent
// to a real Solana node. The server must find it through that node's RPC, run the search and deliver the key,
// and the receiver's balance on chain must grow by the price. Two payments: one the page reports, one it
// cannot report (found by its reference). Nothing is faked between the page, the node and the server.
//
// Needs: npm i --no-save --omit=optional playwright@1.56.1 @solana/web3.js@1.98.4 && npx playwright install chromium
// Usage: node scripts/chain-test.mjs [rpcUrl] [screenshotDir]
//   rpcUrl defaults to http://127.0.0.1:8899, a local `solana-test-validator`.
//   For devnet pass https://api.devnet.solana.com; the payer is airdropped, or set PAYER_KEYPAIR to a funded
//   keypair file (solana-keygen format) when the faucet is dry.
import path from 'node:path';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import web3 from '@solana/web3.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const rpcUrl = process.argv[2] || 'http://127.0.0.1:8899';
const shots = process.argv[3] || path.join(tmpdir(), 'vanity-chain-shots');
mkdirSync(shots, { recursive: true });
await import('../engine/pattern.js');
const VP = globalThis.VanityPattern;
const PAID_JOBS_FILE = path.join(tmpdir(), `vanity-chain-${process.pid}.json`);
let server, browser;
const fail = msg => { console.error('FAIL:', msg); server?.kill(); browser?.close(); rmSync(PAID_JOBS_FILE, { force: true }); rmSync(PAID_JOBS_FILE + '.history', { force: true }); process.exit(1); };
const check = (ok, what) => { if (!ok) fail(what); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---- the chain: a payer with SOL and a fresh receiving wallet ---- */
const conn = new web3.Connection(rpcUrl, 'confirmed');
const version = await conn.getVersion().catch(e => fail(`cannot reach ${rpcUrl}: ${e.message}`));
console.log(`node: ${rpcUrl} (solana-core ${version['solana-core']})`);
const payer = process.env.PAYER_KEYPAIR
  ? web3.Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(process.env.PAYER_KEYPAIR, 'utf8'))))
  : web3.Keypair.generate();
if (!process.env.PAYER_KEYPAIR) {
  const sig = await conn.requestAirdrop(payer.publicKey, 2 * web3.LAMPORTS_PER_SOL).catch(e => fail('airdrop failed (set PAYER_KEYPAIR): ' + e.message));
  await conn.confirmTransaction({ signature: sig, ...(await conn.getLatestBlockhash()) }, 'confirmed');
}
const startBalance = await conn.getBalance(payer.publicKey);
check(startBalance >= 0.05 * web3.LAMPORTS_PER_SOL, `payer ${payer.publicKey.toBase58()} has too little SOL`);
const receiver = web3.Keypair.generate().publicKey;
console.log(`payer ${payer.publicKey.toBase58()} (${startBalance / 1e9} SOL), receiver ${receiver.toBase58()}`);

/* ---- the server, pointed at that node ---- */
const port = 20000 + Math.floor(Math.random() * 20000), base = `http://127.0.0.1:${port}`;
const logs = [];
server = spawn(process.execPath, [path.join(root, 'server.js')], {
  env: { ...process.env, ENV_FILE: path.join(tmpdir(), 'no-such.env'), ENGINE: 'cpu', CPU_THREADS: '2', HOST: '127.0.0.1', PORT: String(port),
    PAY_TO: receiver.toBase58(), PAID_JOBS_FILE, HISTORY_FILE: PAID_JOBS_FILE + '.history', SOLANA_RPC: rpcUrl, SOLANA_CLUSTER: /devnet/.test(rpcUrl) ? 'devnet' : 'mainnet',
    CONTACT_EMAIL: 'help@getplates.fun' },
  stdio: ['ignore', 'pipe', 'inherit'],
});
await new Promise(r => server.stdout.on('data', d => { logs.push(String(d)); if (process.env.VERBOSE) process.stdout.write(d); if (String(d).includes('listening')) r(); }));

/* ---- the wallet: signs exactly what the page built and sends it to the node ---- */
const sent = [];
async function sendTx(txBytes) {
  const tx = web3.Transaction.from(Buffer.from(txBytes));
  tx.sign(payer);
  const signature = await conn.sendRawTransaction(tx.serialize(), { preflightCommitment: 'confirmed' });
  sent.push(signature);
  return Array.from(tx.signature);
}
const fakeWallet = (address, pub) => {
  const account = { address, publicKey: new Uint8Array(pub), chains: ['solana:mainnet', 'solana:devnet'], features: ['solana:signAndSendTransaction'] };
  const wallet = {
    version: '1.0.0', name: 'Phantom', icon: 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22/%3E', chains: ['solana:mainnet', 'solana:devnet'], accounts: [],
    features: {
      'standard:connect': { version: '1.0.0', connect: async () => ({ accounts: [account] }) },
      'solana:signAndSendTransaction': { version: '1.0.0', supportedTransactionVersions: ['legacy', 0],
        signAndSendTransaction: async ({ transaction }) => [{ signature: new Uint8Array(await window.__sendTx(Array.from(transaction))) }] },
    },
  };
  const cb = ({ register }) => register(wallet);
  try { window.dispatchEvent(new CustomEvent('wallet-standard:register-wallet', { detail: cb })); } catch {}
  try { window.addEventListener('wallet-standard:app-ready', ({ detail }) => cb(detail)); } catch {}
};

browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
page.on('pageerror', e => fail('page error: ' + e.message));
await page.exposeFunction('__sendTx', sendTx);
await page.addInitScript(`(${fakeWallet})(${JSON.stringify(payer.publicKey.toBase58())}, ${JSON.stringify(Array.from(payer.publicKey.toBytes()))})`);
await page.goto(base + '/', { waitUntil: 'load' });

async function paidSearch(prefix, { blockReport = false } = {}) {
  if (await page.isVisible('.res')) await page.reload({ waitUntil: 'load' });
  // Payments on: every search is paid and runs on the server.
  await page.waitForFunction(() => /our server/.test(document.querySelector('#pill').textContent), null, { timeout: 30000 });
  await page.fill('#pre', prefix);
  await page.waitForSelector('#go:not([disabled])', { timeout: 30000 });
  // Without the page's report the server has to find the payment through getSignaturesForAddress(reference).
  if (blockReport) await page.route('**/api/jobs/*/paid', r => r.abort());
  await page.click('#go');
  await page.waitForSelector('#paybox:not([hidden])', { timeout: 20000 }).catch(() => fail('pay box never appeared'));
  await page.click('#payBtn');
  if (await page.isVisible('#walletDlg[open]')) await page.click('#walletList .wrow:has-text("Phantom")');
  const t0 = Date.now();
  await page.waitForSelector('.res', { timeout: 120000 }).catch(async () => fail(`no result for ${prefix}; pay msg: ${await page.textContent('#payMsg')}; err: ${await page.textContent('#runErr')}`));
  if (blockReport) await page.unroute('**/api/jobs/*/paid');
  const address = (await page.textContent('.res .kv .v')).trim();
  check(address.toLowerCase().startsWith(prefix.toLowerCase()), `delivered ${address} for ${prefix}`);
  return { address, seconds: (Date.now() - t0) / 1000 };
}

const a = await paidSearch('A');
console.log(`payment reported by the page: found on chain, key delivered in ${a.seconds.toFixed(1)}s (${a.address})`);
await page.screenshot({ path: path.join(shots, 'chain-result.png') });
await page.click('.res [data-act="copyKey"]');
const b = await paidSearch('B', { blockReport: true });
console.log(`payment never reported: found by its reference, key delivered in ${b.seconds.toFixed(1)}s (${b.address})`);

/* ---- what the chain says ---- */
const price = Math.round(0.01 * web3.LAMPORTS_PER_SOL);
const received = await conn.getBalance(receiver);
check(received === 2 * price, `receiver holds ${received} lamports, expected ${2 * price}`);
check(sent.length === 2, `${sent.length} transactions sent, expected 2`);
for (const sig of sent) {
  const tx = await conn.getTransaction(sig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
  check(tx && !tx.meta.err, `transaction ${sig} failed on chain`);
  check(logs.join('').includes(sig), `server log does not show ${sig} as a payment`);
}
console.log(`on chain: receiver got ${received / 1e9} SOL from 2 transactions; both are in the server log as payments`);

await browser.close(); server.kill(); rmSync(PAID_JOBS_FILE, { force: true }); rmSync(PAID_JOBS_FILE + '.history', { force: true });
console.log('ALL CHAIN CHECKS PASSED');
