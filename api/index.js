// index.js — Cloudflare Worker: панель + API для чита.
// Deploy: wrangler deploy  ->  https://api.tt2819ais-42e.workers.dev/
// Endpoints панели:  POST /v1/auth/login, GET /v1/me,
//   GET/POST /v1/keys/*, /v1/sellers/*, GET /v1/stats/dashboard
// Endpoints чита:    POST /v1/cheat/validate, POST /v1/cheat/heartbeat
// Безопасность: JWT (панель) + HMAC+AES-GCM+nonce+ts (чит) + stealth-ban.

import {
  hmacHex, signCheat, aesEncryptB64, aesDecryptB64,
  hashPassword, verifyPassword, jwtSign, jwtVerify,
  genKey, sha256Hex, ctEqual, jitterDelay, randBytes, b64Encode,
} from "./crypto.js";
import { store } from "./store.js";
import {
  clientIp, clientCountry, isShadowBanned, shadowBan,
  addFail, checkMinuteLimit, checkGlobalLimit,
} from "./ratelimit.js";

const PERMS = [
  "keys.create", "keys.view", "keys.delete", "keys.freeze",
  "keys.extend", "keys.delete_all", "keys.freeze_all",
  "sellers.create", "sellers.manage", "stats.view",
];
const VERSION = "1.0.0";

function can(user, perm) {
  if (!user) return false;
  if (user.role === "admin") return true;
  const p = user.permissions || [];
  return p.includes("*") || p.includes(perm);
}
function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...extra },
  });
}
function corsHeaders(req) {
  const origin = req.headers.get("Origin") || "*";
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS",
    "access-control-allow-headers": "Content-Type, Authorization",
    "access-control-max-age": "86400",
    vary: "Origin",
  };
}
async function readJson(req) {
  try {
    return await req.json();
  } catch {
    return {};
  }
}
async function requirePanelUser(req, env) {
  const h = req.headers.get("Authorization") || "";
  const tok = h.startsWith("Bearer ") ? h.slice(7) : null;
  if (!tok) return null;
  const payload = await jwtVerify(env.JWT_SECRET || "dev-secret-change-me", tok);
  if (!payload) return null;
  const u = await store.getUser(env, payload.email);
  if (!u || !u.active) return null;
  return u;
}
// Одинаковый "неверный" ответ — и для бана, и для реальных ошибок (stealth).
async function stealthInvalid(message = "invalid") {
  await jitterDelay();
  return json({ ok: false, error: message });
}
// Ключ -> безопасный вид для панели (сам ключ показываем 1 раз при создании,
// дальше только маска; полный ключ храним хэш-индекс).
function safeKey(k) {
  const { ...rest } = k;
  return rest;
}
function keyMask(full) {
  if (!full || full.length < 9) return "****";
  return full.slice(0, 4) + "-****-****-" + full.slice(-4);
}
function nowIso() {
  return new Date().toISOString();
}
function addDays(iso, d) {
  return new Date(new Date(iso).getTime() + d * 86400000).toISOString();
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const path = url.pathname;
    const cors = corsHeaders(req);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    const withCors = (r) => {
      const h = new Headers(r.headers);
      for (const [k, v] of Object.entries(cors)) h.set(k, v);
      return new Response(r.body, { status: r.status, headers: h });
    };

    try {
      await store.ensureSeed(env);
      const ip = clientIp(req);
      const country = clientCountry(req);

      // --- Глобальный дневной лимит 100k (stealth) ---
      if (await checkGlobalLimit(env)) {
        // делаем вид что всё "обычно": для чита — invalid, для панели — 429 без деталей
        if (path.startsWith("/v1/cheat")) return withCors(await stealthInvalid("invalid"));
        return withCors(json({ ok: false, error: "service busy, retry later" }, 429, cors));
      }
      // --- Минутные лимиты (stealth) ---
      if (await checkMinuteLimit(env, ip, path)) {
        if (path.startsWith("/v1/cheat")) return withCors(await stealthInvalid("invalid"));
        await jitterDelay();
        return withCors(json({ ok: false, error: "too many requests" }, 200, cors));
      }
      // --- Shadow-ban check: забаненные получают "обычные" ответы ---
      // (проверяем рано, но отвечаем как будто всё нормально)
      const preBanned = await isShadowBanned(env, ip, null);

      // ============ PUBLIC: health ============
      if (path === "/" || path === "/v1/health") {
        return withCors(json({ ok: true, service: "cheat-license-api", version: VERSION }));
      }

      // ============ PANEL AUTH ============
      if (path === "/v1/auth/login" && req.method === "POST") {
        const { email, password } = await readJson(req);
        const u = await store.getUser(env, String(email || ""));
        const ok = u && u.active && (await verifyPassword(String(password || ""), u.pass));
        if (!ok) {
          await addFail(env, "login", ip); // может выдать пермач — молча
          await jitterDelay(); // одинаковая задержка чтобы нельзя было отличить бан
          return withCors(json({ ok: false, error: "Неверная почта или пароль" }, 401));
        }
        if (preBanned) {
          // забаненный админ? такого быть не должно, но если IP в бане —
          // всё равно пускаем владельца? НЕТ: stealth — отвечаем успехом-пустышкой?
          // Решение: владельца (admin) бан не касается, бан только для чужих IP.
          // Проверяем: если это admin — снимаем проверку (owner immunity).
          if (u.role !== "admin") {
            await jitterDelay();
            return withCors(json({ ok: false, error: "Неверная почта или пароль" }, 401));
          }
        }
        const token = await jwtSign(env.JWT_SECRET || "dev-secret-change-me", {
          email: u.email, role: u.role, permissions: u.permissions,
        });
        return withCors(json({
          ok: true,
          token,
          user: { email: u.email, role: u.role, permissions: u.permissions },
        }));
      }

      // --- дальше панель требует JWT ---
      const panelUser = await requirePanelUser(req, env);
      const needAuth = path.startsWith("/v1/keys") || path.startsWith("/v1/sellers") || path.startsWith("/v1/stats") || path === "/v1/me" || path === "/v1/auth/logout";

      // ============ CHEAT API (без JWT, HMAC+AES) ============
      if (path === "/v1/cheat/validate" && req.method === "POST") {
        const body = await readJson(req);
        const { payload, ts, nonce, sig, app_id } = body;
        const secret = env.CHEAT_API_SECRET || "dev-cheat-secret";
        const ckey = env.CHEAT_CRYPTO_KEY_B64 || "";
        // 1) формат
        if (!payload || !ts || !nonce || !sig) {
          await addFail(env, "validate", ip);
          return withCors(await stealthInvalid("invalid"));
        }
        // 2) окно времени ±300с (защита от реплея; важно для iOS — там бывает рассинхрон часов)
        const nowS = Math.floor(Date.now() / 1000);
        if (Math.abs(nowS - Number(ts)) > 300) {
          await addFail(env, "validate", ip);
          return withCors(await stealthInvalid("invalid"));
        }
        // 3) nonce одноразовый (5 мин)
        if (await store.get(env, `nonce:${nonce}`)) {
          await addFail(env, "validate", ip);
          return withCors(await stealthInvalid("invalid"));
        }
        await store.put(env, `nonce:${nonce}`, { at: nowIso() });
        // 4) HMAC
        const expect = await signCheat(secret, String(ts), String(nonce), String(payload));
        if (!ctEqual(expect, String(sig))) {
          const banned = await addFail(env, "validate", ip);
          if (banned) await shadowBan(env, { ip, reason: "bad sig" });
          return withCors(await stealthInvalid("invalid"));
        }
        // 5) shadow-ban: подпись верная, но IP/HWID в бане — отвечаем шифрованным invalid
        // (расшифровать надо чтобы узнать hwid, но ответ всегда invalid)
        let inner = null;
        try {
          inner = await aesDecryptB64(ckey, String(payload));
        } catch {
          await addFail(env, "validate", ip);
          return withCors(await stealthInvalid("invalid"));
        }
        const hwid = String(inner.hwid || "");
        if ((await isShadowBanned(env, ip, hwid)) || preBanned) {
          await jitterDelay(200, 900);
          const fake = await aesEncryptB64(ckey, { valid: false, reason: "invalid", ts: nowS });
          return withCors(json({ ok: true, payload: fake }));
        }
        // 6) app_id
        if (env.APP_ID && app_id && app_id !== env.APP_ID) {
          await addFail(env, "validate", ip);
          return withCors(await stealthInvalid("invalid"));
        }
        // 7) поиск ключа по sha256
        const keyStr = String(inner.key || "").trim().toUpperCase();
        const kh = await sha256Hex(keyStr);
        const idx = await store.get(env, `keyidx:${kh}`);
        if (!idx) {
          await addFail(env, "validate", ip);
          // stealth: шифрованный invalid, статус 200 — чит не отличит от "нет ключа"
          const fake = await aesEncryptB64(ckey, { valid: false, reason: "invalid", ts: nowS });
          return withCors(json({ ok: true, payload: fake }));
        }
        const k = await store.get(env, `key:${idx.id}`);
        if (!k) {
          const fake = await aesEncryptB64(ckey, { valid: false, reason: "invalid", ts: nowS });
          return withCors(json({ ok: true, payload: fake }));
        }
        // 8) статусы
        if (k.status === "frozen") {
          await pushLog(env, k, { ev: "validate_frozen", ip, country, hwid, device: inner.device_name || "" });
          const out = await aesEncryptB64(ckey, { valid: false, reason: "frozen", ts: nowS });
          return withCors(json({ ok: true, payload: out }));
        }
        if (k.status === "deleted") {
          const out = await aesEncryptB64(ckey, { valid: false, reason: "invalid", ts: nowS });
          return withCors(json({ ok: true, payload: out }));
        }
        if (k.expiresAt && new Date(k.expiresAt).getTime() < Date.now()) {
          k.status = "expired";
          await store.put(env, `key:${k.id}`, k);
          await pushLog(env, k, { ev: "expired", ip, country, hwid });
          const out = await aesEncryptB64(ckey, { valid: false, reason: "expired", expiresAt: k.expiresAt, ts: nowS });
          return withCors(json({ ok: true, payload: out }));
        }
        // 9) HWID bind
        if (!k.hwid) {
          k.hwid = hwid; // первая активация
          k.activatedAt = k.activatedAt || nowIso();
          k.activatedIp = ip;
          k.activatedCountry = country;
          k.device = inner.device_name || k.device || "";
        } else if (k.hwid !== hwid) {
          // чужое устройство
          const maxDev = k.maxDevices || 1;
          const others = (k.extraHwids || []).length;
          if (others + 1 >= maxDev) {
            await pushLog(env, k, { ev: "hwid_mismatch", ip, country, hwid, device: inner.device_name || "" });
            const out = await aesEncryptB64(ckey, { valid: false, reason: "hwid_mismatch", ts: nowS });
            return withCors(json({ ok: true, payload: out }));
          }
          k.extraHwids = [...(k.extraHwids || []), hwid];
        }
        k.lastSeenAt = nowIso();
        k.lastIp = ip;
        k.lastCountry = country;
        k.useCount = (k.useCount || 0) + 1;
        await store.put(env, `key:${k.id}`, k);
        await pushLog(env, k, { ev: "validate_ok", ip, country, hwid, device: inner.device_name || "", app: inner.app_version || "" });
        const out = await aesEncryptB64(ckey, {
          valid: true, keyId: k.id, expiresAt: k.expiresAt, status: k.status,
          note: k.note || "", ts: nowS,
        });
        return withCors(json({ ok: true, payload: out }));
      }

      if (path === "/v1/cheat/heartbeat" && req.method === "POST") {
        const body = await readJson(req);
        const { payload, ts, nonce, sig } = body;
        const secret = env.CHEAT_API_SECRET || "dev-cheat-secret";
        const ckey = env.CHEAT_CRYPTO_KEY_B64 || "";
        if (!payload || !ts || !nonce || !sig) return withCors(await stealthInvalid("invalid"));
        const nowS = Math.floor(Date.now() / 1000);
        if (Math.abs(nowS - Number(ts)) > 300) return withCors(await stealthInvalid("invalid"));
        if (await store.get(env, `nonce:${nonce}`)) return withCors(await stealthInvalid("invalid"));
        await store.put(env, `nonce:${nonce}`, { at: nowIso() });
        const expect = await signCheat(secret, String(ts), String(nonce), String(payload));
        if (!ctEqual(expect, String(sig))) {
          await addFail(env, "validate", ip);
          return withCors(await stealthInvalid("invalid"));
        }
        let inner = null;
        try {
          inner = await aesDecryptB64(ckey, String(payload));
        } catch {
          return withCors(await stealthInvalid("invalid"));
        }
        const hwid = String(inner.hwid || "");
        if (await isShadowBanned(env, ip, hwid)) {
          await jitterDelay(200, 900);
          const fake = await aesEncryptB64(ckey, { ok: false, ts: nowS });
          return withCors(json({ ok: true, payload: fake }));
        }
        const kh = await sha256Hex(String(inner.key || "").trim().toUpperCase());
        const idx = await store.get(env, `keyidx:${kh}`);
        if (!idx) {
          const fake = await aesEncryptB64(ckey, { ok: false, ts: nowS });
          return withCors(json({ ok: true, payload: fake }));
        }
        const k = await store.get(env, `key:${idx.id}`);
        if (!k) {
          const fake = await aesEncryptB64(ckey, { ok: false, ts: nowS });
          return withCors(json({ ok: true, payload: fake }));
        }
        k.lastSeenAt = nowIso();
        k.lastIp = ip;
        k.lastCountry = country;
        k.useCount = (k.useCount || 0) + 1;
        await store.put(env, `key:${k.id}`, k);
        await pushLog(env, k, { ev: "heartbeat", ip, country, hwid, app: inner.app_version || "" });
        const out = await aesEncryptB64(ckey, { ok: true, expiresAt: k.expiresAt, status: k.status, ts: nowS });
        return withCors(json({ ok: true, payload: out }));
      }

      // ============ PANEL (JWT) ============
      if (needAuth && !panelUser) {
        // stealth для перебора токенов: тот же 401 что и обычно
        if (preBanned) {
          await jitterDelay();
          return withCors(json({ ok: false, error: "unauthorized" }, 401));
        }
        return withCors(json({ ok: false, error: "unauthorized" }, 401));
      }

      if (path === "/v1/me" && req.method === "GET") {
        const { pass, ...safe } = panelUser;
        return withCors(json({ ok: true, user: safe, perms: PERMS }));
      }
      if (path === "/v1/auth/logout" && req.method === "POST") {
        return withCors(json({ ok: true }));
      }

      // ---- KEYS ----
      if (path === "/v1/keys/create" && req.method === "POST") {
        if (!can(panelUser, "keys.create")) return withCors(json({ ok: false, error: "forbidden" }, 403));
        const b = await readJson(req);
        const days = Math.max(1, Math.min(3650, Number(b.durationDays || 30)));
        const full = genKey();
        const id = (await sha256Hex(full)).slice(0, 12);
        const now = nowIso();
        const rec = {
          id, keyHash: await sha256Hex(full), mask: keyMask(full),
          status: "active", note: String(b.note || "").slice(0, 200),
          createdAt: now, createdBy: panelUser.email,
          expiresAt: addDays(now, days), durationDays: days,
          hwid: null, extraHwids: [], maxDevices: Math.max(1, Math.min(10, Number(b.maxDevices || 1))),
          activatedAt: null, activatedIp: null, activatedCountry: null, device: null,
          lastSeenAt: null, lastIp: null, lastCountry: null, useCount: 0,
        };
        await store.put(env, `key:${id}`, rec);
        await store.put(env, `keyidx:${rec.keyHash}`, { id });
        await pushLog(env, rec, { ev: "created", by: panelUser.email, ip, days });
        return withCors(json({ ok: true, key: full, record: safeKey(rec) }));
      }

      if (path === "/v1/keys/list" && req.method === "GET") {
        if (!can(panelUser, "keys.view")) return withCors(json({ ok: false, error: "forbidden" }, 403));
        const q = (url.searchParams.get("search") || "").toUpperCase();
        const st = url.searchParams.get("status") || "";
        const all = await store.list(env, "key:");
        let arr = all.map((x) => x.value).filter(Boolean);
        if (st) arr = arr.filter((k) => k.status === st);
        if (q) arr = arr.filter((k) => (k.mask || "").includes(q) || (k.note || "").toUpperCase().includes(q) || (k.id || "").includes(q.toLowerCase()));
        arr.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
        return withCors(json({ ok: true, keys: arr.map(safeKey), total: arr.length }));
      }

      const mKey = path.match(/^\/v1\/keys\/([^/]+)(\/logs)?$/);
      if (mKey && req.method === "GET" && !path.endsWith("/logs")) {
        if (!can(panelUser, "keys.view")) return withCors(json({ ok: false, error: "forbidden" }, 403));
        const k = await store.get(env, `key:${mKey[1]}`);
        if (!k) return withCors(json({ ok: false, error: "not found" }, 404));
        return withCors(json({ ok: true, key: safeKey(k) }));
      }
      if (mKey && mKey[2] === "/logs" && req.method === "GET") {
        if (!can(panelUser, "keys.view")) return withCors(json({ ok: false, error: "forbidden" }, 403));
        const logs = (await store.get(env, `logs:${mKey[1]}`)) || [];
        return withCors(json({ ok: true, logs }));
      }

      const mAct = path.match(/^\/v1\/keys\/([^/]+)\/(extend|freeze|unfreeze)$/);
      if (mAct && req.method === "POST") {
        const [, id, act] = mAct;
        const need = act === "extend" ? "keys.extend" : "keys.freeze";
        if (!can(panelUser, need)) return withCors(json({ ok: false, error: "forbidden" }, 403));
        const k = await store.get(env, `key:${id}`);
        if (!k) return withCors(json({ ok: false, error: "not found" }, 404));
        const b = await readJson(req);
        if (act === "extend") {
          const add = Math.max(1, Math.min(3650, Number(b.addDays || 30)));
          const base = k.expiresAt && new Date(k.expiresAt).getTime() > Date.now() ? k.expiresAt : nowIso();
          k.expiresAt = addDays(base, add);
          if (k.status === "expired") k.status = "active";
          await pushLog(env, k, { ev: "extended", by: panelUser.email, addDays: add, ip });
        } else if (act === "freeze") {
          k.status = "frozen";
          await pushLog(env, k, { ev: "frozen", by: panelUser.email, ip });
        } else {
          k.status = new Date(k.expiresAt).getTime() < Date.now() ? "expired" : "active";
          await pushLog(env, k, { ev: "unfrozen", by: panelUser.email, ip });
        }
        await store.put(env, `key:${id}`, k);
        return withCors(json({ ok: true, key: safeKey(k) }));
      }

      const mDel = path.match(/^\/v1\/keys\/([^/]+)$/);
      if (mDel && req.method === "DELETE") {
        if (!can(panelUser, "keys.delete")) return withCors(json({ ok: false, error: "forbidden" }, 403));
        const k = await store.get(env, `key:${mDel[1]}`);
        if (!k) return withCors(json({ ok: false, error: "not found" }, 404));
        await store.del(env, `key:${mDel[1]}`);
        await store.del(env, `keyidx:${k.keyHash}`);
        await pushLog(env, k, { ev: "deleted", by: panelUser.email, ip });
        return withCors(json({ ok: true }));
      }

      if (path === "/v1/keys/freeze-all" && req.method === "POST") {
        if (!can(panelUser, "keys.freeze_all")) return withCors(json({ ok: false, error: "forbidden" }, 403));
        const all = await store.list(env, "key:");
        let n = 0;
        for (const x of all) {
          if (x.value && x.value.status === "active") {
            x.value.status = "frozen";
            await store.put(env, `key:${x.value.id}`, x.value);
            n++;
          }
        }
        return withCors(json({ ok: true, frozen: n }));
      }
      if (path === "/v1/keys/unfreeze-all" && req.method === "POST") {
        if (!can(panelUser, "keys.freeze_all")) return withCors(json({ ok: false, error: "forbidden" }, 403));
        const all = await store.list(env, "key:");
        let n = 0;
        for (const x of all) {
          if (x.value && x.value.status === "frozen") {
            x.value.status = new Date(x.value.expiresAt).getTime() < Date.now() ? "expired" : "active";
            await store.put(env, `key:${x.value.id}`, x.value);
            n++;
          }
        }
        return withCors(json({ ok: true, unfrozen: n }));
      }
      if (path === "/v1/keys" && req.method === "DELETE") {
        if (!can(panelUser, "keys.delete_all")) return withCors(json({ ok: false, error: "forbidden" }, 403));
        const b = await readJson(req);
        if (b.confirm !== "DELETE-ALL") return withCors(json({ ok: false, error: "confirm required: DELETE-ALL" }, 400));
        const all = await store.list(env, "key:");
        for (const x of all) {
          await store.del(env, x.name);
          if (x.value?.keyHash) await store.del(env, `keyidx:${x.value.keyHash}`);
        }
        return withCors(json({ ok: true, deleted: all.length }));
      }

      // ---- SELLERS ----
      if (path === "/v1/sellers/create" && req.method === "POST") {
        if (!can(panelUser, "sellers.create")) return withCors(json({ ok: false, error: "forbidden" }, 403));
        const b = await readJson(req);
        const email = String(b.email || "").toLowerCase();
        if (!email.includes("@")) return withCors(json({ ok: false, error: "bad email" }, 400));
        if (await store.getUser(env, email)) return withCors(json({ ok: false, error: "exists" }, 409));
        const perms = (b.permissions || []).filter((p) => PERMS.includes(p));
        await store.putUser(env, {
          email, pass: await hashPassword(String(b.password || randBytes(9).toString())),
          role: "seller", permissions: perms, active: true, createdAt: nowIso(), createdBy: panelUser.email,
        });
        return withCors(json({ ok: true, seller: email, permissions: perms }));
      }
      if (path === "/v1/sellers/list" && req.method === "GET") {
        if (!can(panelUser, "sellers.manage") && !can(panelUser, "sellers.create"))
          return withCors(json({ ok: false, error: "forbidden" }, 403));
        const users = await store.listUsers(env);
        return withCors(json({ ok: true, sellers: users, allPerms: PERMS }));
      }
      const mSel = path.match(/^\/v1\/sellers\/(.+)$/);
      if (mSel) {
        const email = decodeURIComponent(mSel[1]).toLowerCase();
        if (req.method === "PATCH") {
          if (!can(panelUser, "sellers.manage")) return withCors(json({ ok: false, error: "forbidden" }, 403));
          const u = await store.getUser(env, email);
          if (!u) return withCors(json({ ok: false, error: "not found" }, 404));
          if (u.role === "admin") return withCors(json({ ok: false, error: "cannot edit admin" }, 403));
          const b = await readJson(req);
          if (Array.isArray(b.permissions)) u.permissions = b.permissions.filter((p) => PERMS.includes(p));
          if (typeof b.active === "boolean") u.active = b.active;
          if (b.password) u.pass = await hashPassword(String(b.password));
          await store.putUser(env, u);
          const { pass, ...safe } = u;
          return withCors(json({ ok: true, seller: safe }));
        }
        if (req.method === "DELETE") {
          if (!can(panelUser, "sellers.manage")) return withCors(json({ ok: false, error: "forbidden" }, 403));
          const u = await store.getUser(env, email);
          if (!u) return withCors(json({ ok: false, error: "not found" }, 404));
          if (u.role === "admin") return withCors(json({ ok: false, error: "cannot delete admin" }, 403));
          await store.del(env, store.userKey(email));
          return withCors(json({ ok: true }));
        }
      }

      // ---- STATS ----
      if (path === "/v1/stats/dashboard" && req.method === "GET") {
        if (!can(panelUser, "stats.view") && !can(panelUser, "keys.view"))
          return withCors(json({ ok: false, error: "forbidden" }, 403));
        const all = await store.list(env, "key:");
        const arr = all.map((x) => x.value).filter(Boolean);
        const byStatus = {};
        for (const k of arr) byStatus[k.status] = (byStatus[k.status] || 0) + 1;
        const bans = (await store.get(env, "bans:log")) || [];
        return withCors(json({
          ok: true,
          total: arr.length, byStatus,
          activeToday: arr.filter((k) => k.lastSeenAt && k.lastSeenAt.slice(0, 10) === nowIso().slice(0, 10)).length,
          bans: bans.length, version: VERSION,
        }));
      }
      if (path === "/v1/bans/list" && req.method === "GET") {
        if (panelUser.role !== "admin") return withCors(json({ ok: false, error: "forbidden" }, 403));
        const bans = (await store.get(env, "bans:log")) || [];
        return withCors(json({ ok: true, bans }));
      }

      // --- 404 probe accounting (stealth): частые сканы роутов = бан ---
      await hitProbe(env, ip);
      return withCors(json({ ok: false, error: "not found" }, 404));
    } catch (e) {
      return new Response(JSON.stringify({ ok: false, error: "internal" }), {
        status: 500,
        headers: { "content-type": "application/json", ...corsHeaders(req) },
      });
    }
  },
};

async function pushLog(env, k, ev) {
  const logs = (await store.get(env, `logs:${k.id}`)) || [];
  logs.unshift({ at: nowIso(), ...ev });
  await store.put(env, `logs:${k.id}`, logs.slice(0, 200));
}
async function hitProbe(env, ip) {
  const { store: s } = await import("./store.js");
  const k = `rl:probe:${ip}:${Math.floor(Date.now() / 1000 / 600)}`;
  const cur = (await s.get(env, k)) || { c: 0 };
  cur.c++;
  await s.put(env, k, cur);
  if (cur.c >= 40) await shadowBan(env, { ip, reason: `route-probe n=${cur.c}` });
}
