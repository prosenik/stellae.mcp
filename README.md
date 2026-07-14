# stellae.mcp

A personal memory MCP server for Stellae Studio — deployed on Cloudflare Workers with a D1 database backend. Gives AI assistants persistent, structured context about projects, preferences, and workflows.

Accessible at `mcp.stellae.studio`.

> 📋 **Where this is heading:** see [docs/BRAIN-ANALYSIS.md](docs/BRAIN-ANALYSIS.md) — a full gap analysis and prioritised roadmap for turning this into the brain for all agency and private work.

---

## What it does

Stores and retrieves "memories" — structured notes about Stellae Studio that an AI assistant can call at the start of every session to get full context without re-explaining everything.

Memories are typed:

- **user** — who Niko is, personal preferences, working style
- **project** — active projects, pipeline status, goals
- **feedback** — how the assistant should behave, tone, patterns to follow
- **reference** — where to find things (Notion pages, Figma links, tools)

---

## MCP Tools

| Tool | Description |
|---|---|
| `get_briefing` | Returns a full structured briefing — all memories grouped by type. Call at session start. |
| `remember` | Store a new memory (type, category, content, optional source). |
| `recall` | Search memories by keyword, optionally filtered by type. |
| `update_memory` | Replace the content of an existing memory by ID. |
| `delete_memory` | Delete a memory by ID. |
| `list_memories` | List all memory IDs, types, and categories — no full content. |

---

## Stack

- **Runtime** — Cloudflare Workers (TypeScript)
- **Database** — Cloudflare D1 (SQLite)
- **MCP SDK** — `@modelcontextprotocol/sdk`
- **Validation** — Zod
- **Deploy** — Wrangler

---

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Run migrations locally

```bash
npm run migrate:local
```

### 3. Develop locally

```bash
npm run dev
```

### 4. Deploy

```bash
npm run migrate:remote
npm run deploy
```

---

## Auth

All MCP and API routes are protected by an `API_KEY` environment variable set in Cloudflare.

- **MCP / API** — pass as `Authorization: Bearer <key>` header or `?key=<key>` query param
- **Dashboard** — cookie-based session after login at `mcp.stellae.studio`

---

## Dashboard

A minimal dark-mode web UI is served at the root (`/`). It shows all stored memories grouped by type with a live search filter. Login with your API key to access it.
