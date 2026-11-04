-- Run after Ingest and Dashboard read `node` / `claim`; nothing reads or writes `keyword` any more.
DROP INDEX IF EXISTS keyword_topic_idx;
DROP TABLE IF EXISTS keyword;
