CREATE TABLE IF NOT EXISTS research_commentary_pdf (
  commentary_id TEXT NOT NULL REFERENCES research_commentary(id) ON DELETE CASCADE,
  revision_at TEXT NOT NULL,
  r2_key TEXT NOT NULL UNIQUE,
  file_name TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK(byte_size > 0),
  archived_at TEXT NOT NULL,
  PRIMARY KEY(commentary_id, revision_at)
) WITHOUT ROWID;
