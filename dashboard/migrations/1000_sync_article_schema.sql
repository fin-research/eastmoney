-- Keep local dashboard development self-contained while sharing the production
-- eastmoney D1 database with the ingest Worker.
CREATE TABLE IF NOT EXISTS article (
  id TEXT PRIMARY KEY,
  news_id TEXT,
  title TEXT NOT NULL,
  published_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  link TEXT,
  author TEXT,
  summary TEXT,
  importance INTEGER CHECK (importance BETWEEN 0 AND 100),
  prompt_version TEXT CHECK (prompt_version IN ('v1', 'v2'))
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS keyword (
  article_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  topic TEXT NOT NULL,
  fact TEXT NOT NULL,
  interpretation TEXT NOT NULL,
  impact TEXT NOT NULL,
  PRIMARY KEY (article_id, ordinal),
  FOREIGN KEY (article_id) REFERENCES article(id) ON DELETE CASCADE
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS keyword_topic_idx ON keyword(topic);
