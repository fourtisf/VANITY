/* Vanity GPU engine. Runs in the browser (navigator.gpu) and in Node (the 'webgpu' package).
   Needs WebGPU and WebCrypto Ed25519. Every GPU hit is re-derived on the CPU before it is returned. */
(function (root) {
  const ALPH = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const OUT_WORDS = 4 + 8 + 64 + 256;
  const PKCS8_ED = new Uint8Array([0x30,0x2e,0x02,0x01,0x00,0x30,0x05,0x06,0x03,0x2b,0x65,0x70,0x04,0x22,0x04,0x20]);

  function b58(b){let z=0;while(z<b.length&&b[z]===0)z++;const d=[0];for(let i=z;i<b.length;i++){let c=b[i];for(let j=0;j<d.length;j++){c+=d[j]<<8;d[j]=c%58;c=(c/58)|0;}while(c){d.push(c%58);c=(c/58)|0;}}let s='';for(let k=0;k<z;k++)s+='1';for(let k=d.length-1;k>=0;k--)s+=ALPH[d[k]];return s;}

  function buildTables(){
    const Pm = (1n << 255n) - 19n;
    const md = a => { a %= Pm; return a < 0n ? a + Pm : a; };
    const powm = (b, e) => { let r = 1n; b = md(b); while (e > 0n){ if (e & 1n) r = r * b % Pm; b = b * b % Pm; e >>= 1n; } return r; };
    const inv = a => powm(a, Pm - 2n);
    const D = md(-121665n * inv(121666n)), D2 = md(2n * D);
    const BX = 15112221349535400772501151409588531511454012693041857206046113283949847762202n;
    const BY = 46316835694926478169428394003475163141307993866256225615783033603165251855960n;
    const eadd = (P, Q) => {
      const A = md((P[1] - P[0]) * (Q[1] - Q[0])), B = md((P[1] + P[0]) * (Q[1] + Q[0]));
      const C = md(P[3] * D2 % Pm * Q[3]), Dd = md(2n * P[2] * Q[2]);
      const E = B - A, Fv = Dd - C, G = Dd + C, H = B + A;
      return [md(E * Fv), md(G * H), md(Fv * G), md(E * H)];
    };
    const put = (arr, off, v) => { for (let i = 0; i < 8; i++) arr[off + i] = Number((v >> BigInt(32 * i)) & 0xffffffffn); };
    const TB = new Uint32Array(32 * 256 * 24);
    let Pj = [BX, BY, 1n, md(BX * BY)];
    for (let j = 0; j < 32; j++){
      const row = new Array(256); row[0] = [0n, 1n, 1n, 0n];
      for (let k = 1; k < 256; k++) row[k] = eadd(row[k - 1], Pj);
      const next = eadd(row[255], Pj);
      const pref = new Array(256); let acc = 1n;
      for (let k = 0; k < 256; k++){ pref[k] = acc; acc = acc * row[k][2] % Pm; }
      let ia = inv(acc);
      for (let k = 255; k >= 0; k--){
        const zi = ia * pref[k] % Pm; ia = ia * row[k][2] % Pm;
        const x = row[k][0] * zi % Pm, y = row[k][1] * zi % Pm, off = (j * 256 + k) * 24;
        put(TB, off, md(y + x)); put(TB, off + 8, md(y - x)); put(TB, off + 16, md(D2 * x % Pm * y));
      }
      Pj = next;
    }
    const MT = new Uint32Array(2 * 10 * 58 * 8), MAX = (1n << 256n) - 1n;
    for (let li = 0; li < 2; li++){
      const L = li ? 43 : 44;
      for (let t = 0; t < 10; t++){
        const unit = 58n ** BigInt(L - 1 - t);
        for (let d = 0; d < 58; d++){ let v = BigInt(d) * unit; if (v > MAX) v = MAX; put(MT, ((li * 10 + t) * 58 + d) * 8, v); }
      }
    }
    return { TB, MT };
  }

  function seedFrom(base, id){
    const s = new Uint8Array(32);
    for (let i = 0; i < 8; i++){
      const w = (i === 7 ? (base[i] ^ id) : base[i]) >>> 0;
      s[4*i] = w >>> 24; s[4*i+1] = (w >>> 16) & 255; s[4*i+2] = (w >>> 8) & 255; s[4*i+3] = w & 255;
    }
    return s;
  }
  function packedToBytes(words){
    const out = new Uint8Array(32);
    for (let m = 0; m < 16; m++){
      const limb = (m & 1) ? (words[m >> 1] >>> 16) : (words[m >> 1] & 0xffff);
      out[31 - 2*m] = limb & 255; out[30 - 2*m] = limb >>> 8;
    }
    return out;
  }
  function b64u(s){ s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; const bin = atob(s); return Uint8Array.from(bin, c => c.charCodeAt(0)); }
  async function pubFromSeed(seed){
    const k = new Uint8Array(48); k.set(PKCS8_ED); k.set(seed, 16);
    const key = await crypto.subtle.importKey('pkcs8', k, { name: 'Ed25519' }, true, ['sign']);
    const jwk = await crypto.subtle.exportKey('jwk', key);
    return b64u(jwk.x);
  }
  function maskOf(set){ let lo = 0, hi = 0; for (const c of set){ const d = ALPH.indexOf(c); if (d < 32) lo |= (1 << d); else hi |= (1 << (d - 32)); } return [lo >>> 0, hi >>> 0]; }

  async function create(wgsl, opts = {}){
    const gpu = opts.gpu || (typeof navigator !== 'undefined' && navigator.gpu);
    if (!gpu) throw new Error('no-webgpu');
    const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw new Error('no-adapter');
    const device = await adapter.requestDevice();
    const { TB, MT } = buildTables();
    const mod = device.createShaderModule({ code: wgsl });
    const info = await mod.getCompilationInfo();
    const errs = info.messages.filter(m => m.type === 'error');
    if (errs.length) throw new Error('wgsl: ' + errs.map(e => `${e.lineNum}:${e.linePos} ${e.message}`).join(' | '));
    const pipe = await device.createComputePipelineAsync({ layout: 'auto', compute: { module: mod, entryPoint: 'main' } });
    const U = GPUBufferUsage;
    const mk = (size, usage) => device.createBuffer({ size, usage });
    const pBuf = mk(256, U.STORAGE | U.COPY_DST), tBuf = mk(TB.byteLength, U.STORAGE | U.COPY_DST), mBuf = mk(MT.byteLength, U.STORAGE | U.COPY_DST);
    const oBuf = mk(OUT_WORDS * 4, U.STORAGE | U.COPY_SRC | U.COPY_DST), rBuf = mk(OUT_WORDS * 4, U.MAP_READ | U.COPY_DST);
    device.queue.writeBuffer(tBuf, 0, TB); device.queue.writeBuffer(mBuf, 0, MT);
    const bg = device.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries: [pBuf, tBuf, mBuf, oBuf].map((b, i) => ({ binding: i, resource: { buffer: b } })) });
    const vendor = (adapter.info && (adapter.info.vendor || adapter.info.architecture)) || '';
    let lost = false; device.lost.then(() => { lost = true; if (opts.onLost) opts.onLost(); });

    async function dispatch(n, mode, cfg){
      const base = crypto.getRandomValues(new Uint32Array(8));
      const p = new Uint32Array(64); p.set(base, 0);
      if (cfg){
        p[8] = cfg.pre.length; p[9] = cfg.suf.length;
        cfg.pre.forEach((m, i) => { p[12 + 2*i] = m[0]; p[13 + 2*i] = m[1]; });
        cfg.suf.forEach((m, i) => { p[32 + 2*i] = m[0]; p[33 + 2*i] = m[1]; });
      }
      p[10] = mode; p[11] = n;
      device.queue.writeBuffer(pBuf, 0, p);
      device.queue.writeBuffer(oBuf, 0, new Uint32Array(4));
      const wg = Math.ceil(n / 64), x = Math.min(wg, 65535), y = Math.ceil(wg / x);
      const enc = device.createCommandEncoder();
      const pass = enc.beginComputePass(); pass.setPipeline(pipe); pass.setBindGroup(0, bg); pass.dispatchWorkgroups(x, y); pass.end();
      enc.copyBufferToBuffer(oBuf, 0, rBuf, 0, OUT_WORDS * 4);
      device.queue.submit([enc.finish()]);
      await rBuf.mapAsync(GPUMapMode.READ);
      const out = new Uint32Array(rBuf.getMappedRange().slice(0)); rBuf.unmap();
      return { base, out };
    }
    async function selfTest(){
      const r = await dispatch(16, 1, null);
      for (let i = 0; i < 16; i++){
        const want = b58(await pubFromSeed(seedFrom(r.base, i)));
        const got = b58(packedToBytes(r.out.subarray(76 + i*8, 84 + i*8)));
        if (want !== got) return { ok: false, i, want, got, scalar: Array.from(r.out.subarray(204, 236)), seed: Array.from(seedFrom(r.base, 0)) };
      }
      return { ok: true };
    }
    // Candidates the GPU flags are re-derived on the CPU before anyone sees them.
    async function verify(r, matchFn){
      const hits = [];
      const cnt = Math.min(r.out[0], 64);
      for (let k = 0; k < cnt; k++){
        const seed = seedFrom(r.base, r.out[12 + k]);
        const pub = await pubFromSeed(seed);
        const address = b58(pub);
        if (matchFn(address)){ const secret = new Uint8Array(64); secret.set(seed); secret.set(pub, 32); hits.push({ address, secret }); }
      }
      return hits;
    }
    const sample = r => b58(packedToBytes(r.out.subarray(4, 12)));
    return { dispatch, selfTest, verify, sample, vendor, tunedN: 4096, get lost(){ return lost; } };
  }

  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const MAX_N = 64 * 65535 * 4;
  const fit = (n, dt, targetMs) => Math.max(1024, Math.min(MAX_N, Math.round(n * Math.min(2, targetMs / Math.max(dt, 1)) / 64) * 64));

  // Measures keys per second with a pattern that can never match, and tunes the batch size.
  async function bench(g, ms = 1200, targetMs = 90){
    const never = { pre: [[0, 0]], suf: [] };
    let n = g.tunedN, rate = 0; const t0 = now();
    do {
      const a = now(); await g.dispatch(n, 0, never); const dt = now() - a;
      rate = n / (dt / 1000); n = fit(n, dt, targetMs);
    } while (now() - t0 < ms);
    g.tunedN = n; g.rate = rate;
    return rate;
  }

  // Runs batches until isActive() turns false. onBatch gets { n, dt, sample, hits } after every batch.
  async function grind(g, { pre, suf, match, isActive, onBatch, targetMs = 90 }){
    const cfg = { pre: pre.map(maskOf), suf: suf.map(maskOf) };
    while (isActive()){
      const n = g.tunedN, a = now();
      const r = await g.dispatch(n, 0, cfg);
      const dt = now() - a;
      g.tunedN = fit(n, dt, targetMs);
      const hits = r.out[0] ? await g.verify(r, match) : [];
      onBatch({ n, dt, sample: g.sample(r), hits });
    }
  }

  root.VanityGPU = { create, bench, grind, maskOf, b58, buildTables, seedFrom, packedToBytes, pubFromSeed };
})(typeof globalThis !== 'undefined' ? globalThis : this);
