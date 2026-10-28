CREATE TABLE IF NOT EXISTS hotspot_cache (
  scope_key TEXT PRIMARY KEY,
  input_fingerprint TEXT NOT NULL,
  generated_at TEXT NOT NULL,
  model TEXT NOT NULL,
  payload TEXT NOT NULL
) WITHOUT ROWID;
