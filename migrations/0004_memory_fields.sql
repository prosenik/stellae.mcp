-- Task 4 (docs/BRAIN-ANALYSIS.md §2.4, §3):
-- richer per-memory metadata + soft-delete via status.
--
-- SQLite ALTER TABLE ADD COLUMN allows a NOT NULL column only with a
-- constant default, so existing rows migrate cleanly:
--   importance -> 3 (neutral), status -> 'active'.
-- Range/enum validation lives in the app layer (Zod), since ALTER cannot
-- attach CHECK constraints to an existing table.

ALTER TABLE memories ADD COLUMN tags TEXT;                              -- JSON array of strings, null = none
ALTER TABLE memories ADD COLUMN importance INTEGER NOT NULL DEFAULT 3;  -- 1..5, drives briefing ranking
ALTER TABLE memories ADD COLUMN status TEXT NOT NULL DEFAULT 'active';  -- 'active' | 'archived' | 'pending'
ALTER TABLE memories ADD COLUMN review_after TEXT;                      -- ISO date; null = evergreen
ALTER TABLE memories ADD COLUMN related_ids TEXT;                       -- JSON array of memory ids, null = none

CREATE INDEX idx_memories_status ON memories(status);
CREATE INDEX idx_memories_importance ON memories(importance DESC);
