import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";

interface Env {
  DB: D1Database;
  API_KEY: string;
}

interface Memory {
  id: string;
  type: string;
  category: string;
  content: string;
  source: string | null;
  workspace: string;
  created_at: string;
  updated_at: string;
}

interface ApiKeyRow {
  id: string;
  key_hash: string;
  label: string;
  workspaces: string;
  can_write: number;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

// The identity behind a request, resolved from its API key.
interface Caller {
  label: string;
  workspaces: string[]; // ["*"] = every workspace
  canWrite: boolean;
  isAdmin: boolean; // true only for the master API_KEY — unlocks /admin/keys
}

const WORKSPACE_RE = /^(private|agency|client:[a-z0-9][a-z0-9-]*)$/;

// ── Auth helpers ──────────────────────────────────────────────────────────────

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function generateApiKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const b64 = btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `brain_${b64}`;
}

async function resolveCaller(token: string, env: Env, ctx: ExecutionContext): Promise<Caller | null> {
  // Master key keeps working during the migration to scoped keys (Task 1 DoD).
  if (token === env.API_KEY) {
    return { label: "master", workspaces: ["*"], canWrite: true, isAdmin: true };
  }

  const hash = await sha256Hex(token);
  const row = await env.DB.prepare(
    "SELECT * FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL"
  )
    .bind(hash)
    .first<ApiKeyRow>();
  if (!row) return null;

  ctx.waitUntil(
    env.DB.prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?")
      .bind(new Date().toISOString(), row.id)
      .run()
  );

  let workspaces: string[];
  try {
    workspaces = JSON.parse(row.workspaces);
  } catch {
    return null; // corrupt row — fail closed
  }
  if (!Array.isArray(workspaces) || workspaces.length === 0) return null;

  return { label: row.label, workspaces, canWrite: row.can_write === 1, isAdmin: false };
}

// SQL fragment restricting a query to the caller's readable workspaces.
function scopeFilter(caller: Caller): { clause: string; params: string[] } {
  if (caller.workspaces.includes("*")) return { clause: "1=1", params: [] };
  const placeholders = caller.workspaces.map(() => "?").join(", ");
  return { clause: `workspace IN (${placeholders})`, params: caller.workspaces };
}

function canAccessWorkspace(caller: Caller, workspace: string): boolean {
  return caller.workspaces.includes("*") || caller.workspaces.includes(workspace);
}

// Workspace used by `remember` when none is given.
function defaultWorkspace(caller: Caller): string | null {
  if (caller.workspaces.includes("*")) return "agency";
  if (caller.workspaces.length === 1) return caller.workspaces[0];
  if (caller.workspaces.includes("agency")) return "agency";
  return null; // ambiguous — the caller must specify
}

// ── MCP server ────────────────────────────────────────────────────────────────

function buildServer(env: Env, caller: Caller): McpServer {
  const server = new McpServer({
    name: "mcp.stellae.studio",
    version: "1.1.0",
  });

  const scope = scopeFilter(caller);
  const typeLabels: Record<string, string> = {
    user: "👤 USER & PREFERENCES",
    project: "🚀 PROJECTS & PIPELINE",
    feedback: "💬 FEEDBACK & BEHAVIOR",
    reference: "🔗 REFERENCES",
  };

  function renderTypeGroups(memories: Memory[]): string {
    const grouped = memories.reduce((acc, m) => {
      if (!acc[m.type]) acc[m.type] = [];
      acc[m.type].push(m);
      return acc;
    }, {} as Record<string, Memory[]>);

    let out = "";
    for (const type of ["user", "project", "feedback", "reference"]) {
      const items = grouped[type];
      if (!items?.length) continue;
      out += `## ${typeLabels[type] ?? type.toUpperCase()}\n\n`;
      for (const m of items) {
        out += `### ${m.category}\n${m.content}\n`;
        if (m.source) out += `_Source: ${m.source}_\n`;
        out += `_ID: ${m.id} · Updated: ${m.updated_at}_\n\n`;
      }
    }
    return out;
  }

  // ── get_briefing ─────────────────────────────────────────────────────────
  server.tool(
    "get_briefing",
    "Get a full structured briefing about Stellae Studio — projects, agent pipeline, preferences, and key context. Scoped to the workspaces your key can read. Call this at the start of every session.",
    {},
    async () => {
      const { results } = await env.DB.prepare(
        `SELECT * FROM memories WHERE ${scope.clause} ORDER BY workspace, type, category, updated_at DESC`
      )
        .bind(...scope.params)
        .all<Memory>();

      if (results.length === 0) {
        return {
          content: [{ type: "text" as const, text: "No memories stored yet. Use `remember` to start building context." }],
        };
      }

      let briefing = `# Stellae Studio — Brain Briefing\n_${new Date().toISOString()}_\n\n`;

      const workspaces = [...new Set(results.map((m) => m.workspace))];
      if (workspaces.length > 1) {
        // Multi-workspace keys get their briefing sectioned per workspace.
        for (const ws of workspaces) {
          briefing += `# 🗂 Workspace: ${ws}\n\n`;
          briefing += renderTypeGroups(results.filter((m) => m.workspace === ws));
        }
      } else {
        briefing += renderTypeGroups(results);
      }

      return { content: [{ type: "text" as const, text: briefing }] };
    }
  );

  // ── remember ─────────────────────────────────────────────────────────────
  server.tool(
    "remember",
    "Store a new memory about Stellae Studio — a project update, preference, piece of feedback, or external reference.",
    {
      type: z
        .enum(["user", "project", "feedback", "reference"])
        .describe("user = who Niko is / preferences; project = ongoing work; feedback = how to behave; reference = where to find things"),
      category: z
        .string()
        .describe("Short label, e.g. 'Arc agent', 'Morning digest', 'stellae.tokens'"),
      content: z
        .string()
        .describe("The memory content. Be specific and complete."),
      source: z
        .string()
        .optional()
        .describe("Origin of this memory: 'Slack', 'Notion', 'conversation', etc."),
      workspace: z
        .string()
        .regex(WORKSPACE_RE, "Must be 'private', 'agency', or 'client:<slug>'")
        .optional()
        .describe("Workspace this memory belongs to: 'private' | 'agency' | 'client:<slug>'. Defaults to your key's workspace."),
    },
    async ({ type, category, content, source, workspace }) => {
      if (!caller.canWrite) {
        return { content: [{ type: "text" as const, text: "✗ This API key is read-only." }] };
      }

      const target = workspace ?? defaultWorkspace(caller);
      if (!target) {
        return {
          content: [{ type: "text" as const, text: `✗ Ambiguous workspace — your key can write to several (${caller.workspaces.join(", ")}). Pass \`workspace\` explicitly.` }],
        };
      }
      if (!canAccessWorkspace(caller, target)) {
        return {
          content: [{ type: "text" as const, text: `✗ This API key has no access to workspace '${target}'.` }],
        };
      }

      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      await env.DB.prepare(
        "INSERT INTO memories (id, type, category, content, source, workspace, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      )
        .bind(id, type, category, content, source ?? null, target, now, now)
        .run();

      return {
        content: [{ type: "text" as const, text: `✓ Memory stored.\nID: ${id}\nType: ${type} / ${category}\nWorkspace: ${target}` }],
      };
    }
  );

  // ── recall ────────────────────────────────────────────────────────────────
  server.tool(
    "recall",
    "Search memories by keyword, category, or type. Only searches workspaces your key can read.",
    {
      query: z.string().describe("Search term — matches against content and category"),
      type: z
        .enum(["user", "project", "feedback", "reference"])
        .optional()
        .describe("Filter by memory type"),
      workspace: z
        .string()
        .regex(WORKSPACE_RE, "Must be 'private', 'agency', or 'client:<slug>'")
        .optional()
        .describe("Narrow the search to a single workspace"),
    },
    async ({ query, type, workspace }) => {
      if (workspace && !canAccessWorkspace(caller, workspace)) {
        return {
          content: [{ type: "text" as const, text: `✗ This API key has no access to workspace '${workspace}'.` }],
        };
      }

      let sql = `SELECT * FROM memories WHERE ${scope.clause} AND (content LIKE ? OR category LIKE ?)`;
      const params: string[] = [...scope.params, `%${query}%`, `%${query}%`];

      if (type) {
        sql += " AND type = ?";
        params.push(type);
      }
      if (workspace) {
        sql += " AND workspace = ?";
        params.push(workspace);
      }
      sql += " ORDER BY updated_at DESC LIMIT 20";

      const { results } = await env.DB.prepare(sql).bind(...params).all<Memory>();

      if (results.length === 0) {
        return {
          content: [{ type: "text" as const, text: `No memories found for "${query}"${type ? ` (type: ${type})` : ""}.` }],
        };
      }

      const text = results
        .map((m) => `[${m.id}]\n**${m.type} / ${m.category}** · _${m.workspace}_\n${m.content}${m.source ? `\n_Source: ${m.source}_` : ""}`)
        .join("\n\n---\n\n");

      return { content: [{ type: "text" as const, text: `Found ${results.length} result(s):\n\n${text}` }] };
    }
  );

  // ── update_memory ─────────────────────────────────────────────────────────
  server.tool(
    "update_memory",
    "Update the content of an existing memory by ID.",
    {
      id: z.string().describe("Memory ID (from get_briefing or recall)"),
      content: z.string().describe("New content to replace the existing memory"),
    },
    async ({ id, content }) => {
      if (!caller.canWrite) {
        return { content: [{ type: "text" as const, text: "✗ This API key is read-only." }] };
      }

      const now = new Date().toISOString();
      // Scope filter in the WHERE clause — a key must never touch memories
      // outside its workspaces, even with a known ID.
      const result = await env.DB.prepare(
        `UPDATE memories SET content = ?, updated_at = ? WHERE id = ? AND ${scope.clause}`
      )
        .bind(content, now, id, ...scope.params)
        .run();

      if (result.meta.changes === 0) {
        return { content: [{ type: "text" as const, text: `No memory found with ID: ${id}` }] };
      }
      return { content: [{ type: "text" as const, text: `✓ Memory updated.` }] };
    }
  );

  // ── delete_memory ─────────────────────────────────────────────────────────
  server.tool(
    "delete_memory",
    "Delete a memory by ID.",
    {
      id: z.string().describe("Memory ID to delete"),
    },
    async ({ id }) => {
      if (!caller.canWrite) {
        return { content: [{ type: "text" as const, text: "✗ This API key is read-only." }] };
      }

      const result = await env.DB.prepare(
        `DELETE FROM memories WHERE id = ? AND ${scope.clause}`
      )
        .bind(id, ...scope.params)
        .run();

      if (result.meta.changes === 0) {
        return { content: [{ type: "text" as const, text: `No memory found with ID: ${id}` }] };
      }
      return { content: [{ type: "text" as const, text: `✓ Memory deleted.` }] };
    }
  );

  // ── list_memories ─────────────────────────────────────────────────────────
  server.tool(
    "list_memories",
    "List all stored memories with IDs, types, workspaces, and categories (no full content). Use to get an overview or find IDs.",
    {
      type: z
        .enum(["user", "project", "feedback", "reference"])
        .optional()
        .describe("Filter by type"),
      workspace: z
        .string()
        .regex(WORKSPACE_RE, "Must be 'private', 'agency', or 'client:<slug>'")
        .optional()
        .describe("Filter by workspace"),
    },
    async ({ type, workspace }) => {
      if (workspace && !canAccessWorkspace(caller, workspace)) {
        return {
          content: [{ type: "text" as const, text: `✗ This API key has no access to workspace '${workspace}'.` }],
        };
      }

      let sql = `SELECT id, type, category, workspace, updated_at FROM memories WHERE ${scope.clause}`;
      const params: string[] = [...scope.params];
      if (type) {
        sql += " AND type = ?";
        params.push(type);
      }
      if (workspace) {
        sql += " AND workspace = ?";
        params.push(workspace);
      }
      sql += " ORDER BY workspace, type, category";

      const { results } = await env.DB.prepare(sql)
        .bind(...params)
        .all<Pick<Memory, "id" | "type" | "category" | "workspace" | "updated_at">>();

      if (results.length === 0) {
        return { content: [{ type: "text" as const, text: "No memories stored yet." }] };
      }

      const text = results
        .map((m) => `[${m.id}] ${m.workspace} · ${m.type} / ${m.category} · ${m.updated_at}`)
        .join("\n");

      return { content: [{ type: "text" as const, text: `${results.length} memories:\n\n${text}` }] };
    }
  );

  return server;
}

// ── Admin: API key management (master key only) ──────────────────────────────

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function handleAdminKeys(request: Request, env: Env, url: URL): Promise<Response> {
  const idMatch = url.pathname.match(/^\/admin\/keys\/([^/]+)$/);

  // POST /admin/keys — create a scoped key. Returns the plaintext key ONCE.
  if (url.pathname === "/admin/keys" && request.method === "POST") {
    let body: { label?: unknown; workspaces?: unknown; can_write?: unknown };
    try {
      body = await request.json();
    } catch {
      return json({ error: "Invalid JSON body" }, 400);
    }

    const label = typeof body.label === "string" ? body.label.trim() : "";
    if (!label) return json({ error: "'label' is required" }, 400);

    const workspaces = body.workspaces;
    if (!Array.isArray(workspaces) || workspaces.length === 0) {
      return json({ error: "'workspaces' must be a non-empty array, e.g. [\"agency\"] or [\"client:lelo\"] or [\"*\"]" }, 400);
    }
    for (const ws of workspaces) {
      if (typeof ws !== "string" || (ws !== "*" && !WORKSPACE_RE.test(ws))) {
        return json({ error: `Invalid workspace '${ws}' — must be 'private', 'agency', 'client:<slug>', or '*'` }, 400);
      }
    }

    const canWrite = body.can_write === undefined ? true : body.can_write === true;

    const rawKey = generateApiKey();
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await env.DB.prepare(
      "INSERT INTO api_keys (id, key_hash, label, workspaces, can_write, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    )
      .bind(id, await sha256Hex(rawKey), label, JSON.stringify(workspaces), canWrite ? 1 : 0, now)
      .run();

    return json({
      id,
      key: rawKey, // shown once — only the hash is stored
      label,
      workspaces,
      can_write: canWrite,
      created_at: now,
    }, 201);
  }

  // GET /admin/keys — list keys (never the hashes).
  if (url.pathname === "/admin/keys" && request.method === "GET") {
    const { results } = await env.DB.prepare(
      "SELECT id, label, workspaces, can_write, created_at, last_used_at, revoked_at FROM api_keys ORDER BY created_at DESC"
    ).all<Omit<ApiKeyRow, "key_hash">>();
    return json({
      keys: results.map((k) => ({ ...k, workspaces: JSON.parse(k.workspaces), can_write: k.can_write === 1 })),
    });
  }

  // DELETE /admin/keys/:id — revoke (soft, keeps the audit trail).
  if (idMatch && request.method === "DELETE") {
    const result = await env.DB.prepare(
      "UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL"
    )
      .bind(new Date().toISOString(), idMatch[1])
      .run();
    if (result.meta.changes === 0) {
      return json({ error: "No active key with that ID" }, 404);
    }
    return json({ revoked: idMatch[1] });
  }

  return json({ error: "Method not allowed" }, 405);
}

// ── Dashboard HTML ────────────────────────────────────────────────────────────
function loginPage(error = false): Response {
  return new Response(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>mcp.stellae.studio</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: #0a0a0a; color: #e0e0e0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
    .card { background: #111; border: 1px solid #222; border-radius: 12px; padding: 40px; width: 100%; max-width: 380px; }
    h1 { font-size: 18px; font-weight: 600; margin-bottom: 6px; color: #fff; }
    p { font-size: 13px; color: #666; margin-bottom: 28px; }
    input { width: 100%; background: #0a0a0a; border: 1px solid #333; border-radius: 8px; padding: 10px 14px; color: #e0e0e0; font-size: 14px; outline: none; margin-bottom: 12px; }
    input:focus { border-color: #555; }
    button { width: 100%; background: #fff; color: #000; border: none; border-radius: 8px; padding: 10px; font-size: 14px; font-weight: 600; cursor: pointer; }
    button:hover { background: #e0e0e0; }
    .error { color: #f87171; font-size: 13px; margin-bottom: 12px; }
  </style>
</head>
<body>
  <div class="card">
    <h1>mcp.stellae.studio</h1>
    <p>Enter your API key to access memories.</p>
    ${error ? '<p class="error">Invalid key. Try again.</p>' : ''}
    <form method="POST" action="/login">
      <input type="password" name="key" placeholder="API key" autofocus autocomplete="current-password" />
      <button type="submit">Access Brain</button>
    </form>
  </div>
</body>
</html>`, { headers: { "Content-Type": "text/html" } });
}

function dashboardPage(memories: Memory[], caller: Caller): Response {
  const typeLabels: Record<string, string> = {
    user: "👤 User & Preferences",
    project: "🚀 Projects & Pipeline",
    feedback: "💬 Feedback & Behavior",
    reference: "🔗 References",
  };

  const grouped = memories.reduce((acc, m) => {
    if (!acc[m.type]) acc[m.type] = [];
    acc[m.type].push(m);
    return acc;
  }, {} as Record<string, Memory[]>);

  const sections = ["user", "project", "feedback", "reference"].map(type => {
    const items = grouped[type] ?? [];
    if (!items.length) return "";
    const cards = items.map(m => `
      <div class="card">
        <div class="card-header">
          <span class="category">${m.category}</span>
          <span class="date">${m.updated_at.slice(0, 10)}</span>
        </div>
        <div class="content">${m.content.replace(/</g, "&lt;")}</div>
        ${m.source ? `<div class="source">Source: ${m.source}</div>` : ""}
        <div class="meta"><span class="workspace">${m.workspace}</span><span class="id">${m.id}</span></div>
      </div>`).join("");
    return `<section><h2>${typeLabels[type]}</h2>${cards}</section>`;
  }).join("");

  const scopeLabel = caller.workspaces.includes("*") ? "all workspaces" : caller.workspaces.join(", ");

  return new Response(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>mcp.stellae.studio</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: #0a0a0a; color: #e0e0e0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; padding: 40px 24px; }
    header { display: flex; align-items: center; justify-content: space-between; max-width: 760px; margin: 0 auto 36px; }
    header h1 { font-size: 16px; font-weight: 600; color: #fff; }
    header .scope { font-size: 12px; color: #555; }
    .search-bar { max-width: 760px; margin: 0 auto 32px; }
    .search-bar input { width: 100%; background: #111; border: 1px solid #222; border-radius: 8px; padding: 10px 14px; color: #e0e0e0; font-size: 14px; outline: none; }
    .search-bar input:focus { border-color: #444; }
    section { max-width: 760px; margin: 0 auto 36px; }
    h2 { font-size: 12px; font-weight: 600; color: #555; text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 12px; }
    .card { background: #111; border: 1px solid #1e1e1e; border-radius: 10px; padding: 16px; margin-bottom: 10px; }
    .card-header { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 8px; }
    .category { font-size: 14px; font-weight: 600; color: #fff; }
    .date { font-size: 11px; color: #444; }
    .content { font-size: 13px; color: #aaa; line-height: 1.6; white-space: pre-wrap; }
    .source { font-size: 11px; color: #555; margin-top: 8px; }
    .meta { display: flex; justify-content: space-between; margin-top: 8px; }
    .workspace { font-size: 10px; color: #4a7a4a; font-family: monospace; background: #0f1a0f; border: 1px solid #1e2e1e; border-radius: 4px; padding: 1px 6px; }
    .id { font-size: 10px; color: #333; font-family: monospace; }
    .empty { color: #444; font-size: 14px; text-align: center; padding: 60px 0; }
    .logout { font-size: 12px; color: #555; text-decoration: none; margin-left: 12px; }
    .logout:hover { color: #888; }
  </style>
  <script>
    document.addEventListener('DOMContentLoaded', () => {
      const input = document.querySelector('.search-bar input');
      input.addEventListener('input', () => {
        const q = input.value.toLowerCase();
        document.querySelectorAll('.card').forEach(card => {
          card.style.display = card.textContent.toLowerCase().includes(q) ? '' : 'none';
        });
      });
    });
  </script>
</head>
<body>
  <header>
    <h1>mcp.stellae.studio</h1>
    <div><span class="scope">${scopeLabel}</span><a href="/logout" class="logout">Sign out</a></div>
  </header>
  <div class="search-bar"><input type="search" placeholder="Search memories…" /></div>
  ${memories.length === 0 ? '<p class="empty">No memories yet.</p>' : sections}
</body>
</html>`, { headers: { "Content-Type": "text/html" } });
}

// ── Main fetch handler ────────────────────────────────────────────────────────
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // ── Dashboard routes (cookie-auth) ────────────────────────────────────
    const cookie = request.headers.get("Cookie") ?? "";
    const sessionKey = cookie.match(/brain_key=([^;]+)/)?.[1];

    if (url.pathname === "/login") {
      if (request.method === "POST") {
        const body = await request.formData();
        const key = body.get("key")?.toString() ?? "";
        const caller = key ? await resolveCaller(key, env, ctx) : null;
        if (caller) {
          return new Response(null, {
            status: 302,
            headers: {
              "Location": "/",
              "Set-Cookie": `brain_key=${encodeURIComponent(key)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=2592000`,
            },
          });
        }
        return loginPage(true);
      }
      return loginPage();
    }

    if (url.pathname === "/logout") {
      return new Response(null, {
        status: 302,
        headers: {
          "Location": "/",
          "Set-Cookie": "brain_key=; Path=/; Max-Age=0",
        },
      });
    }

    if (url.pathname === "/" || url.pathname === "/dashboard") {
      const caller = sessionKey ? await resolveCaller(decodeURIComponent(sessionKey), env, ctx) : null;
      if (!caller) return loginPage();
      const scope = scopeFilter(caller);
      const { results } = await env.DB.prepare(
        `SELECT * FROM memories WHERE ${scope.clause} ORDER BY type, category, updated_at DESC`
      )
        .bind(...scope.params)
        .all<Memory>();
      return dashboardPage(results, caller);
    }

    // ── MCP & API routes (bearer/query-param auth) ────────────────────────
    const authHeader = request.headers.get("Authorization");
    const headerToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
    const queryToken = url.searchParams.get("key");
    const token = headerToken ?? queryToken;
    const caller = token ? await resolveCaller(token, env, ctx) : null;
    if (!caller) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Accept, Mcp-Session-Id",
        },
      });
    }

    // ── Admin: key management — master key only ───────────────────────────
    if (url.pathname === "/admin/keys" || url.pathname.startsWith("/admin/keys/")) {
      if (!caller.isAdmin) {
        return json({ error: "Forbidden — key management requires the master key" }, 403);
      }
      return handleAdminKeys(request, env, url);
    }

    // MCP endpoint
    if (url.pathname !== "/mcp") {
      return new Response("Not found", { status: 404 });
    }

    const server = buildServer(env, caller);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless — no session needed
    });

    await server.connect(transport);
    return transport.handleRequest(request);
  },
};
