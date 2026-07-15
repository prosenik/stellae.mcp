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
| `export_memories` | Export every memory the key can read as a JSON document — for backup or portability. |

All tools are automatically filtered by the calling key's workspace scope.

---

## Stack

- **Runtime** — Cloudflare Workers (TypeScript)
- **Database** — Cloudflare D1 (SQLite)
- **Backups** — Cloudflare R2 (`brain-stellae-backups`)
- **MCP SDK** — `@modelcontextprotocol/sdk`
- **Validation** — Zod
- **Deploy** — Wrangler

---

## Backups

The full `memories` and `api_keys` tables are dumped to the R2 bucket `brain-stellae-backups` under `memories/<ISO-timestamp>.json`:

- **On schedule** — a Worker cron trigger runs daily at **03:00 UTC** (`triggers.crons` in [wrangler.jsonc](wrangler.jsonc))
- **On demand** — `POST /admin/backup` with the master key forces a backup immediately:
  ```bash
  curl -X POST https://mcp.stellae.studio/admin/backup -H "Authorization: Bearer $MASTER_KEY"
  # → { "ok": true, "key": "memories/2026-07-15T…json", "memories": 13, "keys": 2 }
  ```

Backups contain API-key **hashes only** — raw keys are never stored anywhere. Set an R2 lifecycle rule on the bucket if you want to auto-expire old dumps.

### Restore

```bash
# 1. Download a backup
npx wrangler r2 object get brain-stellae-backups/memories/<timestamp>.json --file restore.json

# 2. Turn it into INSERTs and load it (memories shown; api_keys analogous)
node -e '
  const d = require("./restore.json");
  const esc = v => v == null ? "NULL" : `'"'"'${String(v).replace(/'"'"'/g,"'"'"''"'"'")}'"'"'`;
  for (const m of d.memories)
    console.log(`INSERT INTO memories (id,type,category,content,source,workspace,created_at,updated_at) VALUES (${[m.id,m.type,m.category,m.content,m.source,m.workspace,m.created_at,m.updated_at].map(esc).join(",")});`);
' > restore.sql
npx wrangler d1 execute brain-stellae --remote --file restore.sql
```

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

**MCP / API auth is `Authorization: Bearer <key>` only.** Query-param auth (`?key=`) was removed — keys in URLs leak into logs, analytics, and browser history.

The dashboard at `mcp.stellae.studio` logs in with a key but stores only a random session token in the cookie (30-day expiry, hash stored server-side). Revoking a key immediately invalidates its sessions. Login attempts are rate-limited to 5/minute per IP.

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
