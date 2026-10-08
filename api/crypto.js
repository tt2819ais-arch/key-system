// crypto.js — WebCrypto-only (Cloudflare Workers + Node 18+).
// Уровень 2: HMAC-SHA256 подписи. Уровень 3: AES-256-GCM шифрование.
// Уровень 4: PBKDF2 хэш паролей. JWT HS256 для панели.

const te = new TextEncoder();
const td = new TextDecoder();

export function b64urlEncode(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function b64urlDecode(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
export function b64Encode(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s);
}
export function b64Decode(s) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
export function hexEncode(bytes) {
  return [...new Uint8Array(bytes)].map((x) => x.toString(16).padStart(2, "0")).join("");
}
export function hexDecode(s) {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}
export function randBytes(n) {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}
// constant-time compare строк
export function ctEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

// ---- HMAC ----
export async function hmacHex(secretStr, msgStr) {
  const key = await crypto.subtle.importKey("raw", te.encode(secretStr), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, te.encode(msgStr));
  return hexEncode(sig);
}
// Cheat signature: HMAC(CHEAT_API_SECRET, ts + "." + nonce + "." + payloadB64)
export async function signCheat(secret, ts, nonce, payloadB64) {
  return hmacHex(secret, `${ts}.${nonce}.${payloadB64}`);
}

// ---- AES-256-GCM ----
// Формат: base64( iv(12) || ciphertext+tag ). Совместим с Python/C#/Swift клиентами.
export async function aesEncryptB64(keyB64, obj) {
  const keyBytes = b64Decode(keyB64);
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, ["encrypt"]);
  const iv = randBytes(12);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, te.encode(JSON.stringify(obj)));
  const out = new Uint8Array(12 + ct.byteLength);
  out.set(iv, 0);
  out.set(new Uint8Array(ct), 12);
  return b64Encode(out);
}
export async function aesDecryptB64(keyB64, payloadB64) {
  const raw = b64Decode(payloadB64);
  if (raw.length < 13) throw new Error("payload too short");
  const iv = raw.slice(0, 12);
  const ct = raw.slice(12);
  const keyBytes = b64Decode(keyB64);
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, ["decrypt"]);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
  return JSON.parse(td.decode(pt));
}

// ---- Passwords: PBKDF2-SHA256 120k ----
export async function hashPassword(pw) {
  const salt = randBytes(16);
  const base = await crypto.subtle.importKey("raw", te.encode(pw), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: 120000 }, base, 256);
  return `pbkdf2$120000$${b64Encode(salt)}$${b64Encode(new Uint8Array(bits))}`;
}
export async function verifyPassword(pw, stored) {
  try {
    const [tag, it, saltB64, hashB64] = stored.split("$");
    if (tag !== "pbkdf2") return false;
    const iterations = parseInt(it, 10);
    const salt = b64Decode(saltB64);
    const base = await crypto.subtle.importKey("raw", te.encode(pw), "PBKDF2", false, ["deriveBits"]);
    const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, base, 256);
    return ctEqual(b64Encode(new Uint8Array(bits)), hashB64);
  } catch {
    return false;
  }
}

// ---- JWT HS256 ----
export async function jwtSign(secret, payload, expSec = 43200) {
  const h = b64urlEncode(te.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const p = b64urlEncode(
    te.encode(JSON.stringify({ ...payload, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + expSec }))
  );
  const key = await crypto.subtle.importKey("raw", te.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, te.encode(`${h}.${p}`));
  return `${h}.${p}.${b64urlEncode(new Uint8Array(sig))}`;
}
export async function jwtVerify(secret, token) {
  try {
    const [h, p, s] = token.split(".");
    if (!h || !p || !s) return null;
    const key = await crypto.subtle.importKey("raw", te.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
    const ok = await crypto.subtle.verify("HMAC", key, b64urlDecode(s), te.encode(`${h}.${p}`));
    if (!ok) return null;
    const payload = JSON.parse(td.decode(b64urlDecode(p)));
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

// ---- Key format ----
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford base32: ровно 32 символа, без I/L/O/U
export function genKey() {
  const b = randBytes(10); // 80 бит
  let num = 0n;
  for (const x of b) num = (num << 8n) | BigInt(x);
  let s = "";
  for (let i = 0; i < 16; i++) {
    s = ALPHABET[Number(num % 32n)] + s;
    num /= 32n;
  }
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}`;
}
export async function sha256Hex(str) {
  const d = await crypto.subtle.digest("SHA-256", te.encode(str));
  return hexEncode(d);
}
export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
export function jitterDelay(min = 300, max = 1200) {
  return sleep(min + Math.random() * (max - min));
}
