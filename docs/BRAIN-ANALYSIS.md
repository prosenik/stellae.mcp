# The Stellae Brain — Gap Analysis & Roadmap

_Written 2026-07-14. Reviewed against the goal: **stellae.mcp becomes the single brain for all agency and private work at Stellae Studio** — the persistent context layer every assistant and agent (Claude/Cowork, stellae.clawd, agent-observer, mission-control) reads from and writes to._

---

## 1. Where we are today

The current implementation is a clean, working v1:

- One `memories` table (id, type, category, content, source, timestamps)
- Four memory types: `user`, `project`, `feedback`, `reference`
- Six MCP tools: `get_briefing`, `remember`, `recall`, `update_memory`, `delete_memory`, `list_memories`
- `LIKE`-based keyword search
- Single shared `API_KEY` for everything
- A minimal dashboard at `/` with client-side search
- Stateless Streamable HTTP transport on Cloudflare Workers + D1

This is a solid foundation and the right stack for the job (zero-maintenance, fast, cheap, globally available). The gaps below are about what happens **when this becomes the brain for everything** — mixed private/agency data, multiple consumers, and hundreds-to-thousands of memories.

---

## 2. Gap analysis

### 2.1 No separation between private and agency (critical)

Everything lives in one undifferentiated pool behind one key. The moment a client-facing agent, a collaborator, or an automation gets brain access, it sees **everything** — including private memories.

**What's missing:**

- A `workspace` (or `scope`) dimension: at minimum `private`, `agency`, and per-client scopes (`client:lelo`, `client:pfan`, …)
- **Scoped API keys** — each consumer (Cowork, clawd, a client project agent) gets its own key bound to the workspaces it may read/write
- Briefings and recall filtered by the caller's scope by default

This is the single most important change before the brain holds real private + client data.

### 2.2 `get_briefing` won't scale

`get_briefing` returns *every memory, full content*. At 50 memories that's fine; at 500 it blows the context window of whatever agent called it, buries the important facts, and costs tokens on every session start.

**What's missing:**

- `importance` ranking (e.g. 1–5) so briefings lead with what matters
- Scoping parameters: `workspace`, `project`, `types`, `since`, `max_tokens`
- A tiered briefing: pinned/core memories in full, the rest as one-line summaries with IDs to `recall` on demand
- Usage-aware pruning: track when memories are actually recalled, surface never-used ones for review

### 2.3 Retrieval is keyword-only

`LIKE %query%` misses synonyms, phrasing differences, and anything the agent words differently than the memory.

**What's missing (in order of effort):**

1. **SQLite FTS5** — D1 supports it. Proper tokenised full-text search with ranking (BM25), prefix queries, phrase queries. Cheap win.
2. **Semantic search** — Cloudflare Vectorize + Workers AI embeddings (`@cf/baai/bge-m3` or similar) are available on the same platform. Embed on `remember`, query on `recall`. This is what makes "what did we decide about the portal onboarding?" work.

### 2.4 The data model is too flat for agency operations

Four types cover assistant context well, but "all agency and private tasks" implies structured entities the current model can't represent:

| Missing entity | Why it matters |
|---|---|
| **Clients / contacts** | Who we work with, status, preferences, history — the core of agency memory |
| **Decisions log** | "Why did we choose X?" — the highest-value memory type for any studio; decisions with date, context, alternatives considered |
| **Tasks / commitments** | Things promised, with due dates — so a morning-digest agent can ask the brain "what's open?" |
| **Meeting / conversation notes** | Structured summaries with participants and date, linked to a client or project |
| **Assets & credentials pointers** | Where things live (repo, Figma file, Notion page, password manager entry name — never the secret itself) |

Also missing on every memory, regardless of type:

- `tags` (JSON array) — cross-cutting labels (`design-system`, `billing`, `urgent`)
- `importance` (1–5) — drives briefing ranking
- `status` (`active` / `archived`) — soft delete; today `delete_memory` is destructive and unrecoverable
- `expires_at` / `review_after` — some facts go stale (pricing, deadlines, client status); the brain should know when to distrust itself
- `related_ids` — link a decision to its project, a note to its client
- **Edit history** — `update_memory` silently overwrites; a small `memory_versions` table preserves what we used to believe and when it changed

### 2.5 No memory lifecycle

Memories only accumulate. Nothing decays, gets verified, or gets summarised. In six months the brain will contain confidently-stated stale facts — worse than no memory.

**What's missing:**

- A **review queue**: memories past `review_after` (or untouched for N months) get flagged; a periodic session confirms, updates, or archives them
- **Scheduled distillation**: a Workers cron trigger that periodically compacts clusters of old related memories into a single summarised memory (keeping originals archived)
- **Dedupe on write**: `remember` should first check for near-duplicates and offer to update instead of insert

### 2.6 Security hardening

For a brain that will hold private and client data:

| Issue | Current | Fix |
|---|---|---|
| Key in query string | `?key=<API_KEY>` accepted | Header-only (`Authorization: Bearer`). Query strings end up in logs, analytics, and browser history |
| Raw key in cookie | Dashboard cookie stores the API key itself | Issue a random session token; store a hash server-side or sign it |
| Single all-powerful key | One `API_KEY` env var | Multiple keys with scopes (see 2.1), stored hashed in D1, revocable individually |
| Non-constant-time compare | `key === env.API_KEY` | Timing-safe comparison (`crypto.subtle.timingSafeEqual` pattern) |
| CORS wildcard | `Access-Control-Allow-Origin: *` | Restrict to known origins; MCP clients don't need CORS at all |
| No rate limiting | — | Cloudflare rate-limiting rule on `mcp.stellae.studio` (protects the login form especially) |
| `account_id` in repo | Committed in `wrangler.jsonc` | Low sensitivity, but can move to env; more importantly keep the repo private (done ✓) |

### 2.7 No safety net (ops)

- **No backups.** D1 is durable but not immune to a bad migration or a buggy `DELETE`. Add a scheduled export (cron trigger → dump table → R2 bucket) and a `export_memories` MCP tool.
- **No CI.** Add a GitHub Action running `tsc --noEmit` on push. Cheap, catches breakage.
- **No versioned migrations.** `schema.sql` with `IF NOT EXISTS` can't evolve columns. Move to numbered migration files (`migrations/0001_init.sql`, `0002_workspaces.sql`, …) applied in order.
- **No tests.** Even a handful of integration tests against a local D1 (wrangler supports this) for the tool handlers.
- **No staging.** A `wrangler` env (`brain-stellae-staging`) to try schema changes before they touch the real brain.

### 2.8 The brain is passive

Today, memory only forms when someone explicitly calls `remember`. The rest of the ecosystem (Slack, Notion, mission-control, agent-observer, socials, changelog) generates context all day that evaporates.

**Worth building (later, carefully):**

- **Ingestion endpoints**: webhook routes where trusted sources propose memories into a `pending` state; a human (or a review session) approves them into the brain. Auto-write without review is how a brain fills with noise — the approval step is the feature.
- **Per-agent briefing profiles**: clawd gets `feedback` + active `project` memories; a client agent gets only that client's workspace; the morning digest gets tasks + recent decisions.
- **Changelog bridge**: decisions and project-status memories could feed `stellae.changelog` automatically.

---

## 3. Proposed schema v2 (sketch)

```sql
-- memories, evolved (via migration, preserving existing rows)
ALTER TABLE memories ADD COLUMN workspace TEXT NOT NULL DEFAULT 'agency';  -- 'private' | 'agency' | 'client:<slug>'
ALTER TABLE memories ADD COLUMN tags TEXT;                                 -- JSON array
ALTER TABLE memories ADD COLUMN importance INTEGER NOT NULL DEFAULT 3;     -- 1..5
ALTER TABLE memories ADD COLUMN status TEXT NOT NULL DEFAULT 'active';     -- 'active' | 'archived' | 'pending'
ALTER TABLE memories ADD COLUMN review_after TEXT;                         -- ISO date; null = evergreen
ALTER TABLE memories ADD COLUMN related_ids TEXT;                          -- JSON array of memory ids

-- New types join the CHECK constraint (requires table rebuild in SQLite):
-- 'user' | 'project' | 'feedback' | 'reference' | 'client' | 'decision' | 'task' | 'note'

-- Full-text search
CREATE VIRTUAL TABLE memories_fts USING fts5(content, category, tags, content='memories', content_rowid='rowid');

-- Edit history
CREATE TABLE memory_versions (
  id TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL,
  content TEXT NOT NULL,
  replaced_at TEXT NOT NULL
);

-- Scoped API keys
CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,
  key_hash TEXT NOT NULL,
  label TEXT NOT NULL,               -- 'cowork', 'clawd', 'client:lelo-agent'
  workspaces TEXT NOT NULL,          -- JSON array of readable workspaces
  can_write INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  last_used_at TEXT
);
```

## 4. Proposed tool surface v2

| Tool | Change |
|---|---|
| `get_briefing` | Params: `workspace?`, `project?`, `max_tokens?`. Tiered output: pinned in full, rest as index. Filtered by caller's key scope |
| `recall` | FTS5 (then semantic) search; filters for `workspace`, `tags`, `type`, `status` |
| `remember` | New fields: `workspace`, `tags`, `importance`, `review_after`, `related_ids`. Dedupe check before insert |
| `update_memory` | Writes previous content to `memory_versions` |
| `archive_memory` | Replaces destructive delete as the default; `delete_memory` stays for true removal |
| `log_decision` | Sugar for `remember(type: 'decision')` with structured fields: decision, context, alternatives, project |
| `list_review_queue` | Memories past `review_after` or stale — powers a periodic brain-gardening session |
| `export_memories` | Full JSON dump for backup/portability |

## 5. Prioritised roadmap

**Now (this makes the brain safe to fill):**
1. Workspaces + scoped API keys (2.1, security table in 2.6)
2. Header-only auth, session-token dashboard cookie, timing-safe compare
3. Versioned migrations + scheduled D1 backup to R2
4. `tags`, `importance`, `status` columns; `archive_memory`

**Next (this makes the brain good at its job):**
5. FTS5 search
6. Tiered, scoped `get_briefing` with token budget
7. `decision`, `client`, `task`, `note` types + `log_decision`
8. Edit history; review queue + `review_after`
9. CI (typecheck) + basic integration tests

**Later (this makes the brain grow on its own):**
10. Semantic search (Vectorize + Workers AI)
11. Ingestion webhooks with pending-approval flow
12. Scheduled distillation cron
13. Per-agent briefing profiles; changelog bridge; recall-usage analytics

---

_The theme across all of it: v1 answers "can we store and fetch memories?" — v2 answers "can we trust the brain with everything, and does it stay sharp as it grows?"_
