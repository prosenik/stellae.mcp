import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const MASTER_KEY = "test-master-key";
const BASE = "https://brain.test";

async function mcp(key: string, tool: string, args: Record<string, unknown> = {}) {
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
  return { status: res.status, text: payload.result?.content?.[0]?.text ?? JSON.stringify(payload), payload };
}

/** Store a memory and return its id. */
async function remember(args: Record<string, unknown>): Promise<string> {
  const { text } = await mcp(MASTER_KEY, "remember", args);
  const id = text.match(/ID: ([0-9a-f-]{36})/)?.[1];
  expect(id, `remember returned an id (${text})`).toBeTruthy();
  return id!;
}

describe("new remember fields", () => {
  it("stores tags, importance, review_after, related_ids", async () => {
    const relatedTo = await remember({ type: "project", category: "rel-target", content: "target" });
    const id = await remember({
      type: "project",
      category: "rich-memory",
      content: "a fully-specified memory",
      tags: ["design-system", "urgent"],
      importance: 5,
      review_after: "2026-12-31",
      related_ids: [relatedTo],
    });

    const row = await env.DB.prepare("SELECT * FROM memories WHERE id = ?").bind(id).first<any>();
    expect(row.importance).toBe(5);
    expect(row.status).toBe("active");
    expect(row.review_after).toBe("2026-12-31");
    expect(JSON.parse(row.tags)).toEqual(["design-system", "urgent"]);
    expect(JSON.parse(row.related_ids)).toEqual([relatedTo]);
  });

  it("defaults importance to 3 and leaves optional fields null", async () => {
    const id = await remember({ type: "user", category: "plain", content: "no extras" });
    const row = await env.DB.prepare("SELECT * FROM memories WHERE id = ?").bind(id).first<any>();
    expect(row.importance).toBe(3);
    expect(row.tags).toBeNull();
    expect(row.review_after).toBeNull();
    expect(row.related_ids).toBeNull();
  });

  it("rejects importance out of range", async () => {
    const { text } = await mcp(MASTER_KEY, "remember", {
      type: "user",
      category: "bad-importance",
      content: "x",
      importance: 9,
    });
    // Zod validation error surfaces as an MCP error, not a stored row.
    const row = await env.DB.prepare("SELECT id FROM memories WHERE category = 'bad-importance'").first();
    expect(row).toBeNull();
    expect(text.toLowerCase()).toMatch(/importance|invalid|less than|5/);
  });
});

describe("recall filtering", () => {
  it("filters by min_importance and tags", async () => {
    await remember({ type: "project", category: "hi-imp", content: "FILTERME critical thing", importance: 5, tags: ["billing"] });
    await remember({ type: "project", category: "lo-imp", content: "FILTERME trivial thing", importance: 1, tags: ["misc"] });

    const byImportance = await mcp(MASTER_KEY, "recall", { query: "FILTERME", min_importance: 4 });
    expect(byImportance.text).toContain("critical thing");
    expect(byImportance.text).not.toContain("trivial thing");

    const byTag = await mcp(MASTER_KEY, "recall", { query: "FILTERME", tags: ["billing"] });
    expect(byTag.text).toContain("critical thing");
    expect(byTag.text).not.toContain("trivial thing");
  });
});

describe("archive / restore lifecycle", () => {
  it("archived memories vanish from briefing, recall, and list; restore brings them back", async () => {
    // ZEBRAFACT is a content-only marker so assertions don't collide with the
    // recall query echo ("No memories found for …").
    const id = await remember({ type: "project", category: "ARCHIVEME", content: "ARCHIVE-CANARY ZEBRAFACT temporary fact" });

    // Present while active.
    expect((await mcp(MASTER_KEY, "get_briefing")).text).toContain("ZEBRAFACT");
    expect((await mcp(MASTER_KEY, "recall", { query: "ARCHIVE-CANARY" })).text).toContain("ZEBRAFACT");

    // Archive it.
    const archived = await mcp(MASTER_KEY, "archive_memory", { id });
    expect(archived.text).toContain("archived");

    // Gone from all default surfaces (DoD).
    expect((await mcp(MASTER_KEY, "get_briefing")).text).not.toContain("ZEBRAFACT");
    expect((await mcp(MASTER_KEY, "recall", { query: "ARCHIVE-CANARY" })).text).not.toContain("ZEBRAFACT");
    expect((await mcp(MASTER_KEY, "list_memories")).text).not.toContain(id);

    // But still findable when explicitly asked for.
    expect((await mcp(MASTER_KEY, "recall", { query: "ARCHIVE-CANARY", status: "archived" })).text).toContain("ZEBRAFACT");
    expect((await mcp(MASTER_KEY, "list_memories", { status: "archived" })).text).toContain(id);

    // Not destroyed — the row survives.
    const row = await env.DB.prepare("SELECT status FROM memories WHERE id = ?").bind(id).first<{ status: string }>();
    expect(row?.status).toBe("archived");

    // Restore.
    const restored = await mcp(MASTER_KEY, "restore_memory", { id });
    expect(restored.text).toContain("restored");
    expect((await mcp(MASTER_KEY, "get_briefing")).text).toContain("ZEBRAFACT");
  });

  it("archiving an already-archived memory reports no active memory", async () => {
    const id = await remember({ type: "project", category: "double-archive", content: "x" });
    await mcp(MASTER_KEY, "archive_memory", { id });
    const again = await mcp(MASTER_KEY, "archive_memory", { id });
    expect(again.text).toContain("No active memory");
  });

  it("respects workspace scope — a client key cannot archive an agency memory", async () => {
    const id = await remember({ type: "project", category: "agency-only", content: "y", workspace: "agency" });
    const created = await SELF.fetch(`${BASE}/admin/keys`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${MASTER_KEY}` },
      body: JSON.stringify({ label: "arch-scope", workspaces: ["client:lelo"] }),
    });
    const { key } = await created.json<{ key: string }>();

    const res = await mcp(key, "archive_memory", { id });
    expect(res.text).toContain("No active memory");
    const row = await env.DB.prepare("SELECT status FROM memories WHERE id = ?").bind(id).first<{ status: string }>();
    expect(row?.status).toBe("active");
  });
});
