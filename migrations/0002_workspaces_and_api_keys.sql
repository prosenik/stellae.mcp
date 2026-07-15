-- Task 1 (docs/BRAIN-ANALYSIS.md §2.1, §2.6, §3):
-- workspace separation + scoped API keys.

-- Every memory belongs to exactly one workspace:
--   'private' | 'agency' | 'client:<slug>'
-- Existing rows are agency memories by definition (the brain held no private
-- data before workspaces existed).
ALTER TABLE memories ADD COLUMN workspace TEXT NOT NULL DEFAULT 'agency';

CREATE INDEX idx_memories_workspace ON memories(workspace);

-- Scoped API keys. The raw key is never stored — only its SHA-256 hex digest.
-- `workspaces` is a JSON array of workspaces this key may read/write,
-- e.g. '["agency"]', '["client:lelo"]', or '["*"]' for full access.
-- Revocation is a soft flag so the audit trail survives.
CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,
  key_hash TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  workspaces TEXT NOT NULL,
  can_write INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT
);
