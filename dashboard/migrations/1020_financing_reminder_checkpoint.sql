-- Scheduling metadata only; business reminders remain owned by Neon.
CREATE TABLE IF NOT EXISTS financing_reminder_checkpoint (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  generation INTEGER NOT NULL DEFAULT 0,
  checked_at INTEGER NOT NULL DEFAULT 0,
  next_scan_at INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO financing_reminder_checkpoint (id) VALUES (1);
