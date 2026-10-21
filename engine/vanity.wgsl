// Vanity: Solana (ed25519) vanity grinder, one candidate key per invocation.
// seed = base ^ id (last word) -> SHA-512 -> clamped scalar -> fixed-base mult -> compress -> base58 checks.
// The host re-derives every hit on the CPU, so a bad GPU result can never be shown to a user.

alias F = array<u32, 16>;          // field element, 16 limbs of 16 bits, little-endian
alias V2 = vec2<u32>;              // 64-bit word as (hi, lo)
struct Pt { X: F, Y: F, Z: F, T: F };

// P layout: [0..7] base seed words (big-endian bytes), [8] prefix len, [9] suffix len, [10] mode,
// [11] invocation count, [12..31] prefix masks (2 words per position), [32..51] suffix masks.
@group(0) @binding(0) var<storage, read> P: array<u32>;
@group(0) @binding(1) var<storage, read> TB: array<u32>;   // [32 windows][256][yplusx, yminusx, xy2d] x 8 words
@group(0) @binding(2) var<storage, read> MT: array<u32>;   // [len 44|43][position 0..9][digit 0..57] x 8 words
struct Out { count: atomic<u32>, p0: u32, p1: u32, p2: u32, sample: array<u32, 8>, found: array<u32, 64>, dbg: array<u32, 256> };
@group(0) @binding(3) var<storage, read_write> O: Out;

const KS = array<V2, 80>(
  V2(0x428a2f98u, 0xd728ae22u),
  V2(0x71374491u, 0x23ef65cdu),
  V2(0xb5c0fbcfu, 0xec4d3b2fu),
  V2(0xe9b5dba5u, 0x8189dbbcu),
  V2(0x3956c25bu, 0xf348b538u),
  V2(0x59f111f1u, 0xb605d019u),
  V2(0x923f82a4u, 0xaf194f9bu),
  V2(0xab1c5ed5u, 0xda6d8118u),
  V2(0xd807aa98u, 0xa3030242u),
  V2(0x12835b01u, 0x45706fbeu),
  V2(0x243185beu, 0x4ee4b28cu),
  V2(0x550c7dc3u, 0xd5ffb4e2u),
  V2(0x72be5d74u, 0xf27b896fu),
  V2(0x80deb1feu, 0x3b1696b1u),
  V2(0x9bdc06a7u, 0x25c71235u),
  V2(0xc19bf174u, 0xcf692694u),
  V2(0xe49b69c1u, 0x9ef14ad2u),
  V2(0xefbe4786u, 0x384f25e3u),
  V2(0x0fc19dc6u, 0x8b8cd5b5u),
  V2(0x240ca1ccu, 0x77ac9c65u),
  V2(0x2de92c6fu, 0x592b0275u),
  V2(0x4a7484aau, 0x6ea6e483u),
  V2(0x5cb0a9dcu, 0xbd41fbd4u),
  V2(0x76f988dau, 0x831153b5u),
  V2(0x983e5152u, 0xee66dfabu),
  V2(0xa831c66du, 0x2db43210u),
  V2(0xb00327c8u, 0x98fb213fu),
  V2(0xbf597fc7u, 0xbeef0ee4u),
  V2(0xc6e00bf3u, 0x3da88fc2u),
  V2(0xd5a79147u, 0x930aa725u),
  V2(0x06ca6351u, 0xe003826fu),
  V2(0x14292967u, 0x0a0e6e70u),
  V2(0x27b70a85u, 0x46d22ffcu),
  V2(0x2e1b2138u, 0x5c26c926u),
  V2(0x4d2c6dfcu, 0x5ac42aedu),
  V2(0x53380d13u, 0x9d95b3dfu),
  V2(0x650a7354u, 0x8baf63deu),
  V2(0x766a0abbu, 0x3c77b2a8u),
  V2(0x81c2c92eu, 0x47edaee6u),
  V2(0x92722c85u, 0x1482353bu),
  V2(0xa2bfe8a1u, 0x4cf10364u),
  V2(0xa81a664bu, 0xbc423001u),
  V2(0xc24b8b70u, 0xd0f89791u),
  V2(0xc76c51a3u, 0x0654be30u),
  V2(0xd192e819u, 0xd6ef5218u),
  V2(0xd6990624u, 0x5565a910u),
  V2(0xf40e3585u, 0x5771202au),
  V2(0x106aa070u, 0x32bbd1b8u),
  V2(0x19a4c116u, 0xb8d2d0c8u),
  V2(0x1e376c08u, 0x5141ab53u),
  V2(0x2748774cu, 0xdf8eeb99u),
  V2(0x34b0bcb5u, 0xe19b48a8u),
  V2(0x391c0cb3u, 0xc5c95a63u),
  V2(0x4ed8aa4au, 0xe3418acbu),
  V2(0x5b9cca4fu, 0x7763e373u),
  V2(0x682e6ff3u, 0xd6b2b8a3u),
  V2(0x748f82eeu, 0x5defb2fcu),
  V2(0x78a5636fu, 0x43172f60u),
  V2(0x84c87814u, 0xa1f0ab72u),
  V2(0x8cc70208u, 0x1a6439ecu),
  V2(0x90befffau, 0x23631e28u),
  V2(0xa4506cebu, 0xde82bde9u),
  V2(0xbef9a3f7u, 0xb2c67915u),
  V2(0xc67178f2u, 0xe372532bu),
  V2(0xca273eceu, 0xea26619cu),
  V2(0xd186b8c7u, 0x21c0c207u),
  V2(0xeada7dd6u, 0xcde0eb1eu),
  V2(0xf57d4f7fu, 0xee6ed178u),
  V2(0x06f067aau, 0x72176fbau),
  V2(0x0a637dc5u, 0xa2c898a6u),
  V2(0x113f9804u, 0xbef90daeu),
  V2(0x1b710b35u, 0x131c471bu),
  V2(0x28db77f5u, 0x23047d84u),
  V2(0x32caab7bu, 0x40c72493u),
  V2(0x3c9ebe0au, 0x15c9bebcu),
  V2(0x431d67c4u, 0x9c100d4cu),
  V2(0x4cc5d4beu, 0xcb3e42b6u),
  V2(0x597f299cu, 0xfc657e2au),
  V2(0x5fcb6fabu, 0x3ad6faecu),
  V2(0x6c44198cu, 0x4a475817u)
);

fn add64(a: V2, b: V2) -> V2 { let lo = a.y + b.y; return V2(a.x + b.x + select(0u, 1u, lo < a.y), lo); }
fn rotr(a: V2, n: u32) -> V2 { return V2((a.x >> n) | (a.y << (32u - n)), (a.y >> n) | (a.x << (32u - n))); }
fn rotrh(a: V2, n: u32) -> V2 { return rotr(V2(a.y, a.x), n - 32u); }
fn shr64(a: V2, n: u32) -> V2 { return V2(a.x >> n, (a.y >> n) | (a.x << (32u - n))); }

fn sha_scalar(sw: array<u32, 8>) -> array<u32, 32> {
  var w: array<V2, 16>;
  w[0] = V2(sw[0], sw[1]); w[1] = V2(sw[2], sw[3]); w[2] = V2(sw[4], sw[5]); w[3] = V2(sw[6], sw[7]);
  w[4] = V2(0x80000000u, 0u);
  w[15] = V2(0u, 256u);
  var a = V2(0x6a09e667u, 0xf3bcc908u); var b = V2(0xbb67ae85u, 0x84caa73bu);
  var c = V2(0x3c6ef372u, 0xfe94f82bu); var d = V2(0xa54ff53au, 0x5f1d36f1u);
  var e = V2(0x510e527fu, 0xade682d1u); var f = V2(0x9b05688cu, 0x2b3e6c1fu);
  var g = V2(0x1f83d9abu, 0xfb41bd6bu); var h = V2(0x5be0cd19u, 0x137e2179u);
  for (var t = 0u; t < 80u; t++) {
    var wt: V2;
    if (t < 16u) {
      wt = w[t];
    } else {
      let x15 = w[(t + 1u) & 15u];
      let x2 = w[(t + 14u) & 15u];
      let s0 = rotr(x15, 1u) ^ rotr(x15, 8u) ^ shr64(x15, 7u);
      let s1 = rotr(x2, 19u) ^ rotrh(x2, 61u) ^ shr64(x2, 6u);
      wt = add64(add64(w[t & 15u], s0), add64(w[(t + 9u) & 15u], s1));
      w[t & 15u] = wt;
    }
    let S1 = rotr(e, 14u) ^ rotr(e, 18u) ^ rotrh(e, 41u);
    let ch = (e & f) ^ (~e & g);
    let t1 = add64(add64(add64(h, S1), add64(ch, KS[t])), wt);
    let S0 = rotr(a, 28u) ^ rotrh(a, 34u) ^ rotrh(a, 39u);
    let mj = (a & b) ^ (a & c) ^ (b & c);
    let t2 = add64(S0, mj);
    h = g; g = f; f = e; e = add64(d, t1); d = c; c = b; b = a; a = add64(t1, t2);
  }
  var hs: array<V2, 4>;
  hs[0] = add64(a, V2(0x6a09e667u, 0xf3bcc908u)); hs[1] = add64(b, V2(0xbb67ae85u, 0x84caa73bu));
  hs[2] = add64(c, V2(0x3c6ef372u, 0xfe94f82bu)); hs[3] = add64(d, V2(0xa54ff53au, 0x5f1d36f1u));
  var s: array<u32, 32>;
  for (var i = 0u; i < 4u; i++) {
    let v = hs[i];
    for (var k = 0u; k < 4u; k++) {
      s[8u * i + k] = (v.x >> (24u - 8u * k)) & 0xffu;
      s[8u * i + 4u + k] = (v.y >> (24u - 8u * k)) & 0xffu;
    }
  }
  s[0] = s[0] & 248u;
  s[31] = (s[31] & 127u) | 64u;
  return s;
}

// ---------- field arithmetic mod p = 2^255 - 19 ----------
fn carry(r_in: F) -> F {
  var r = r_in;
  for (var it = 0u; it < 3u; it++) {
    var c = 0u;
    for (var i = 0u; i < 16u; i++) { let v = r[i] + c; r[i] = v & 0xffffu; c = v >> 16u; }
    r[0] = r[0] + 38u * c;
  }
  return r;
}
fn red(c_in: array<u32, 33>) -> F {
  var c = c_in;
  var cy = 0u;
  for (var k = 0u; k < 32u; k++) { let v = c[k] + cy; c[k] = v & 0xffffu; cy = v >> 16u; }
  c[32] = c[32] + cy;
  var r: F;
  for (var i = 0u; i < 16u; i++) { r[i] = c[i] + 38u * c[i + 16u]; }
  r[0] = r[0] + 1444u * c[32];
  return carry(r);
}
fn fmul(a: F, b: F) -> F {
  var c: array<u32, 33>;
  for (var i = 0u; i < 16u; i++) {
    let ai = a[i];
    for (var j = 0u; j < 16u; j++) {
      let p = ai * b[j];
      c[i + j] = c[i + j] + (p & 0xffffu);
      c[i + j + 1u] = c[i + j + 1u] + (p >> 16u);
    }
  }
  return red(c);
}
fn fsq(a: F) -> F {
  var c: array<u32, 33>;
  for (var i = 0u; i < 16u; i++) {
    let ai = a[i];
    let pp = ai * ai;
    c[2u * i] = c[2u * i] + (pp & 0xffffu);
    c[2u * i + 1u] = c[2u * i + 1u] + (pp >> 16u);
    for (var j = i + 1u; j < 16u; j++) {
      let q = ai * a[j];
      c[i + j] = c[i + j] + ((q & 0xffffu) << 1u);
      c[i + j + 1u] = c[i + j + 1u] + ((q >> 16u) << 1u);
    }
  }
  return red(c);
}
fn fadd(a: F, b: F) -> F { var r: F; for (var i = 0u; i < 16u; i++) { r[i] = a[i] + b[i]; } return carry(r); }
// a - b + 4p, with 4p written so every limb is >= 2^16
fn fsub(a: F, b: F) -> F {
  var r: F;
  r[0] = a[0] + 0x1ffb4u - b[0];
  for (var i = 1u; i < 16u; i++) { r[i] = a[i] + 0x1fffeu - b[i]; }
  return carry(r);
}
fn sqn(a: F, n: u32) -> F { var r = a; for (var i = 0u; i < n; i++) { r = fsq(r); } return r; }
fn finv(z: F) -> F {
  let z2 = fsq(z);
  let z8 = sqn(z2, 2u);
  let z9 = fmul(z, z8);
  let z11 = fmul(z2, z9);
  let z_5_0 = fmul(z9, fsq(z11));
  let z_10_0 = fmul(sqn(z_5_0, 5u), z_5_0);
  let z_20_0 = fmul(sqn(z_10_0, 10u), z_10_0);
  let z_40_0 = fmul(sqn(z_20_0, 20u), z_20_0);
  let z_50_0 = fmul(sqn(z_40_0, 10u), z_10_0);
  let z_100_0 = fmul(sqn(z_50_0, 50u), z_50_0);
  let z_200_0 = fmul(sqn(z_100_0, 100u), z_100_0);
  let z_250_0 = fmul(sqn(z_200_0, 50u), z_50_0);
  return fmul(sqn(z_250_0, 5u), z11);
}
fn prop(a_in: F) -> F {
  var a = a_in; var c = 0u;
  for (var i = 0u; i < 16u; i++) { let v = a[i] + c; a[i] = v & 0xffffu; c = v >> 16u; }
  return a;
}
fn freeze(a_in: F) -> F {
  var a = a_in;
  for (var k = 0u; k < 2u; k++) {
    let t = a[15] >> 15u; a[15] = a[15] & 0x7fffu; a[0] = a[0] + 19u * t; a = prop(a);
  }
  var b = a; b[0] = b[0] + 19u; b = prop(b);
  if ((b[15] >> 15u) == 1u) { b[15] = b[15] & 0x7fffu; return b; }
  return a;
}

// ---------- curve ----------
fn ldT(off: u32) -> F {
  var r: F;
  for (var i = 0u; i < 8u; i++) { let w = TB[off + i]; r[2u * i] = w & 0xffffu; r[2u * i + 1u] = w >> 16u; }
  return r;
}
fn madd(p: Pt, yp: F, ym: F, t2d: F) -> Pt {
  let A = fmul(fadd(p.Y, p.X), yp);
  let B = fmul(fsub(p.Y, p.X), ym);
  let C = fmul(p.T, t2d);
  let D = fadd(p.Z, p.Z);
  let E = fsub(A, B); let H = fadd(A, B); let G = fadd(D, C); let Fv = fsub(D, C);
  var r: Pt;
  r.X = fmul(E, Fv); r.Y = fmul(H, G); r.Z = fmul(G, Fv); r.T = fmul(E, H);
  return r;
}
fn scalarmult(s: array<u32, 32>) -> Pt {
  var acc: Pt;
  acc.Y[0] = 1u; acc.Z[0] = 1u;
  for (var j = 0u; j < 32u; j++) {
    let off = (j * 256u + s[j]) * 24u;
    acc = madd(acc, ldT(off), ldT(off + 8u), ldT(off + 16u));
  }
  return acc;
}
// returns the public key as a 256-bit integer in base58 order (big-endian bytes), 16-bit limbs
fn compressNum(p: Pt) -> F {
  let zi = finv(p.Z);
  let x = freeze(fmul(p.X, zi));
  var y = freeze(fmul(p.Y, zi));
  y[15] = y[15] | ((x[0] & 1u) << 15u);
  var v: F;
  for (var m = 0u; m < 16u; m++) { let l = y[15u - m]; v[m] = ((l & 0xffu) << 8u) | (l >> 8u); }
  return v;
}

// ---------- base58 pattern checks ----------
fn maskHas(base: u32, d: u32) -> bool {
  if (d < 32u) { return ((P[base] >> d) & 1u) == 1u; }
  return ((P[base + 1u] >> (d - 32u)) & 1u) == 1u;
}
fn mtOff(li: u32, t: u32, d: u32) -> u32 { return ((li * 10u + t) * 58u + d) * 8u; }
fn mtLimb(off: u32, i: u32) -> u32 { let w = MT[off + (i >> 1u)]; return select(w & 0xffffu, w >> 16u, (i & 1u) == 1u); }
fn geqM(v: F, off: u32) -> bool {
  for (var k = 0u; k < 16u; k++) {
    let i = 15u - k;
    let m = mtLimb(off, i);
    if (v[i] != m) { return v[i] > m; }
  }
  return true;
}
fn subM(v: F, off: u32) -> F {
  var r: F; var b = 0u;
  for (var i = 0u; i < 16u; i++) {
    let m = mtLimb(off, i) + b;
    if (v[i] >= m) { r[i] = v[i] - m; b = 0u; } else { r[i] = v[i] + 0x10000u - m; b = 1u; }
  }
  return r;
}
fn check(v0: F) -> bool {
  let preLen = P[8];
  let sufLen = P[9];
  if (preLen > 0u) {
    if ((v0[15] >> 8u) == 0u) { return false; }               // leading zero byte: address starts with '1'
    var li = 0u;                                              // 0: 44 chars, 1: 43 chars
    if (!geqM(v0, mtOff(0u, 0u, 1u))) {
      if (geqM(v0, mtOff(1u, 0u, 1u))) { li = 1u; } else { return false; }
    }
    var v = v0;
    for (var t = 0u; t < preLen; t++) {
      var lo = 0u; var hi = 57u;
      loop {
        if (lo >= hi) { break; }
        let mid = (lo + hi + 1u) >> 1u;
        if (geqM(v, mtOff(li, t, mid))) { lo = mid; } else { hi = mid - 1u; }
      }
      if (!maskHas(12u + 2u * t, lo)) { return false; }
      v = subM(v, mtOff(li, t, lo));
    }
  }
  if (sufLen > 0u) {
    var s = v0; var j = 0u;
    loop {
      if (j >= sufLen) { break; }
      var r = 0u;
      for (var k = 0u; k < 16u; k++) { let i = 15u - k; let cur = (r << 16u) | s[i]; s[i] = cur / 3364u; r = cur % 3364u; }
      if (!maskHas(32u + 2u * (sufLen - 1u - j), r % 58u)) { return false; }
      j++;
      if (j < sufLen) {
        if (!maskHas(32u + 2u * (sufLen - 1u - j), r / 58u)) { return false; }
        j++;
      }
    }
  }
  return true;
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) nwg: vec3<u32>) {
  let id = gid.x + gid.y * nwg.x * 64u;
  if (id >= P[11]) { return; }
  var sw: array<u32, 8>;
  for (var i = 0u; i < 8u; i++) { sw[i] = P[i]; }
  sw[7] = sw[7] ^ id;
  let s = sha_scalar(sw);
  let v = compressNum(scalarmult(s));
  if (id == 0u) {
    for (var i = 0u; i < 8u; i++) { O.sample[i] = v[2u * i] | (v[2u * i + 1u] << 16u); }
  }
  if (P[10] == 1u && id < 16u) {
    for (var i = 0u; i < 8u; i++) { O.dbg[id * 8u + i] = v[2u * i] | (v[2u * i + 1u] << 16u); }
    if (id == 0u) { for (var i = 0u; i < 32u; i++) { O.dbg[128u + i] = s[i]; } }
  }
  if (check(v)) {
    let k = atomicAdd(&O.count, 1u);
    if (k < 64u) { O.found[k] = id; }
  }
}
