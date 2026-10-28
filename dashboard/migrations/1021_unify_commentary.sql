ALTER TABLE research_commentary RENAME TO commentary;
ALTER TABLE tracking_commentary_workspace RENAME TO commentary_workspace;
ALTER TABLE tracking_commentary_revision RENAME TO commentary_revision;
ALTER TABLE research_commentary_pdf RENAME TO commentary_pdf;
DROP TRIGGER tracking_commentary_before_update;
DROP INDEX research_commentary_type_date_idx;
DROP INDEX research_commentary_date_idx;
CREATE INDEX commentary_type_date_idx ON commentary(commentary_type, commentary_date DESC);
CREATE INDEX commentary_date_idx ON commentary(commentary_date DESC, id);
CREATE TRIGGER commentary_before_update
BEFORE UPDATE ON commentary
BEGIN
  INSERT OR IGNORE INTO commentary_revision(commentary_id, saved_at, content_json)
  VALUES(OLD.id, OLD.updated_at, json_object(
    'id', OLD.id, 'policyId', OLD.policy_id, 'type', OLD.commentary_type,
    'eventName', OLD.event_name, 'sources', OLD.sources,
    'eventPublishedAt', OLD.event_published_at, 'commentaryDate', OLD.commentary_date,
    'eventSummary', OLD.event_summary, 'commentary', OLD.commentary, 'recommendation', OLD.recommendation,
    'model', OLD.model, 'promptVersion', OLD.prompt_version, 'generatedAt', OLD.generated_at,
    'edited', json(CASE OLD.edited WHEN 1 THEN 'true' ELSE 'false' END), 'updatedAt', OLD.updated_at,
    'origin', COALESCE((SELECT origin FROM commentary_workspace WHERE commentary_id=OLD.id),'legacy'),
    'originalText', COALESCE((SELECT original_text FROM commentary_workspace WHERE commentary_id=OLD.id),''),
    'sourceFiles', json(COALESCE((SELECT source_files_json FROM commentary_workspace WHERE commentary_id=OLD.id),'[]')),
    'evidence', json(COALESCE((SELECT evidence_json FROM commentary_workspace WHERE commentary_id=OLD.id),'[]')),
    'search', json((SELECT search_json FROM commentary_workspace WHERE commentary_id=OLD.id))
  ));
END;
