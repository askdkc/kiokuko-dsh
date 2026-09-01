-- Manual rollback for migration 021. Stop every Kiokuko process and make a
-- full SQLite backup before running this script.
BEGIN IMMEDIATE;

DROP INDEX idx_query_embeddings_lru;
DROP TABLE query_embeddings;
DROP INDEX idx_embedding_jobs_claim;
DROP TABLE embedding_jobs;
DROP INDEX idx_entry_embeddings_profile_revision;
DROP TABLE entry_embeddings;
DROP TABLE embedding_runtime;
DROP TRIGGER embedding_profiles_immutable_update;
DROP TABLE embedding_profiles;

DELETE FROM schema_migrations
 WHERE version = 21 AND name = '021_semantic_embeddings.sql';
COMMIT;
