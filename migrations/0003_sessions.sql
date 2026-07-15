-- Task 2 (docs/BRAIN-ANALYSIS.md §2.6): dashboard session tokens.
-- The cookie holds a random session token; only its SHA-256 digest is stored.
-- key_id is 'master' (the env API_KEY) or an api_keys.id — sessions are
-- re-validated against the key on every request, so revoking a key kills
-- its sessions too.
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  key_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX idx_sessions_expires ON sessions(expires_at);
