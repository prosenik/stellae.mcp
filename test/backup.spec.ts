import { createExecutionContext, env, SELF, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import worker from "../src/index";

const MASTER_KEY = "test-master-key";
const BASE = "https://brain.test";

async function mcpCall(key: string, tool: string, args: Record<string, unknown> = {}) {
  const res = await SELF.fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
      "Authorization": `Bearer ${key}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } }),
  });
  const raw = await res.text();
  const dataLine = raw.split("\n").filter((l) => l.startsWith("data: ")).pop();
  const payload = dataLine ? JSON.parse(dataLine.slice(6)) : JSON.parse(raw);
  return { status: res.status, text: payload.result?.content?.[0]?.text ?? JSON.stringify(payload) };
}

async function createKey(opts: { label: string; workspaces: string[] }) {
  const res = await SELF.fetch(`${BASE}/admin/keys`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${MASTER_KEY}` },
    body: JSON.stringify(opts),
  });
  return res.json<{ id: string; key: string }>();
}

async function seed(id: string, workspace: string, content: string) {
  const now = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO memories (id, type, category, content, source, workspace, created_at, updated_at) VALUES (?, 'project', ?, ?, NULL, ?, ?, ?)"
  )
    .bind(id, `seed-${id}`, content, workspace, now, now)
    .run();
}

let clientKey: string;

beforeAll(async () => {
  await seed("bk-private", "private", "BACKUP-PRIVATE fact");
  await seed("bk-agency", "agency", "BACKUP-AGENCY fact");
  await seed("bk-client", "client:lelo", "BACKUP-CLIENT fact");
  clientKey = (await createKey({ label: "lelo", workspaces: ["client:lelo"] })).key;
});

describe("export_memories tool", () => {
  it("master key exports every workspace as valid JSON", async () => {
    const { text } = await mcpCall(MASTER_KEY, "export_memories");
    const doc = JSON.parse(text);
    expect(doc.count).toBeGreaterThanOrEqual(3);
    const contents = doc.memories.map((m: { content: string }) => m.content);
    expect(contents).toContain("BACKUP-PRIVATE fact");
    expect(contents).toContain("BACKUP-AGENCY fact");
    expect(contents).toContain("BACKUP-CLIENT fact");
  });

  it("scoped key exports only its own workspace", async () => {
    const { text } = await mcpCall(clientKey, "export_memories");
    const doc = JSON.parse(text);
    const contents = doc.memories.map((m: { content: string }) => m.content);
    expect(contents).toContain("BACKUP-CLIENT fact");
    expect(contents).not.toContain("BACKUP-PRIVATE fact");
    expect(contents).not.toContain("BACKUP-AGENCY fact");
  });
});

describe("on-demand backup route", () => {
  it("master key writes a dated backup to R2", async () => {
    const res = await SELF.fetch(`${BASE}/admin/backup`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${MASTER_KEY}` },
    });
    expect(res.status).toBe(201);
    const body = await res.json<{ key: string; memories: number; keys: number }>();
    expect(body.key).toMatch(/^memories\/.+\.json$/);
    expect(body.memories).toBeGreaterThanOrEqual(3);

    const object = await env.BACKUPS.get(body.key);
    expect(object).not.toBeNull();
    const dump = JSON.parse(await object!.text());
    expect(dump.memories.length).toBe(body.memories);
    // api_keys included with hashes but the raw key value never appears.
    expect(JSON.stringify(dump)).not.toContain(clientKey);
    expect(dump.api_keys.length).toBeGreaterThanOrEqual(1);
  });

  it("scoped keys cannot trigger a backup", async () => {
    const res = await SELF.fetch(`${BASE}/admin/backup`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${clientKey}` },
    });
    expect(res.status).toBe(403);
  });

  it("GET is rejected", async () => {
    const res = await SELF.fetch(`${BASE}/admin/backup`, {
      method: "GET",
      headers: { "Authorization": `Bearer ${MASTER_KEY}` },
    });
    expect(res.status).toBe(405);
  });
});

describe("scheduled cron backup", () => {
  it("writes a full dump to R2 when the cron fires", async () => {
    const scheduledTime = Date.parse("2026-07-15T03:00:00.000Z");
    const ctx = createExecutionContext();
    await worker.scheduled({ scheduledTime, cron: "0 3 * * *", noRetry() {} }, env, ctx);
    await waitOnExecutionContext(ctx);

    const object = await env.BACKUPS.get("memories/2026-07-15T03-00-00-000Z.json");
    expect(object).not.toBeNull();
    const dump = JSON.parse(await object!.text());
    expect(dump.backed_up_at).toBe("2026-07-15T03:00:00.000Z");
    expect(dump.memories.length).toBeGreaterThanOrEqual(3);
  });
});
