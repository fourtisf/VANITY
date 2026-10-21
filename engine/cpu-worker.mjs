// Server CPU fallback: one worker thread grinding Ed25519 keys with Node's built-in WebCrypto.
import { parentPort } from 'node:worker_threads';

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

async function loop(id){
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
  if (m.type === 'start'){ pre = tables(m.pre); suf = tables(m.suf); cur = m.runId; running = true; loop(m.runId); }
  else if (m.type === 'stop'){ running = false; }
});
