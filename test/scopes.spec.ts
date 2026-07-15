import { env, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

const MASTER_KEY = "test-master-key";
const BASE = "https://brain.test";

// ── helpers ──────────────────────────────────────────────────────────────────

/** Call an MCP tool over the Streamable HTTP transport and return the text result. */
async function mcpCall(
  key: string,
  tool: string,
  args: Record<string, unknown> = {}
): Promise<{ status: number; text: string }> {
  const res = await SELF.fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
      "Authorization": `Bearer ${key}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: tool, arguments: args },
    }),
  });

  if (res.status !== 200) return { status: res.status, text: await res.text() };

  const contentType = res.headers.get("content-type") ?? "";
  let payload: any;
  if (contentType.includes("text/event-stream")) {
    const raw = await res.text();
    const dataLine = raw
      .split("\n")
      .filter((l) => l.startsWith("data: "))
      .pop();
    payload = JSON.parse(dataLine!.slice(6));
  } else {
    payload = await res.json();
  }

  const text: string = payload.result?.content?.[0]?.text ?? JSON.stringify(payload);
  return { status: res.status, text };
}

async function createKey(opts: {
  label: string;
  workspaces: string[];
  can_write?: boolean;
}): Promise<{ id: string; key: string }> {
  const res = await SELF.fetch(`${BASE}/admin/keys`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${MASTER_KEY}`,
    },
    body: JSON.stringify(opts),
  });
  expect(res.status).toBe(201);
  return res.json();
}

async function seedMemory(id: string, workspace: string, content: string): Promise<void> {
  const now = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO memories (id, type, category, content, source, workspace, created_at, updated_at) VALUES (?, 'project', ?, ?, NULL, ?, ?, ?)"
  )
    .bind(id, `seed-${workspace}`, content, workspace, now, now)
    .run();
}

// ── fixtures ─────────────────────────────────────────────────────────────────

const PRIVATE_ID = "mem-private-1";
const AGENCY_ID = "mem-agency-1";
const CLIENT_ID = "mem-client-1";

const PRIVATE_CONTENT = "PRIVATE-SECRET niko personal fact shared-term";
const AGENCY_CONTENT = "AGENCY-INTERNAL studio pipeline fact shared-term";
const CLIENT_CONTENT = "CLIENT-LELO portal onboarding fact shared-term";

let clientKey: string;
let readOnlyKey: string;
let revokedKey: { id: string; key: string };

beforeAll(async () => {
  await seedMemory(PRIVATE_ID, "private", PRIVATE_CONTENT);
  await seedMemory(AGENCY_ID, "agency", AGENCY_CONTENT);
  await seedMemory(CLIENT_ID, "client:lelo", CLIENT_CONTENT);

  clientKey = (await createKey({ label: "lelo-agent", workspaces: ["client:lelo"] })).key;
  readOnlyKey = (
    await createKey({ label: "lelo-readonly", workspaces: ["client:lelo"], can_write: false })
  ).key;
  revokedKey = await createKey({ label: "to-revoke", workspaces: ["agency"] });
});

// ── auth basics ──────────────────────────────────────────────────────────────

describe("auth", () => {
  it("rejects requests without a key", async () => {
    const res = await SELF.fetch(`${BASE}/mcp`, { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("rejects unknown keys", async () => {
    const { status } = await mcpCall("brain_not-a-real-key", "list_memories");
    expect(status).toBe(401);
  });

  it("master API_KEY still works and sees everything (migration compatibility)", async () => {
    const { status, text } = await mcpCall(MASTER_KEY, "get_briefing");
    expect(status).toBe(200);
    expect(text).toContain("PRIVATE-SECRET");
    expect(text).toContain("AGENCY-INTERNAL");
    expect(text).toContain("CLIENT-LELO");
  });

  it("rejects revoked keys", async () => {
    // Works before revocation…
    const before = await mcpCall(revokedKey.key, "list_memories");
    expect(before.status).toBe(200);

    // …revoke…
    const res = await SELF.fetch(`${BASE}/admin/keys/${revokedKey.id}`, {
      method: "DELETE",
      headers: { "Authorization": `Bearer ${MASTER_KEY}` },
    });
    expect(res.status).toBe(200);

    // …dead after.
    const after = await mcpCall(revokedKey.key, "list_memories");
    expect(after.status).toBe(401);
  });

  it("scoped keys cannot manage keys", async () => {
    const res = await SELF.fetch(`${BASE}/admin/keys`, {
      method: "GET",
      headers: { "Authorization": `Bearer ${clientKey}` },
    });
    expect(res.status).toBe(403);
  });
});

// ── the Task 1 definition of done ────────────────────────────────────────────
// "A key scoped to client:x can never read private or agency memories."

describe("workspace read isolation (client:lelo key)", () => {
  it("get_briefing exposes only client:lelo memories", async () => {
    const { text } = await mcpCall(clientKey, "get_briefing");
    expect(text).toContain("CLIENT-LELO");
    expect(text).not.toContain("PRIVATE-SECRET");
    expect(text).not.toContain("AGENCY-INTERNAL");
  });

  it("recall never returns private/agency matches, even for a matching query", async () => {
    // "shared-term" appears in all three memories.
    const { text } = await mcpCall(clientKey, "recall", { query: "shared-term" });
    expect(text).toContain("CLIENT-LELO");
    expect(text).not.toContain("PRIVATE-SECRET");
    expect(text).not.toContain("AGENCY-INTERNAL");
  });

  it("recall cannot be widened via the workspace parameter", async () => {
    const { text } = await mcpCall(clientKey, "recall", {
      query: "shared-term",
      workspace: "private",
    });
    expect(text).toContain("no access");
    expect(text).not.toContain("PRIVATE-SECRET");
  });

  it("list_memories lists only client:lelo IDs", async () => {
    const { text } = await mcpCall(clientKey, "list_memories");
    expect(text).toContain(CLIENT_ID);
    expect(text).not.toContain(PRIVATE_ID);
    expect(text).not.toContain(AGENCY_ID);
  });
});

describe("workspace write isolation (client:lelo key)", () => {
  it("cannot update a private memory even with a known ID", async () => {
    const { text } = await mcpCall(clientKey, "update_memory", {
      id: PRIVATE_ID,
      content: "OVERWRITTEN",
    });
    expect(text).toContain("No memory found");

    const row = await env.DB.prepare("SELECT content FROM memories WHERE id = ?")
      .bind(PRIVATE_ID)
      .first<{ content: string }>();
    expect(row?.content).toBe(PRIVATE_CONTENT);
  });

  it("cannot delete an agency memory even with a known ID", async () => {
    const { text } = await mcpCall(clientKey, "delete_memory", { id: AGENCY_ID });
    expect(text).toContain("No memory found");

    const row = await env.DB.prepare("SELECT id FROM memories WHERE id = ?")
      .bind(AGENCY_ID)
      .first();
    expect(row).not.toBeNull();
  });

  it("cannot remember into a workspace outside its scope", async () => {
    const { text } = await mcpCall(clientKey, "remember", {
      type: "project",
      category: "escape-attempt",
      content: "should never land in private",
      workspace: "private",
    });
    expect(text).toContain("no access");

    const row = await env.DB.prepare("SELECT id FROM memories WHERE category = 'escape-attempt'").first();
    expect(row).toBeNull();
  });

  it("remember defaults to the key's own workspace", async () => {
    const { text } = await mcpCall(clientKey, "remember", {
      type: "project",
      category: "lelo-note",
      content: "a legitimate client memory",
    });
    expect(text).toContain("Workspace: client:lelo");

    const row = await env.DB.prepare("SELECT workspace FROM memories WHERE category = 'lelo-note'")
      .first<{ workspace: string }>();
    expect(row?.workspace).toBe("client:lelo");
  });

  it("read-only keys cannot write at all", async () => {
    const { text } = await mcpCall(readOnlyKey, "remember", {
      type: "project",
      category: "readonly-attempt",
      content: "should be rejected",
    });
    expect(text).toContain("read-only");

    const del = await mcpCall(readOnlyKey, "delete_memory", { id: CLIENT_ID });
    expect(del.text).toContain("read-only");
  });
});

describe("admin key management", () => {
  it("validates workspace names on key creation", async () => {
    const res = await SELF.fetch(`${BASE}/admin/keys`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${MASTER_KEY}` },
      body: JSON.stringify({ label: "bad", workspaces: ["client:INVALID SLUG!"] }),
    });
    expect(res.status).toBe(400);
  });

  it("lists keys without exposing hashes or raw keys", async () => {
    const res = await SELF.fetch(`${BASE}/admin/keys`, {
      method: "GET",
      headers: { "Authorization": `Bearer ${MASTER_KEY}` },
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).not.toContain("key_hash");
    expect(body).not.toContain(clientKey);
  });
});
