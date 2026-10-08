// main.js — точка входа для Deno Deploy.
// Один деплой = API (/v1/*) + панель (статика, SPA с фолбэком на /index.html).
import handler from "./api/index.js";

function getEnv() {
  const g = (k, d) => {
    try {
      return Deno.env.get(k) ?? d;
    } catch {
      return d;
    }
  };
  return {
    JWT_SECRET: g("JWT_SECRET", "dev-change-me-in-dashboard"),
    CHEAT_API_SECRET: g("CHEAT_API_SECRET", "dev-cheat-secret"),
    CHEAT_CRYPTO_KEY_B64: g("CHEAT_CRYPTO_KEY_B64", ""),
    ADMIN_EMAIL: g("ADMIN_EMAIL", "admin@cheat.com"),
    ADMIN_PASSWORD: g("ADMIN_PASSWORD", "123098"),
    APP_ID: g("APP_ID", "cheat-ios-01"),
  };
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};
const ROUTES = ["/home", "/keys", "/create-key", "/sellers", "/logs", "/settings", "/login"];
const cache = new Map();

async function serveStatic(pathname) {
  let p = pathname;
  if (p === "/") p = "/home";
  if (ROUTES.includes(p)) p = "/index.html";
  if (p.includes("..")) p = "/index.html";
  if (cache.has(p)) return cache.get(p).clone();
  let bytes = null;
  try {
    bytes = await Deno.readFile("./static" + p);
  } catch {
    bytes = await Deno.readFile("./static/index.html"); // SPA-фолбэк
    p = "/index.html";
  }
  const ext = p.slice(p.lastIndexOf("."));
  const res = new Response(bytes, {
    status: 200,
    headers: { "content-type": MIME[ext] || "application/octet-stream" },
  });
  cache.set(p, res);
  return res.clone();
}

async function handle(req) {
  const url = new URL(req.url);
  if (url.pathname.startsWith("/v1/")) {
    return handler.fetch(req, getEnv(), {});
  }
  return serveStatic(url.pathname);
}

export default { fetch: handle };

// Локальный запуск: deno run -A main.js  ->  http://localhost:8000
if (import.meta.main) {
  Deno.serve({ port: 8000 }, handle);
}
