CREATE TABLE IF NOT EXISTS trading_workflow_progress (
 user_id TEXT NOT NULL, date TEXT NOT NULL, state TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL,
 PRIMARY KEY(user_id,date)
);
