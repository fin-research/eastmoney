CREATE TABLE IF NOT EXISTS tracking_commentary_workspace (
  commentary_id TEXT PRIMARY KEY REFERENCES research_commentary(id) ON DELETE CASCADE,
  origin TEXT NOT NULL DEFAULT 'manual' CHECK(origin IN ('legacy','manual','import','ai')),
  original_text TEXT NOT NULL DEFAULT '',
  source_files_json TEXT NOT NULL DEFAULT '[]',
  import_key TEXT UNIQUE,
  evidence_json TEXT NOT NULL DEFAULT '[]',
  search_json TEXT
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS tracking_commentary_revision (
  commentary_id TEXT NOT NULL REFERENCES research_commentary(id) ON DELETE CASCADE,
  saved_at TEXT NOT NULL,
  content_json TEXT NOT NULL,
  PRIMARY KEY(commentary_id, saved_at)
) WITHOUT ROWID;

-- Archive the previous version, including legacy policy endpoint writes.
-- Current version is read from research_commentary, so an unedited AI draft is retained.
CREATE TRIGGER IF NOT EXISTS tracking_commentary_before_update
BEFORE UPDATE ON research_commentary
BEGIN
  INSERT OR IGNORE INTO tracking_commentary_revision(commentary_id, saved_at, content_json)
  VALUES(OLD.id, OLD.updated_at, json_object(
    'id', OLD.id, 'policyId', OLD.policy_id, 'type', OLD.commentary_type,
    'eventName', OLD.event_name, 'sources', OLD.sources,
    'eventPublishedAt', OLD.event_published_at, 'commentaryDate', OLD.commentary_date,
    'eventSummary', OLD.event_summary, 'commentary', OLD.commentary, 'recommendation', OLD.recommendation,
    'model', OLD.model, 'promptVersion', OLD.prompt_version, 'generatedAt', OLD.generated_at,
    'edited', json(CASE OLD.edited WHEN 1 THEN 'true' ELSE 'false' END), 'updatedAt', OLD.updated_at,
    'origin', COALESCE((SELECT origin FROM tracking_commentary_workspace WHERE commentary_id=OLD.id),'legacy'),
    'originalText', COALESCE((SELECT original_text FROM tracking_commentary_workspace WHERE commentary_id=OLD.id),''),
    'sourceFiles', json(COALESCE((SELECT source_files_json FROM tracking_commentary_workspace WHERE commentary_id=OLD.id),'[]')),
    'evidence', json(COALESCE((SELECT evidence_json FROM tracking_commentary_workspace WHERE commentary_id=OLD.id),'[]')),
    'search', json((SELECT search_json FROM tracking_commentary_workspace WHERE commentary_id=OLD.id))
  ));
END;
CREATE INDEX IF NOT EXISTS research_commentary_date_idx ON research_commentary(commentary_date DESC, id);
