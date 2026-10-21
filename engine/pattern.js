/* Vanity: pattern parsing and odds. Shared by the website and the server. */
(function (root) {
  const ALPH = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const DIGITS = '123456789';
  const LETTERS = ALPH.slice(9);
  const COMMON = '23456789ABCDEFGH';
  const MAX_TOTAL = 12;
  const MAX_PART = 10;

  function b58(b) {
    let z = 0; while (z < b.length && b[z] === 0) z++;
    const d = [0];
    for (let i = z; i < b.length; i++) {
      let c = b[i];
      for (let j = 0; j < d.length; j++) { c += d[j] << 8; d[j] = c % 58; c = (c / 58) | 0; }
      while (c) { d.push(c % 58); c = (c / 58) | 0; }
    }
    let s = ''; for (let k = 0; k < z; k++) s += '1';
    for (let k = d.length - 1; k >= 0; k--) s += ALPH[d[k]];
    return s;
  }

  // Each character becomes the set of base58 characters it may match.
  function compile(raw, anyCase) {
    const sets = [], bad = [];
    for (const ch of raw) {
      let s = '';
      if (ch === '#') s = DIGITS;
      else if (ch === '*') s = LETTERS;
      else {
        const c = anyCase ? [...new Set([ch.toLowerCase(), ch.toUpperCase()])] : [ch];
        s = c.filter(x => ALPH.includes(x)).join('');
        if (!s) bad.push(ch);
      }
      sets.push(s);
    }
    return { sets, bad, raw };
  }

  // Exact odds that a random 32-byte public key starts with str (handles the uneven first character).
  const N = 2n ** 256n, NF = Number(N);
  const P58 = Array.from({ length: 46 }, (_, i) => 58n ** BigInt(i));
  const cache = new Map();
  function probPrefixStr(str) {
    if (cache.has(str)) return cache.get(str);
    let ones = 0; while (ones < str.length && str[ones] === '1') ones++;
    let r;
    if (ones) r = Math.pow(1 / 256, ones) * (ones < str.length ? probPrefixStr(str.slice(ones)) : 1);
    else {
      let v = 0n; for (const c of str) v = v * 58n + BigInt(ALPH.indexOf(c));
      const k = str.length; let tot = 0n;
      for (let L = 44; L >= 40; L--) {
        if (L < k) continue;
        let lo = v * P58[L - k], hi = (v + 1n) * P58[L - k];
        const a = P58[L - 1], b = P58[L] < N ? P58[L] : N;
        if (lo < a) lo = a; if (hi > b) hi = b;
        if (hi > lo) tot += hi - lo;
      }
      r = Number(tot) / NF;
    }
    cache.set(str, r); return r;
  }
  function prefixProb(sets) {
    if (!sets.length) return 1;
    let count = 1; for (const s of sets) { count *= s.length; if (count > 4096) break; }
    if (count <= 4096) {
      let tot = 0;
      const walk = (i, acc) => { if (i === sets.length) { tot += probPrefixStr(acc); return; } for (const c of sets[i]) walk(i + 1, acc + c); };
      walk(0, ''); return tot;
    }
    let f = 0; for (const c of sets[0]) f += probPrefixStr(c);
    for (let i = 1; i < sets.length; i++) f *= sets[i].length / 58;
    return f;
  }
  const suffixProb = sets => sets.reduce((p, s) => p * s.length / 58, 1);

  // Validates a request and returns everything a caller needs: sets, odds, and problems found.
  function analyze(preRaw, sufRaw, anyCase) {
    preRaw = String(preRaw || '').replace(/\s+/g, '');
    sufRaw = String(sufRaw || '').replace(/\s+/g, '');
    const pre = compile(preRaw, anyCase), suf = compile(sufRaw, anyCase);
    const bad = [...new Set([...pre.bad, ...suf.bad])];
    let error = null;
    if (bad.length) error = bad.some(c => !/[A-Za-z0-9]/.test(c)) ? 'symbols' : 'chars';
    else if (preRaw.length > MAX_PART || sufRaw.length > MAX_PART) error = 'part-too-long';
    else if (preRaw.length + sufRaw.length > MAX_TOTAL) error = 'too-long';
    const empty = !preRaw && !sufRaw;
    const p = (!error && !empty) ? prefixProb(pre.sets) * suffixProb(suf.sets) : null;
    return { preRaw, sufRaw, pre, suf, bad, error, empty, p, anyCase: !!anyCase };
  }

  function matcher(preSets, sufSets) {
    return a => {
      for (let i = 0; i < preSets.length; i++) if (!preSets[i].includes(a[i])) return false;
      const o = a.length - sufSets.length;
      for (let j = 0; j < sufSets.length; j++) if (!sufSets[j].includes(a[o + j])) return false;
      return true;
    };
  }

  root.VanityPattern = { ALPH, COMMON, MAX_TOTAL, MAX_PART, b58, compile, probPrefixStr, prefixProb, suffixProb, analyze, matcher };
})(typeof globalThis !== 'undefined' ? globalThis : this);
