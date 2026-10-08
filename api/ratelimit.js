// ratelimit.js — лимиты + STEALTH-бан навсегда (Deno-версия).
// Отличие от Cloudflare-версии: окна/нонсы с TTL (expireInMs) —
// Deno KV сам чистит мусор, переполнения нет.
// Забаненный НИКОГДА не узнаёт о бане: обычные ответы + джиттер.

export function clientIp(req) {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return req.headers.get("cf-connecting-ip") || "0.0.0.0";
}
export function clientCountry(req) {
  return req.headers.get("cf-ipcountry") || "XX";
}

async function hitWindow(env, key, windowSec) {
  const now = Math.floor(Date.now() / 1000);
  const k = `rl:${key}:${Math.floor(now / windowSec)}`;
  const { store } = await import("./store.js");
  const cur = (await store.get(env, k)) || { c: 0 };
  cur.c++;
  await store.put(env, k, cur, { expireInMs: windowSec * 1000 * 2 });
  return cur.c;
}

export async function isShadowBanned(env, ip, hwid) {
  const { store } = await import("./store.js");
  if (ip && (await store.get(env, `ban:ip:${ip}`))) return true;
  if (hwid && (await store.get(env, `ban:hwid:${hwid}`))) return true;
  return false;
}
export async function shadowBan(env, { ip, hwid, reason }) {
  const { store } = await import("./store.js");
  const rec = { reason, at: new Date().toISOString(), permanent: true };
  if (ip) await store.put(env, `ban:ip:${ip}`, rec); // без TTL — навсегда
  if (hwid) await store.put(env, `ban:hwid:${hwid}`, rec);
  const log = (await store.get(env, "bans:log")) || [];
  log.unshift({ ip: ip || null, hwid: hwid || null, reason, at: rec.at });
  await store.put(env, "bans:log", log.slice(0, 500));
}

export async function addFail(env, scope, ip) {
  const n = await hitWindow(env, `fail:${scope}:${ip}:600`, 600);
  const limit = scope === "login" ? 20 : scope === "validate" ? 60 : 40;
  if (n >= limit) {
    await shadowBan(env, { ip, reason: `bruteforce:${scope} n=${n}` });
    return true;
  }
  return false;
}

export async function checkMinuteLimit(env, ip, path) {
  const isCheat = path.startsWith("/v1/cheat");
  const isAuth = path.startsWith("/v1/auth");
  const limit = isAuth ? 30 : isCheat ? 120 : 200;
  const n = await hitWindow(env, `min:${ip}:60`, 60);
  if (n > limit) {
    const s = await hitWindow(env, `over:${ip}:600`, 600);
    if (s >= 3) await shadowBan(env, { ip, reason: `ratelimit n=${n}` });
    return true;
  }
  return false;
}

export async function checkGlobalLimit(env) {
  const day = new Date().toISOString().slice(0, 10);
  const n = await hitWindow(env, `global:${day}:86400`, 86400);
  return n > 100000;
}
