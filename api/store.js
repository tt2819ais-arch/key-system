// store.js — Deno KV персистентность.
// На Deno Deploy база ЖИВЁТ из коробки: ничего создавать/привязывать не надо.
// Плоские строковые ключи ("key:<id>") маппятся на KV-кортежи ["key","<id>"].
let _kv = null;
async function kv() {
  if (!_kv) _kv = await Deno.openKv();
  return _kv;
}
const parts = (k) => String(k).split(":");

export const store = {
  async get(env, k) {
    const r = await (await kv()).get(parts(k));
    return r.value ?? null;
  },
  async put(env, k, v, opts = {}) {
    const db = await kv();
    if (opts.expireInMs) await db.set(parts(k), v, { expireIn: opts.expireInMs });
    else await db.set(parts(k), v);
  },
  async del(env, k) {
    await (await kv()).delete(parts(k));
  },
  async list(env, prefix) {
    const p = parts(String(prefix).replace(/:$/, ""));
    const out = [];
    for await (const e of (await kv()).list({ prefix: p })) {
      out.push({ name: e.key.join(":"), value: e.value });
    }
    return out;
  },

  async ensureSeed(env) {
    const adminEmail = (env.ADMIN_EMAIL || "admin@cheat.com").toLowerCase();
    const adminPw = env.ADMIN_PASSWORD || "123098";
    const existing = await this.get(env, `users:${adminEmail}`);
    if (!existing) {
      const { hashPassword } = await import("./crypto.js");
      await this.put(env, `users:${adminEmail}`, {
        email: adminEmail,
        pass: await hashPassword(adminPw),
        role: "admin",
        permissions: ["*"],
        active: true,
        createdAt: new Date().toISOString(),
      });
    }
  },

  userKey: (email) => `users:${String(email).toLowerCase()}`,
  async getUser(env, email) {
    return this.get(env, this.userKey(email));
  },
  async putUser(env, u) {
    return this.put(env, this.userKey(u.email), u);
  },
  async listUsers(env) {
    const all = await this.list(env, "users:");
    return all.map((x) => {
      const { pass, ...safe } = x.value || {};
      return safe;
    });
  },
};
