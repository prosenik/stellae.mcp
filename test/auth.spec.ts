import { env, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

const MASTER_KEY = "test-master-key";
const BASE = "https://brain.test";

// ── helpers ──────────────────────────────────────────────────────────────────

async function login(key: string): Promise<Response> {
  const form = new FormData();
  form.set("key", key);
  return SELF.fetch(`${BASE}/login`, {
    method: "POST",
    body: form,
    redirect: "manual",
  });
}

function setCookies(res: Response): string[] {
  // getSetCookie is available in workerd; fall back to the single header.
  const anyHeaders = res.headers as Headers & { getSetCookie?: () => string[] };
  if (typeof anyHeaders.getSetCookie === "function") return anyHeaders.getSetCookie();
  const single = res.headers.get("set-cookie");
  return single ? [single] : [];
}

function extractSessionToken(res: Response): string | null {
  for (const c of setCookies(res)) {
    const m = c.match(/^brain_session=([^;]+)/);
    if (m && m[1]) return m[1];
  }
  return null;
}

async function dashboard(sessionToken?: string, extraCookie?: string): Promise<Response> {
  const cookies: string[] = [];
  if (sessionToken) cookies.push(`brain_session=${sessionToken}`);
  if (extraCookie) cookies.push(extraCookie);
  return SELF.fetch(`${BASE}/`, {
    headers: cookies.length ? { "Cookie": cookies.join("; ") } : {},
  });
}

async function seedMemory(id: string, workspace: string, content: string): Promise<void> {
  const now = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO memories (id, type, category, content, source, workspace, created_at, updated_at) VALUES (?, 'project', ?, ?, NULL, ?, ?, ?)"
  )
    .bind(id, `seed-${workspace}`, content, workspace, now, now)
    .run();
}

beforeAll(async () => {
  await seedMemory("auth-mem-1", "agency", "AUTH-TEST-CANARY agency fact");
});

// ── DoD: raw API key never authenticates via URL ─────────────────────────────

describe("header-only auth", () => {
  it("rejects ?key= query-param auth (master key)", async () => {
    const res = await SELF.fetch(`${BASE}/mcp?key=${MASTER_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_memories", arguments: {} } }),
    });
    expect(res.status).toBe(401);
  });

  it("still accepts Authorization: Bearer", async () => {
    const res = await SELF.fetch(`${BASE}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        "Authorization": `Bearer ${MASTER_KEY}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_memories", arguments: {} } }),
    });
    expect(res.status).toBe(200);
  });

  it("emits no CORS wildcard headers", async () => {
    const preflight = await SELF.fetch(`${BASE}/mcp`, { method: "OPTIONS" });
    expect(preflight.headers.get("Access-Control-Allow-Origin")).toBeNull();

    const authed = await SELF.fetch(`${BASE}/mcp`, {
      method: "OPTIONS",
      headers: { "Authorization": `Bearer ${MASTER_KEY}` },
    });
    expect(authed.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });
});

// ── DoD: raw key never appears in a cookie ───────────────────────────────────

describe("dashboard sessions", () => {
  it("login issues a random session token — cookie never contains the key", async () => {
    const res = await login(MASTER_KEY);
    expect(res.status).toBe(302);

    const token = extractSessionToken(res);
    expect(token).toBeTruthy();
    expect(token).toMatch(/^sess_/);
    expect(token).not.toContain(MASTER_KEY);

    // Only the hash is stored server-side.
    const row = await env.DB.prepare("SELECT token_hash FROM sessions LIMIT 1").first<{ token_hash: string }>();
    expect(row?.token_hash).not.toBe(token);

    // And the session works.
    const dash = await dashboard(token!);
    expect(dash.status).toBe(200);
    expect(await dash.text()).toContain("AUTH-TEST-CANARY");
  });

  it("legacy brain_key cookie (raw key) no longer grants access", async () => {
    const res = await dashboard(undefined, `brain_key=${MASTER_KEY}`);
    const html = await res.text();
    expect(html).toContain("Enter your API key"); // login page
    expect(html).not.toContain("AUTH-TEST-CANARY");
  });

  it("login response actively expires the legacy cookie", async () => {
    const res = await login(MASTER_KEY);
    const legacy = setCookies(res).find((c) => c.startsWith("brain_key="));
    expect(legacy).toBeTruthy();
    expect(legacy).toContain("Max-Age=0");
  });

  it("bad key does not create a session", async () => {
    const res = await login("brain_wrong-key");
    expect(res.status).toBe(200);
    expect(extractSessionToken(res)).toBeNull();
    expect(await res.text()).toContain("Invalid key");
  });

  it("logout destroys the session server-side", async () => {
    const token = extractSessionToken(await login(MASTER_KEY))!;
    expect((await dashboard(token)).status).toBe(200);
    expect(await (await dashboard(token)).text()).toContain("AUTH-TEST-CANARY");

    await SELF.fetch(`${BASE}/logout`, {
      headers: { "Cookie": `brain_session=${token}` },
      redirect: "manual",
    });

    const after = await dashboard(token);
    expect(await after.text()).not.toContain("AUTH-TEST-CANARY");
  });

  it("a forged session token is rejected", async () => {
    const res = await dashboard("sess_forged-token-that-was-never-issued");
    expect(await res.text()).not.toContain("AUTH-TEST-CANARY");
  });

  it("revoking a scoped key kills its dashboard sessions", async () => {
    // Create a scoped key, log in with it, then revoke it.
    const created = await SELF.fetch(`${BASE}/admin/keys`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${MASTER_KEY}` },
      body: JSON.stringify({ label: "session-revoke-test", workspaces: ["agency"] }),
    });
    const { id, key } = await created.json<{ id: string; key: string }>();

    const token = extractSessionToken(await login(key))!;
    expect(await (await dashboard(token)).text()).toContain("AUTH-TEST-CANARY");

    await SELF.fetch(`${BASE}/admin/keys/${id}`, {
      method: "DELETE",
      headers: { "Authorization": `Bearer ${MASTER_KEY}` },
    });

    const after = await dashboard(token);
    expect(await after.text()).not.toContain("AUTH-TEST-CANARY");
  });
});

// ── DoD: brute-force on /login is rate-limited ───────────────────────────────

describe("login rate limiting", () => {
  it.skipIf(!("LOGIN_RATE_LIMITER" in env))(
    "blocks after 5 attempts per minute per IP",
    async () => {
      const attempt = () =>
        SELF.fetch(`${BASE}/login`, {
          method: "POST",
          body: (() => {
            const f = new FormData();
            f.set("key", "brain_bruteforce-attempt");
            return f;
          })(),
          headers: { "CF-Connecting-IP": "203.0.113.7" },
          redirect: "manual",
        });

      const statuses: number[] = [];
      for (let i = 0; i < 7; i++) {
        statuses.push((await attempt()).status);
      }

      // First attempts pass through (as failed logins), later ones are 429.
      expect(statuses[0]).toBe(200);
      expect(statuses.at(-1)).toBe(429);
    }
  );
});
