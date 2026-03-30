-- Beast API tokens for server-side identity validation (T#546)
-- Layer 2 of the three-layer security plan

CREATE TABLE IF NOT EXISTS beast_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  beast TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  revoked_at TEXT,
  created_by TEXT NOT NULL,
  last_used_at TEXT,
  FOREIGN KEY (beast) REFERENCES beast_profiles(name)
);

CREATE INDEX IF NOT EXISTS idx_beast_tokens_beast ON beast_tokens(beast);
CREATE INDEX IF NOT EXISTS idx_beast_tokens_hash ON beast_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_beast_tokens_expires ON beast_tokens(expires_at);
