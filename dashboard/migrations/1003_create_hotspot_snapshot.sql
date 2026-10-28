CREATE TABLE IF NOT EXISTS hotspot_snapshot (
  snapshot_id TEXT PRIMARY KEY,
  input_fingerprint TEXT NOT NULL,
  generated_at TEXT NOT NULL,
  model TEXT NOT NULL,
  scope TEXT NOT NULL,
  payload TEXT NOT NULL
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS hotspot_snapshot_generated_at_idx
ON hotspot_snapshot (generated_at DESC);

INSERT OR IGNORE INTO hotspot_snapshot (
  snapshot_id,
  input_fingerprint,
  generated_at,
  model,
  scope,
  payload
)
SELECT
  'legacy:' || cache.scope_key || ':' || cache.generated_at,
  cache.input_fingerprint,
  cache.generated_at,
  cache.model,
  CASE
    WHEN cache.scope_key LIKE 'rolling:%' THEN json_object(
      'mode', 'rolling',
      'rollingCount', CAST(substr(cache.scope_key, 9) AS INTEGER),
      'articleCount', json_array_length(json_extract(cache.payload, '$.coverage.analyzedArticleIds')),
      'firstPublishedAt', COALESCE(
        (
          SELECT MIN(article.published_at)
          FROM article
          WHERE article.id IN (
            SELECT value
            FROM json_each(cache.payload, '$.coverage.analyzedArticleIds')
          )
        ),
        json_extract(cache.payload, '$.date') || 'T00:00:00+08:00'
      ),
      'lastPublishedAt', COALESCE(
        (
          SELECT MAX(article.published_at)
          FROM article
          WHERE article.id IN (
            SELECT value
            FROM json_each(cache.payload, '$.coverage.analyzedArticleIds')
          )
        ),
        json_extract(cache.payload, '$.date') || 'T23:59:59+08:00'
      )
    )
    ELSE json_object(
      'mode', 'range',
      'startDate', substr(cache.scope_key, 7, 10),
      'endDate', substr(cache.scope_key, 18, 10),
      'articleCount', json_array_length(json_extract(cache.payload, '$.coverage.analyzedArticleIds')),
      'firstPublishedAt', COALESCE(
        (
          SELECT MIN(article.published_at)
          FROM article
          WHERE article.id IN (
            SELECT value
            FROM json_each(cache.payload, '$.coverage.analyzedArticleIds')
          )
        ),
        json_extract(cache.payload, '$.date') || 'T00:00:00+08:00'
      ),
      'lastPublishedAt', COALESCE(
        (
          SELECT MAX(article.published_at)
          FROM article
          WHERE article.id IN (
            SELECT value
            FROM json_each(cache.payload, '$.coverage.analyzedArticleIds')
          )
        ),
        json_extract(cache.payload, '$.date') || 'T23:59:59+08:00'
      )
    )
  END,
  cache.payload
FROM hotspot_cache AS cache;
