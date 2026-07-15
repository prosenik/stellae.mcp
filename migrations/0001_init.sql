-- Baseline v1 schema.
-- Guarded with IF NOT EXISTS so this migration is a no-op on databases
-- that were originally created from the old schema.sql.
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK(type IN ('user', 'project', 'feedback', 'reference')),
  category TEXT NOT NULL,
  content TEXT NOT NULL,
  source TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type);
CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(category);
CREATE INDEX IF NOT EXISTS idx_memories_updated ON memories(updated_at DESC);
