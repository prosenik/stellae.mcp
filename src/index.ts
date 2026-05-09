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
  created_at: string;
  updated_at: string;
}

function buildServer(env: Env): McpServer {
  const server = new McpServer({
    name: "brain.stellae.studio",
    version: "1.0.0",
  });

  // ── get_briefing ─────────────────────────────────────────────────────────
  server.tool(
    "get_briefing",
    "Get a full structured briefing about Stellae Studio — projects, agent pipeline, preferences, and key context. Call this at the start of every session.",
    {},
    async () => {
      const { results } = await env.DB.prepare(
        "SELECT * FROM memories ORDER BY type, category, updated_at DESC"
      ).all<Memory>();

      if (results.length === 0) {
        return {
          content: [{ type: "text" as const, text: "No memories stored yet. Use `remember` to start building context." }],
        };
      }

      const grouped = results.reduce((acc, m) => {
        if (!acc[m.type]) acc[m.type] = [];
        acc[m.type].push(m);
        return acc;
      }, {} as Record<string, Memory[]>);

      const typeLabels: Record<string, string> = {
        user: "👤 USER & PREFERENCES",
        project: "🚀 PROJECTS & PIPELINE",
        feedback: "💬 FEEDBACK & BEHAVIOR",
        reference: "🔗 REFERENCES",
      };

      let briefing = `# Stellae Studio — Brain Briefing\n_${new Date().toISOString()}_\n\n`;

      for (const type of ["user", "project", "feedback", "reference"]) {
        const memories = grouped[type];
        if (!memories?.length) continue;
        briefing += `## ${typeLabels[type] ?? type.toUpperCase()}\n\n`;
        for (const m of memories) {
          briefing += `### ${m.category}\n${m.content}\n`;
          if (m.source) briefing += `_Source: ${m.source}_\n`;
          briefing += `_ID: ${m.id} · Updated: ${m.updated_at}_\n\n`;
        }
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
    },
    async ({ type, category, content, source }) => {
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      await env.DB.prepare(
        "INSERT INTO memories (id, type, category, content, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
      )
        .bind(id, type, category, content, source ?? null, now, now)
        .run();

      return {
        content: [{ type: "text" as const, text: `✓ Memory stored.\nID: ${id}\nType: ${type} / ${category}` }],
      };
    }
  );

  // ── recall ────────────────────────────────────────────────────────────────
  server.tool(
    "recall",
    "Search memories by keyword, category, or type.",
    {
      query: z.string().describe("Search term — matches against content and category"),
      type: z
        .enum(["user", "project", "feedback", "reference"])
        .optional()
        .describe("Filter by memory type"),
    },
    async ({ query, type }) => {
      let sql = "SELECT * FROM memories WHERE (content LIKE ? OR category LIKE ?)";
      const params: (string | null)[] = [`%${query}%`, `%${query}%`];

      if (type) {
        sql += " AND type = ?";
        params.push(type);
      }
      sql += " ORDER BY updated_at DESC LIMIT 20";

      const { results } = await env.DB.prepare(sql).bind(...params).all<Memory>();

      if (results.length === 0) {
        return {
          content: [{ type: "text" as const, text: `No memories found for "${query}"${type ? ` (type: ${type})` : ""}.` }],
        };
      }

      const text = results
        .map((m) => `[${m.id}]\n**${m.type} / ${m.category}**\n${m.content}${m.source ? `\n_Source: ${m.source}_` : ""}`)
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
      const now = new Date().toISOString();
      const result = await env.DB.prepare(
        "UPDATE memories SET content = ?, updated_at = ? WHERE id = ?"
      )
        .bind(content, now, id)
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
      await env.DB.prepare("DELETE FROM memories WHERE id = ?").bind(id).run();
      return { content: [{ type: "text" as const, text: `✓ Memory deleted.` }] };
    }
  );

  // ── list_memories ─────────────────────────────────────────────────────────
  server.tool(
    "list_memories",
    "List all stored memories with IDs, types, and categories (no full content). Use to get an overview or find IDs.",
    {
      type: z
        .enum(["user", "project", "feedback", "reference"])
        .optional()
        .describe("Filter by type"),
    },
    async ({ type }) => {
      let sql = "SELECT id, type, category, updated_at FROM memories";
      const params: string[] = [];
      if (type) {
        sql += " WHERE type = ?";
        params.push(type);
      }
      sql += " ORDER BY type, category";

      const { results } = await env.DB.prepare(sql)
        .bind(...params)
        .all<Pick<Memory, "id" | "type" | "category" | "updated_at">>();

      if (results.length === 0) {
        return { content: [{ type: "text" as const, text: "No memories stored yet." }] };
      }

      const text = results
        .map((m) => `[${m.id}] ${m.type} / ${m.category} · ${m.updated_at}`)
        .join("\n");

      return { content: [{ type: "text" as const, text: `${results.length} memories:\n\n${text}` }] };
    }
  );

  return server;
}

// ── Dashboard HTML ────────────────────────────────────────────────────────────
function loginPage(error = false): Response {
  return new Response(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>brain.stellae.studio</title>
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
    <h1>brain.stellae.studio</h1>
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

function dashboardPage(memories: Memory[]): Response {
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
        <div class="id">${m.id}</div>
      </div>`).join("");
    return `<section><h2>${typeLabels[type]}</h2>${cards}</section>`;
  }).join("");

  return new Response(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>brain.stellae.studio</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: #0a0a0a; color: #e0e0e0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; padding: 40px 24px; }
    header { display: flex; align-items: center; justify-content: space-between; max-width: 760px; margin: 0 auto 36px; }
    header h1 { font-size: 16px; font-weight: 600; color: #fff; }
    header span { font-size: 12px; color: #555; }
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
    .id { font-size: 10px; color: #333; margin-top: 6px; font-family: monospace; }
    .empty { color: #444; font-size: 14px; text-align: center; padding: 60px 0; }
    .logout { font-size: 12px; color: #555; text-decoration: none; }
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
    <h1>brain.stellae.studio</h1>
    <a href="/logout" class="logout">Sign out</a>
  </header>
  <div class="search-bar"><input type="search" placeholder="Search memories…" /></div>
  ${memories.length === 0 ? '<p class="empty">No memories yet.</p>' : sections}
</body>
</html>`, { headers: { "Content-Type": "text/html" } });
}

// ── Main fetch handler ────────────────────────────────────────────────────────
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // ── Dashboard routes (cookie-auth) ────────────────────────────────────
    const cookie = request.headers.get("Cookie") ?? "";
    const sessionKey = cookie.match(/brain_key=([^;]+)/)?.[1];

    if (url.pathname === "/login") {
      if (request.method === "POST") {
        const body = await request.formData();
        const key = body.get("key")?.toString() ?? "";
        if (key === env.API_KEY) {
          return new Response(null, {
            status: 302,
            headers: {
              "Location": "/",
              "Set-Cookie": `brain_key=${key}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=2592000`,
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
      if (sessionKey !== env.API_KEY) return loginPage();
      const { results } = await env.DB.prepare(
        "SELECT * FROM memories ORDER BY type, category, updated_at DESC"
      ).all<Memory>();
      return dashboardPage(results);
    }

    // ── MCP & API routes (bearer/query-param auth) ────────────────────────
    const authHeader = request.headers.get("Authorization");
    const headerToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
    const queryToken = url.searchParams.get("key");
    const token = headerToken ?? queryToken;
    if (!token || token !== env.API_KEY) {
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

    // MCP endpoint
    if (url.pathname !== "/mcp") {
      return new Response("Not found", { status: 404 });
    }

    const server = buildServer(env);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless — no session needed
    });

    await server.connect(transport);
    return transport.handleRequest(request);
  },
};
