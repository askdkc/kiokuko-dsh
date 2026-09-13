-- Rebuildable profile search projection; canonical sessions and run links remain authoritative.
CREATE TABLE akinator_profile_documents (
  id INTEGER PRIMARY KEY,
  run_id TEXT NOT NULL UNIQUE REFERENCES run_intakes(run_id) ON DELETE CASCADE,
  session_id TEXT NOT NULL UNIQUE REFERENCES akinator_sessions(id) ON DELETE CASCADE,
  workspace TEXT NOT NULL,
  repository_id TEXT NOT NULL REFERENCES repositories(repository_id) ON DELETE CASCADE,
  task_text TEXT NOT NULL CHECK(length(task_text) <= 4096),
  target_text TEXT NOT NULL CHECK(length(target_text) <= 1024),
  profile_hash TEXT NOT NULL CHECK(length(profile_hash) = 64),
  sources_hash TEXT NOT NULL CHECK(length(sources_hash) = 64),
  snapshot_hash TEXT NOT NULL CHECK(length(snapshot_hash) = 64),
  version INTEGER NOT NULL CHECK(version = 1),
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_akinator_profile_scope ON akinator_profile_documents(workspace, repository_id, updated_at DESC, id);
CREATE TABLE akinator_profile_signals (
  document_id INTEGER NOT NULL REFERENCES akinator_profile_documents(id) ON DELETE CASCADE,
  workspace TEXT NOT NULL,
  repository_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind = 'target'),
  value TEXT NOT NULL CHECK(length(value) BETWEEN 1 AND 1024),
  PRIMARY KEY(document_id, kind, value)
);
CREATE INDEX idx_akinator_profile_signal ON akinator_profile_signals(workspace, repository_id, kind, value, document_id);
CREATE VIRTUAL TABLE akinator_profile_fts USING fts5(task_text, target_text, content='akinator_profile_documents', content_rowid='id', tokenize='unicode61');
CREATE VIRTUAL TABLE akinator_profile_trigram USING fts5(task_text, target_text, content='akinator_profile_documents', content_rowid='id', tokenize='trigram');
CREATE TRIGGER akinator_profile_insert AFTER INSERT ON akinator_profile_documents BEGIN
  INSERT INTO akinator_profile_fts(rowid, task_text, target_text) VALUES(new.id, new.task_text, new.target_text);
  INSERT INTO akinator_profile_trigram(rowid, task_text, target_text) VALUES(new.id, new.task_text, new.target_text);
END;
CREATE TRIGGER akinator_profile_delete AFTER DELETE ON akinator_profile_documents BEGIN
  INSERT INTO akinator_profile_fts(akinator_profile_fts, rowid, task_text, target_text) VALUES('delete', old.id, old.task_text, old.target_text);
  INSERT INTO akinator_profile_trigram(akinator_profile_trigram, rowid, task_text, target_text) VALUES('delete', old.id, old.task_text, old.target_text);
END;
CREATE TRIGGER akinator_profile_update AFTER UPDATE ON akinator_profile_documents BEGIN
  INSERT INTO akinator_profile_fts(akinator_profile_fts, rowid, task_text, target_text) VALUES('delete', old.id, old.task_text, old.target_text);
  INSERT INTO akinator_profile_trigram(akinator_profile_trigram, rowid, task_text, target_text) VALUES('delete', old.id, old.task_text, old.target_text);
  INSERT INTO akinator_profile_fts(rowid, task_text, target_text) VALUES(new.id, new.task_text, new.target_text);
  INSERT INTO akinator_profile_trigram(rowid, task_text, target_text) VALUES(new.id, new.task_text, new.target_text);
END;
CREATE TABLE akinator_memory_resolutions (
  run_id TEXT PRIMARY KEY REFERENCES run_intakes(run_id) ON DELETE CASCADE,
  base_hash TEXT NOT NULL CHECK(length(base_hash) = 64),
  result_hash TEXT NOT NULL CHECK(length(result_hash) = 64),
  config_json TEXT NOT NULL CHECK(length(config_json) <= 2048 AND json_valid(config_json)),
  result_json TEXT NOT NULL CHECK(length(result_json) <= 65536 AND json_valid(result_json)),
  created_at TEXT NOT NULL
);
CREATE TABLE akinator_memory_resolution_sources (
  run_id TEXT NOT NULL REFERENCES akinator_memory_resolutions(run_id) ON DELETE CASCADE,
  source_run_id TEXT NOT NULL REFERENCES run_intakes(run_id) ON DELETE CASCADE,
  PRIMARY KEY(run_id, source_run_id)
);
-- Do not retain candidate text in audit records after its canonical source is purged.
CREATE TRIGGER akinator_memory_source_purge BEFORE DELETE ON run_intakes BEGIN
  DELETE FROM akinator_memory_resolutions WHERE run_id IN (
    SELECT run_id FROM akinator_memory_resolution_sources WHERE source_run_id = old.run_id
  );
END;
CREATE TABLE akinator_profile_backfill (
  version INTEGER PRIMARY KEY CHECK(version = 1),
  cursor TEXT NOT NULL,
  complete INTEGER NOT NULL CHECK(complete IN (0, 1))
);
INSERT INTO akinator_profile_backfill VALUES(1, '', 0);
-- Out-of-band canonical changes invalidate the projection, never silently refresh trust.
CREATE TRIGGER akinator_profile_session_changed AFTER UPDATE ON akinator_sessions BEGIN
  DELETE FROM akinator_profile_documents WHERE session_id = old.id;
END;
CREATE TRIGGER akinator_profile_link_changed AFTER UPDATE ON run_intakes BEGIN
  DELETE FROM akinator_profile_documents WHERE run_id = old.run_id;
END;
CREATE TRIGGER akinator_profile_metadata_changed AFTER UPDATE OF metadata_json ON ledger_runs
WHEN json_extract(old.metadata_json, '$.kiokukoProjectManifestBinding')
  IS NOT json_extract(new.metadata_json, '$.kiokukoProjectManifestBinding') BEGIN
  DELETE FROM akinator_profile_documents WHERE run_id = old.run_id;
END;
CREATE TRIGGER akinator_profile_scope_guard BEFORE INSERT ON akinator_profile_documents BEGIN
  SELECT RAISE(ABORT, 'profile projection scope mismatch') WHERE NOT EXISTS (
    SELECT 1 FROM run_intakes ri JOIN ledger_runs lr ON lr.run_id = ri.run_id
    JOIN akinator_sessions s ON s.id = ri.session_id
    JOIN repositories r ON r.workspace = lr.workspace
    WHERE ri.run_id = new.run_id AND ri.session_id = new.session_id
      AND lr.workspace = new.workspace AND s.workspace = new.workspace AND r.repository_id = new.repository_id
  );
END;
