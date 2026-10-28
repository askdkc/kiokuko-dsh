-- Host-bound per-turn observations and bounded repository-local learning projection.
-- Completion is a lifecycle observation, not a verification claim.
CREATE TABLE repository_learning_turns (
  repository_key TEXT NOT NULL,
  workspace TEXT NOT NULL,
  policy_revision INTEGER NOT NULL,
  session_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  terminal_seq INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  revision INTEGER NOT NULL,
  turn_json TEXT NOT NULL,
  PRIMARY KEY (repository_key, session_id, turn_id),
  UNIQUE (repository_key, revision)
);
CREATE TABLE repository_learning_state (
  repository_key TEXT PRIMARY KEY,
  revision INTEGER NOT NULL,
  snapshot_json TEXT NOT NULL
);
-- Payload-free identities prevent native recovery from recreating erased turns.
CREATE TABLE repository_learning_retired_turns (
  repository_key TEXT NOT NULL,
  session_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  PRIMARY KEY (repository_key, session_id, turn_id)
);
CREATE TABLE repository_learning_pending_admissions (
  repository_key TEXT NOT NULL,
  session_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  PRIMARY KEY (repository_key,session_id,turn_id)
);
-- A global admission epoch conservatively cancels stale in-flight derivations,
-- including jobs that have not yet saved their first row.
CREATE TABLE repository_learning_admission (id INTEGER PRIMARY KEY CHECK(id=1), epoch INTEGER NOT NULL);
INSERT INTO repository_learning_admission VALUES(1,0);
-- Without precise cross-session dependency manifests, invalidate the whole repo.
CREATE TRIGGER repository_learning_exclude_insert AFTER INSERT ON memory_capture_exclusions
BEGIN
  UPDATE repository_learning_admission SET epoch=epoch+1 WHERE id=1;
  UPDATE repository_learning_state SET snapshot_json=json_set(snapshot_json,
    '$.points',json('[]'),'$.tags',json_array(repository_key),
    '$.turnCount',0,'$.omitted',0,'$.outcomeCounts',json('{"completed":0,"failed":0,"cancelled":0,"unknown":0}'))
    WHERE repository_key IN (SELECT repository_key FROM repository_learning_turns WHERE workspace=NEW.workspace AND session_id=NEW.native_session_id);
  INSERT OR IGNORE INTO repository_learning_retired_turns
    SELECT repository_key,session_id,turn_id FROM repository_learning_turns WHERE repository_key IN
    (SELECT repository_key FROM repository_learning_turns WHERE workspace=NEW.workspace AND session_id=NEW.native_session_id);
  DELETE FROM repository_learning_turns WHERE repository_key IN
    (SELECT repository_key FROM repository_learning_turns WHERE workspace=NEW.workspace AND session_id=NEW.native_session_id);
END;
CREATE TRIGGER repository_learning_exclude_update AFTER UPDATE ON memory_capture_exclusions
BEGIN
  UPDATE repository_learning_admission SET epoch=epoch+1 WHERE id=1;
  UPDATE repository_learning_state SET snapshot_json=json_set(snapshot_json,
    '$.points',json('[]'),'$.tags',json_array(repository_key),
    '$.turnCount',0,'$.omitted',0,'$.outcomeCounts',json('{"completed":0,"failed":0,"cancelled":0,"unknown":0}'))
    WHERE repository_key IN (SELECT repository_key FROM repository_learning_turns WHERE workspace=NEW.workspace AND session_id=NEW.native_session_id);
  INSERT OR IGNORE INTO repository_learning_retired_turns
    SELECT repository_key,session_id,turn_id FROM repository_learning_turns WHERE repository_key IN
    (SELECT repository_key FROM repository_learning_turns WHERE workspace=NEW.workspace AND session_id=NEW.native_session_id);
  DELETE FROM repository_learning_turns WHERE repository_key IN
    (SELECT repository_key FROM repository_learning_turns WHERE workspace=NEW.workspace AND session_id=NEW.native_session_id);
END;
