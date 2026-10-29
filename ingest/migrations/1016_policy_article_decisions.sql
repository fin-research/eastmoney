CREATE TABLE IF NOT EXISTS policy_article_decision (
  policy_id TEXT NOT NULL,
  article_id TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  related INTEGER NOT NULL CHECK (related IN (0, 1)),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (policy_id, article_id),
  FOREIGN KEY (policy_id) REFERENCES policy_event(id) ON DELETE CASCADE,
  FOREIGN KEY (article_id) REFERENCES article(id) ON DELETE CASCADE
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS policy_article_decision_article_idx
  ON policy_article_decision (article_id);
