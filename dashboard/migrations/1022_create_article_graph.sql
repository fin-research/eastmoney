CREATE TABLE IF NOT EXISTS article_node (
  article_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  label TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('policy', 'macro', 'market', 'sector', 'event')),
  fact TEXT NOT NULL,
  impact TEXT NOT NULL,
  PRIMARY KEY (article_id, ordinal),
  FOREIGN KEY (article_id) REFERENCES article(id) ON DELETE CASCADE
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS article_claim (
  article_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  cause TEXT NOT NULL,
  cause_move TEXT NOT NULL CHECK (cause_move IN ('rise', 'fall', 'occur')),
  effect TEXT NOT NULL,
  effect_move TEXT NOT NULL CHECK (effect_move IN ('rise', 'fall')),
  basis TEXT NOT NULL CHECK (basis IN ('observed', 'expected')),
  mechanism TEXT NOT NULL,
  PRIMARY KEY (article_id, ordinal),
  FOREIGN KEY (article_id) REFERENCES article(id) ON DELETE CASCADE
) WITHOUT ROWID;
