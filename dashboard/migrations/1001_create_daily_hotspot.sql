CREATE TABLE IF NOT EXISTS daily_hotspot (
  date TEXT PRIMARY KEY,
  input_fingerprint TEXT NOT NULL,
  generated_at TEXT NOT NULL,
  model TEXT NOT NULL,
  payload TEXT NOT NULL
) WITHOUT ROWID;
