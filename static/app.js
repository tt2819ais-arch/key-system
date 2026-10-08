// SPA-панель: роутеры /home /keys /create-key /sellers /logs /settings /login + 404
const API = () => (window.API_BASE === "" ? location.origin : (window.API_BASE || "https://api.tt2819ais-42e.workers.dev"));
const app = document.getElementById("app");
const nav = document.getElementById("nav");
const logoutBtn = document.getElementById("logoutBtn");
document.getElementById("apiLabel").textContent = API();

const store = {
  get token() { return localStorage.getItem("lp_token") || ""; },
  set token(v) { v ? localStorage.setItem("lp_token", v) : localStorage.removeItem("lp_token"); },
  get user() { try { return JSON.parse(localStorage.getItem("lp_user") || "null"); } catch { return null; } },
  set user(v) { v ? localStorage.setItem("lp_user", JSON.stringify(v)) : localStorage.removeItem("lp_user"); },
};

async function api(path, opts = {}) {
  const res = await fetch(API() + path, {
    ...opts,
    headers: { "content-type": "application/json", ...(store.token ? { authorization: "Bearer " + store.token } : {}), ...(opts.headers || {}) },
  });
  let data = {};
  try { data = await res.json(); } catch { /* noop */ }
  if (res.status === 401 && location.pathname !== "/login") { logout(); return { ok: false, error: "unauthorized" }; }
  return { status: res.status, ...data };
}
function logout() { store.token = ""; store.user = null; location.href = "/login"; }
logoutBtn.onclick = logout;
if (store.token) { nav.hidden = false; logoutBtn.hidden = false; }

// тема белая/чёрная
const themeBtn = document.getElementById("themeBtn");
function setTheme(t) { document.documentElement.dataset.theme = t; localStorage.setItem("lp_theme", t); }
setTheme(localStorage.getItem("lp_theme") || "light");
themeBtn.onclick = () => setTheme(document.documentElement.dataset.theme === "light" ? "dark" : "light");

// --- роутер ---
const routes = ["/home", "/keys", "/create-key", "/sellers", "/logs", "/settings", "/login"];
document.addEventListener("click", (e) => {
  const a = e.target.closest("[data-link]");
  if (!a) return;
  e.preventDefault();
  navigate(a.getAttribute("href"));
});
window.addEventListener("popstate", render);
function navigate(p) { history.pushState({}, "", p); render(); }

async function render() {
  const path = location.pathname === "/" ? "/home" : location.pathname;
  document.querySelectorAll(".nav a").forEach((a) => a.classList.toggle("active", a.getAttribute("href") === path));
  if (path === "/login") return viewLogin();
  if (!store.token) return navigate("/login");
  if (path === "/home") return viewHome();
  if (path === "/keys") return viewKeys();
  if (path === "/create-key") return viewCreate();
  if (path === "/sellers") return viewSellers();
  if (path === "/logs") return viewLogs();
  if (path === "/settings") return viewSettings();
  return view404(path);
}
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// --- views ---
async function viewLogin() {
  nav.hidden = true; logoutBtn.hidden = true;
  app.innerHTML = `<h1>Вход</h1><p class="mut">Панель управления ключами чита.</p>
  <div class="card" style="max-width:420px"><label>Почта</label><input id="em" value="admin@cheat.com" autocomplete="username">
  <label>Пароль</label><input id="pw" type="password" value="123098" autocomplete="current-password">
  <div style="margin-top:14px" class="row"><button class="btn" id="go">Войти</button></div>
  <div id="msg"></div></div>`;
  document.getElementById("go").onclick = async () => {
    const email = document.getElementById("em").value.trim();
    const password = document.getElementById("pw").value;
    const r = await api("/v1/auth/login", { method: "POST", body: JSON.stringify({ email, password }) });
    if (r.ok) { store.token = r.token; store.user = r.user; nav.hidden = false; logoutBtn.hidden = false; navigate("/home"); }
    else document.getElementById("msg").innerHTML = `<div class="err">${esc(r.error || "Ошибка")}</div>`;
  };
}

async function viewHome() {
  const r = await api("/v1/stats/dashboard");
  const u = store.user || {};
  app.innerHTML = `<h1>Главная</h1><p class="mut">${esc(u.email || "")} · роль: <span class="kbd">${esc(u.role || "")}</span></p>
  <div class="grid c3">
    <div class="card"><h3>Всего ключей</h3><div class="big">${r.total ?? "—"}</div></div>
    <div class="card"><h3>Активны сегодня</h3><div class="big">${r.activeToday ?? "—"}</div></div>
    <div class="card"><h3>Теневых банов</h3><div class="big">${r.bans ?? "—"}</div></div>
  </div>
  <div class="card" style="margin-top:14px"><h3>По статусам</h3><div class="mono">${esc(JSON.stringify(r.byStatus || {}))}</div>
  <div class="toolbar"><a class="btn ghost" data-link href="/create-key">Создать ключ</a>
  <a class="btn ghost" data-link href="/keys">Все ключи</a></div></div>`;
}

async function viewKeys() {
  app.innerHTML = `<h1>Ключи</h1>
  <div class="toolbar"><input id="q" placeholder="Поиск: маска / note / id" style="max-width:280px">
  <select id="st" style="max-width:180px"><option value="">Все</option><option>active</option><option>frozen</option><option>expired</option></select>
  <button class="btn ghost" id="find">Найти</button>
  <button class="btn ghost" id="frz">Заморозить все</button>
  <button class="btn ghost" id="unfrz">Разморозить все</button>
  <button class="btn danger" id="delall">Удалить все</button></div>
  <div id="out"></div><div id="detail"></div>`;
  const load = async () => {
    const q = document.getElementById("q").value, st = document.getElementById("st").value;
    const r = await api(`/v1/keys/list?search=${encodeURIComponent(q)}&status=${encodeURIComponent(st)}`);
    const rows = (r.keys || []).map((k) => `<tr>
      <td class="mono">${esc(k.mask)}<br><span class="mut">${esc(k.id)}</span></td>
      <td><span class="pill ${esc(k.status)}">${esc(k.status)}</span><br><span class="mut">${esc(k.note || "")}</span></td>
      <td>создан: ${esc((k.createdAt || "").slice(0, 16))}<br>истекает: ${esc((k.expiresAt || "").slice(0, 16))}<br>активация: ${esc((k.activatedAt || "—").slice(0, 16))}</td>
      <td>устройство: ${esc(k.device || k.hwid || "—")}<br>страна акт.: ${esc(k.activatedCountry || "—")}<br>последнее: ${esc((k.lastSeenAt || "—").slice(0, 16))} ${esc(k.lastCountry || "")}<br>использований: ${esc(k.useCount || 0)}</td>
      <td><div class="row">
        <button class="btn small ghost" data-v="${k.id}">Открыть</button>
        <button class="btn small ghost" data-e="${k.id}">+30д</button>
        <button class="btn small ghost" data-f="${k.id}">Фриз</button>
        <button class="btn small ghost" data-u="${k.id}">Анфриз</button>
        <button class="btn small danger" data-d="${k.id}">Удалить</button>
      </div></td></tr>`).join("");
    document.getElementById("out").innerHTML = `<div class="card"><table><tr><th>Ключ</th><th>Статус</th><th>Сроки</th><th>Устройство / гео</th><th>Действия</th></tr>${rows || `<tr><td colspan="5" class="mut">Пусто</td></tr>`}</table></div>`;
  };
  document.getElementById("find").onclick = load;
  document.getElementById("frz").onclick = async () => { await api("/v1/keys/freeze-all", { method: "POST" }); load(); };
  document.getElementById("unfrz").onclick = async () => { await api("/v1/keys/unfreeze-all", { method: "POST" }); load(); };
  document.getElementById("delall").onclick = async () => {
    if (!confirm("Удалить ВСЕ ключи?")) return;
    const c = prompt('Введи DELETE-ALL для подтверждения:');
    const r = await api("/v1/keys", { method: "DELETE", body: JSON.stringify({ confirm: c }) });
    alert(r.ok ? `Удалено: ${r.deleted}` : (r.error || "Ошибка")); load();
  };
  document.getElementById("out").onclick = async (e) => {
    const b = e.target.closest("button"); if (!b) return;
    const id = b.dataset.v || b.dataset.e || b.dataset.f || b.dataset.u || b.dataset.d;
    if (b.dataset.v) {
      const k = await api(`/v1/keys/${id}`); const l = await api(`/v1/keys/${id}/logs`);
      document.getElementById("detail").innerHTML = `<div class="card"><h3>Ключ ${esc(k.key?.mask || id)}</h3>
      <div class="mono">${esc(JSON.stringify(k.key || {}, null, 1))}</div>
      <h3 style="margin-top:12px">Лог использований (${(l.logs || []).length})</h3>
      <table><tr><th>Время</th><th>Событие</th><th>IP</th><th>Страна</th><th>HWID/устройство</th></tr>
      ${(l.logs || []).map((x) => `<tr><td class="mono">${esc((x.at || "").slice(0, 19).replace("T", " "))}</td><td>${esc(x.ev)}</td><td class="mono">${esc(x.ip || "")}</td><td>${esc(x.country || "")}</td><td class="mono">${esc(x.hwid || x.device || "")}</td></tr>`).join("")}</table></div>`;
      document.getElementById("detail").scrollIntoView();
    }
    if (b.dataset.e) { const d = prompt("На сколько дней продлить?", "30"); if (d) await api(`/v1/keys/${id}/extend`, { method: "POST", body: JSON.stringify({ addDays: +d }) }); load(); }
    if (b.dataset.f) { await api(`/v1/keys/${id}/freeze`, { method: "POST" }); load(); }
    if (b.dataset.u) { await api(`/v1/keys/${id}/unfreeze`, { method: "POST" }); load(); }
    if (b.dataset.d) { if (confirm("Удалить ключ?")) await api(`/v1/keys/${id}`, { method: "DELETE" }); load(); }
  };
  await load();
}

async function viewCreate() {
  app.innerHTML = `<h1>Создать ключ</h1><div class="card" style="max-width:520px">
  <label>Срок (дней)</label><input id="days" type="number" value="30" min="1" max="3650">
  <label>Заметка (кому выдан)</label><input id="note" placeholder="например: buyer #12, iOS">
  <label>Макс. устройств</label><input id="md" type="number" value="1" min="1" max="10">
  <div class="row" style="margin-top:14px"><button class="btn" id="mk">Создать</button></div><div id="msg"></div></div>`;
  document.getElementById("mk").onclick = async () => {
    const r = await api("/v1/keys/create", { method: "POST", body: JSON.stringify({ durationDays: +document.getElementById("days").value || 30, note: document.getElementById("note").value, maxDevices: +document.getElementById("md").value || 1 }) });
    document.getElementById("msg").innerHTML = r.ok
      ? `<div class="okbox">Ключ (показан один раз, скопируй):<br><b class="mono">${esc(r.key)}</b></div>`
      : `<div class="err">${esc(r.error || "Ошибка")}</div>`;
  };
}

async function viewSellers() {
  const r = await api("/v1/sellers/list");
  if (!r.ok) { app.innerHTML = `<div class="err">${esc(r.error || "Нет прав")}</div>`; return; }
  const perms = r.allPerms || [];
  app.innerHTML = `<h1>Селлеры</h1><div class="card" style="max-width:560px"><h3>Создать селлера</h3>
  <label>Почта</label><input id="se"><label>Пароль</label><input id="sp">
  <div class="perms">${perms.map((p) => `<label><input type="checkbox" value="${p}"> ${p}</label>`).join("")}</div>
  <div class="row" style="margin-top:12px"><button class="btn" id="mk">Создать</button></div><div id="msg"></div></div>
  <div class="card" style="margin-top:14px"><table><tr><th>Email</th><th>Роль</th><th>Права</th><th></th></tr>
  ${(r.sellers || []).map((s) => `<tr><td>${esc(s.email)}</td><td>${esc(s.role)}</td><td class="mono">${esc((s.permissions || []).join(", "))}</td>
  <td>${s.role === "admin" ? "" : `<button class="btn small danger" data-del="${esc(s.email)}">Удалить</button>`}</td></tr>`).join("")}</table></div>`;
  document.getElementById("mk").onclick = async () => {
    const checked = [...document.querySelectorAll(".perms input:checked")].map((x) => x.value);
    const rr = await api("/v1/sellers/create", { method: "POST", body: JSON.stringify({ email: document.getElementById("se").value.trim(), password: document.getElementById("sp").value, permissions: checked }) });
    document.getElementById("msg").innerHTML = rr.ok ? `<div class="okbox">Создан: ${esc(rr.seller)}</div>` : `<div class="err">${esc(rr.error)}</div>`;
    if (rr.ok) render();
  };
  app.querySelector("[data-del]")?.addEventListener("click", async (e) => {
    const em = e.target.dataset.del;
    if (confirm(`Удалить ${em}?`)) { await api(`/v1/sellers/${encodeURIComponent(em)}`, { method: "DELETE" }); render(); }
  });
}

async function viewLogs() {
  app.innerHTML = `<h1>Логи</h1><p class="mut">Открой ключ в разделе «Ключи» → «Открыть», чтобы увидеть устройство, время активации, страну, последнее использование и полный лог.</p>
  <div class="card"><label>ID ключа</label><input id="kid" placeholder="первые 12 символов sha — поле id из таблицы ключей">
  <div class="row" style="margin-top:12px"><button class="btn" id="go">Показать лог</button></div><div id="out" style="margin-top:12px"></div></div>`;
  document.getElementById("go").onclick = async () => {
    const id = document.getElementById("kid").value.trim();
    const l = await api(`/v1/keys/${id}/logs`);
    document.getElementById("out").innerHTML = l.ok
      ? `<table><tr><th>Время</th><th>Событие</th><th>IP</th><th>Страна</th><th>HWID</th></tr>${(l.logs || []).map((x) => `<tr><td class="mono">${esc(x.at)}</td><td>${esc(x.ev)}</td><td class="mono">${esc(x.ip || "")}</td><td>${esc(x.country || "")}</td><td class="mono">${esc(x.hwid || "")}</td></tr>`).join("")}</table>`
      : `<div class="err">${esc(l.error)}</div>`;
  };
}

async function viewSettings() {
  const me = await api("/v1/me");
  app.innerHTML = `<h1>Настройки</h1><div class="card"><h3>Сессия</h3><div class="mono">${esc(JSON.stringify(me.user || {}, null, 1))}</div>
  <div class="toolbar"><button class="btn ghost" id="th">Переключить тему</button>
  <button class="btn ghost" id="apibtn">Сменить API</button></div>
  <p class="mut">API: <span class="mono">${esc(API())}</span> · Чит стучится на <span class="mono">${esc(API())}/v1/cheat/validate</span></p></div>`;
  document.getElementById("th").onclick = () => setTheme(document.documentElement.dataset.theme === "light" ? "dark" : "light");
  document.getElementById("apibtn").onclick = () => { const v = prompt("API base:", API()); if (v) { window.API_BASE = v; location.reload(); } };
}

function view404(path) {
  app.innerHTML = `<h1>404</h1><p class="mut">Страница <span class="mono">${esc(path)}</span> не найдена.</p>
  <div class="row"><a class="btn" data-link href="/home">На главную</a><a class="btn ghost" data-link href="/keys">К ключам</a></div>`;
}

render();
