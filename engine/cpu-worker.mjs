// Server CPU fallback: one worker thread grinding Ed25519 keys. Uses libsodium (the optional `sodium-native`
// package) when it is installed, about 5x faster than Node's built-in WebCrypto, which is the fallback.
import { parentPort } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { randomFillSync } from 'node:crypto';

const ALPH = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58(b){let z=0;while(z<b.length&&b[z]===0)z++;const d=[0];for(let i=z;i<b.length;i++){let c=b[i];for(let j=0;j<d.length;j++){c+=d[j]<<8;d[j]=c%58;c=(c/58)|0;}while(c){d.push(c%58);c=(c/58)|0;}}let s='';for(let k=0;k<z;k++)s+='1';for(let k=d.length-1;k>=0;k--)s+=ALPH[d[k]];return s;}
const tables = a => a.map(s => { const t = new Uint8Array(128); for (const c of s) t[c.charCodeAt(0)] = 1; return t; });

let cur = 0, running = false, pre = [], suf = [];
function match(a){
  for (let i = 0; i < pre.length; i++) if (!pre[i][a.charCodeAt(i)]) return false;
  const o = a.length - suf.length;
  for (let j = 0; j < suf.length; j++) if (!suf[j][a.charCodeAt(o + j)]) return false;
  return true;
}
const yieldNow = () => new Promise(r => setImmediate(r));

// libsodium, used only if it derives the same public key as WebCrypto for a test seed.
async function loadSodium(){
  try {
    const sodium = createRequire(import.meta.url)('sodium-native');
    const seed = new Uint8Array(32).map((_, i) => i * 7 + 1), pk = Buffer.alloc(32), sk = Buffer.alloc(64);
    sodium.crypto_sign_seed_keypair(pk, sk, Buffer.from(seed));
    const p8 = new Uint8Array([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20, ...seed]);
    const priv = await crypto.subtle.importKey('pkcs8', p8, { name: 'Ed25519' }, true, ['sign']);
    const x = Buffer.from((await crypto.subtle.exportKey('jwk', priv)).x, 'base64url');
    return x.equals(pk) ? sodium : null;
  } catch { return null; }
}
const sodium = await loadSodium();

async function loopSodium(id){
  const B = 512, seeds = Buffer.alloc(32 * B), pk = Buffer.alloc(32), sk = Buffer.alloc(64);
  let n = 0, last = performance.now();
  while (running && id === cur){
    await yieldNow();
    if (!running || id !== cur) break;
    randomFillSync(seeds);
    for (let i = 0; i < B; i++){
      sodium.crypto_sign_seed_keypair(pk, sk, seeds.subarray(32 * i, 32 * i + 32));
      const a = b58(pk);
      if (match(a)){
        parentPort.postMessage({ type: 'progress', runId: id, n: n + i + 1 }); n = -(i + 1);
        parentPort.postMessage({ type: 'found', runId: id, address: a, secret: new Uint8Array(sk) });
      }
    }
    seeds.fill(0); sk.fill(0);
    n += B;
    const now = performance.now();
    if (now - last >= 250){ parentPort.postMessage({ type: 'progress', runId: id, n }); n = 0; last = now; }
  }
  if (n) parentPort.postMessage({ type: 'progress', runId: id, n });
}

async function loopWebCrypto(id){
  const S = crypto.subtle, A = { name: 'Ed25519' }, U = ['sign', 'verify'], B = 64;
  let n = 0, last = performance.now();
  while (running && id === cur){
    await yieldNow();
    if (!running || id !== cur) break;
    const ks = []; for (let i = 0; i < B; i++) ks.push(S.generateKey(A, true, U));
    const kp = await Promise.all(ks);
    const pb = await Promise.all(kp.map(k => S.exportKey('raw', k.publicKey)));
    for (let i = 0; i < B; i++){
      const pub = new Uint8Array(pb[i]), a = b58(pub);
      if (match(a)){
        parentPort.postMessage({ type: 'progress', runId: id, n: n + i + 1 }); n = -(i + 1);
        const p8 = new Uint8Array(await S.exportKey('pkcs8', kp[i].privateKey));
        const sk = new Uint8Array(64); sk.set(p8.subarray(p8.length - 32), 0); sk.set(pub, 32);
        parentPort.postMessage({ type: 'found', runId: id, address: a, secret: sk });
      }
    }
    n += B;
    const now = performance.now();
    if (now - last >= 250){ parentPort.postMessage({ type: 'progress', runId: id, n }); n = 0; last = now; }
  }
  if (n) parentPort.postMessage({ type: 'progress', runId: id, n });
}

parentPort.on('message', m => {
  if (m.type === 'start'){ pre = tables(m.pre); suf = tables(m.suf); cur = m.runId; running = true; (sodium ? loopSodium : loopWebCrypto)(m.runId); }
  else if (m.type === 'stop'){ running = false; }
});
parentPort.postMessage({ type: 'ready', lib: sodium ? 'libsodium' : 'WebCrypto' });
