-- Upgrade the existing singleton in place; preserve IDs, content, offsets and inquiry settings.
-- The JSON document separates flow definitions from nodes. nextIds is the only sequence source.
WITH RECURSIVE
legacy AS (
  SELECT n.key AS ordinal, n.value AS body, json_extract(n.value, '$.id') AS id,
    json_extract(n.value, '$.scope') AS scope, json_extract(n.value, '$.parentId') AS parent_id,
    json_extract(n.value, '$.kind') AS kind, json_extract(n.value, '$.startTime') AS start_time
  FROM trading_workflow_config c, json_each(c.nodes) n WHERE c.id = 1 AND json_type(c.nodes) = 'array'
),
flows(id, label) AS (VALUES ('loan', '拆借'), ('reverse', '逆回购'), ('exchange', '交易所回购')),
closing AS (SELECT COALESCE(MIN(ordinal), 999999) AS ordinal FROM legacy WHERE id = 'shared-done' AND parent_id IS NULL),
opening_time AS (SELECT start_time FROM legacy WHERE scope = 'shared' AND parent_id IS NULL AND ordinal < (SELECT ordinal FROM closing) AND start_time IS NOT NULL ORDER BY ordinal LIMIT 1),
prefix AS (
  SELECT f.id, COALESCE(MIN(l.ordinal), 999999) AS cutoff FROM flows f LEFT JOIN legacy l ON l.scope = f.id AND l.parent_id IS NULL
    AND (l.kind <> 'task' OR l.start_time IS NULL OR (SELECT start_time FROM opening_time) IS NULL OR l.start_time >= (SELECT start_time FROM opening_time)) GROUP BY f.id
),
paths AS (
  SELECT f.id AS flow, l.id, l.ordinal,
    CASE WHEN l.scope = 'shared' THEN CASE WHEN l.ordinal < (SELECT ordinal FROM closing) THEN 1 ELSE 3 END
      WHEN l.ordinal < p.cutoff THEN 0 ELSE 2 END AS segment
  FROM flows f JOIN prefix p ON p.id = f.id JOIN legacy l ON l.parent_id IS NULL AND (l.scope = f.id OR l.scope = 'shared')
),
main_edges AS (SELECT id AS source, LEAD(id) OVER (PARTITION BY flow ORDER BY segment, ordinal) AS target FROM paths),
children AS (SELECT *, LAG(id) OVER (PARTITION BY scope, parent_id ORDER BY ordinal) AS previous FROM legacy WHERE parent_id IS NOT NULL),
edges AS (
  SELECT source, target FROM main_edges WHERE target IS NOT NULL
  UNION SELECT COALESCE(previous, parent_id), id FROM children
),
reachable(source, target) AS (
  SELECT source, target FROM edges UNION SELECT r.source, e.target FROM reachable r JOIN edges e ON e.source = r.target
),
filtered AS (
  SELECT e.source, e.target FROM edges e WHERE NOT (
    EXISTS (SELECT 1 FROM legacy WHERE id = e.source AND scope = 'shared' AND parent_id IS NULL)
    AND EXISTS (SELECT 1 FROM legacy WHERE id = e.target AND scope = 'shared' AND parent_id IS NULL)
    AND EXISTS (SELECT 1 FROM edges alternative JOIN reachable r ON r.source = alternative.target AND r.target = e.target WHERE alternative.source = e.source AND alternative.target <> e.target)
  )
),
converted AS (
  SELECT ordinal, json_set(json_remove(body, '$.scope'), '$.flowIds', json(CASE WHEN scope = 'shared' THEN '["loan","reverse","exchange"]' ELSE json_array(scope) END),
    '$.nextIds', json((SELECT json_group_array(target) FROM (SELECT target FROM filtered WHERE source = legacy.id ORDER BY target)))) AS body FROM legacy
)
UPDATE trading_workflow_config SET nodes = json_object(
  'flows', json((SELECT json_group_array(json_object('id', id, 'label', label)) FROM flows)),
  'nodes', json((SELECT json_group_array(json(body)) FROM (SELECT body FROM converted ORDER BY ordinal)))
), version = version + 1 WHERE id = 1 AND json_type(nodes) = 'array';
