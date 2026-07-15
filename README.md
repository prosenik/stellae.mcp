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

…and belong to exactly one **workspace**:

- `private` — personal memories, never visible to agency/client consumers
- `agency` — Stellae Studio internal context (the default)
- `client:<slug>` — per-client scopes, e.g. `client:lelo`

---

## MCP Tools

| Tool | Description |
|---|---|
| `get_briefing` | Returns a full structured briefing — all memories the calling key can read, grouped by workspace and type. Call at session start. |
| `remember` | Store a new memory (type, category, content, optional source and workspace). |
| `recall` | Search memories by keyword, optionally filtered by type/workspace. |
| `update_memory` | Replace the content of an existing memory by ID. |
| `delete_memory` | Delete a memory by ID. |
| `list_memories` | List all memory IDs, types, workspaces, and categories — no full content. |

All tools are automatically filtered by the calling key's workspace scope.

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

Migrations are versioned files in [migrations/](migrations/) applied in order via `wrangler d1 migrations apply` (state is tracked in the database).

### 3. Develop locally

```bash
npm run dev
```

### 4. Test & typecheck

```bash
npm test
npm run typecheck
```

### 5. Deploy

```bash
npm run migrate:remote
npm run deploy
```

---

## Auth

Two kinds of keys:

- **Master key** — the `API_KEY` environment variable set in Cloudflare. Full access to every workspace + key management. Kept for migration compatibility; will be retired once all consumers use scoped keys.
- **Scoped keys** — per-consumer keys stored (SHA-256 hashed) in D1. Each key is bound to the workspaces it may read/write and can be read-only. Revocable individually.

Pass either as `Authorization: Bearer <key>` header or `?key=<key>` query param (query param support will be removed in the auth-hardening task). The dashboard uses a cookie-based session after login at `mcp.stellae.studio` and shows only the memories the key can read.

### Key management (master key only)

```bash
# Create a scoped key (plaintext key is returned ONCE — store it safely)
curl -X POST https://mcp.stellae.studio/admin/keys \
  -H "Authorization: Bearer $MASTER_KEY" \
  -H "Content-Type: application/json" \
  -d '{"label": "lelo-agent", "workspaces": ["client:lelo"], "can_write": true}'

# List keys (no hashes, no plaintext)
curl https://mcp.stellae.studio/admin/keys -H "Authorization: Bearer $MASTER_KEY"

# Revoke a key (soft — audit trail survives)
curl -X DELETE https://mcp.stellae.studio/admin/keys/<id> -H "Authorization: Bearer $MASTER_KEY"
```

`workspaces` accepts `private`, `agency`, `client:<slug>`, or `"*"` for full access.

---

## Dashboard

A minimal dark-mode web UI is served at the root (`/`). It shows all stored memories grouped by type with a live search filter. Login with your API key to access it.
