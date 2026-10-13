CREATE TABLE dsh_memory_observations (
  workspace TEXT NOT NULL,
  producer TEXT NOT NULL,
  event_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  source_key TEXT NOT NULL,
  source_revision INTEGER NOT NULL CHECK(source_revision >= 0),
  tombstone INTEGER NOT NULL CHECK(tombstone IN (0,1)),
  host_verified INTEGER NOT NULL CHECK(host_verified IN (0,1)),
  observation_json TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(workspace,producer,event_id,source_revision),
  UNIQUE(workspace,producer,source_key,source_revision)
);
CREATE INDEX dsh_memory_observation_sources ON dsh_memory_observations(workspace,producer,source_key,source_revision DESC);
CREATE INDEX dsh_memory_observation_sessions ON dsh_memory_observations(workspace,session_id,created_at DESC);
CREATE TABLE dsh_memory_routine_revisions (
  workspace TEXT NOT NULL,
  candidate_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision > 0),
  candidate_json TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(workspace,candidate_id,revision)
);

CREATE INDEX dsh_memory_observation_recent ON dsh_memory_observations(workspace,created_at DESC,event_id DESC);
CREATE INDEX dsh_memory_routine_recent ON dsh_memory_routine_revisions(workspace,created_at DESC);
CREATE TABLE dsh_memory_principle_sources (
  workspace TEXT NOT NULL,
  candidate_id TEXT NOT NULL,
  entry_id TEXT NOT NULL UNIQUE REFERENCES entries(id),
  candidate_hash TEXT NOT NULL,
  sources_json TEXT NOT NULL,
  active INTEGER NOT NULL CHECK(active IN (0,1)),
  PRIMARY KEY(workspace,candidate_id)
);

-- Domain revisions exclude ledger/recorder/audit traffic on the same database.
CREATE TABLE dsh_memory_processing_state (
  workspace TEXT PRIMARY KEY,
  source_revision INTEGER NOT NULL DEFAULT 0,
  context_revision INTEGER NOT NULL DEFAULT 0,
  processed_revision INTEGER NOT NULL DEFAULT -1,
  processed_limit INTEGER NOT NULL DEFAULT 0
);
-- Terminal source eligibility may change on a real resume; sequence/audit
-- updates alone must leave cached context untouched.
CREATE TRIGGER lifecycle_reference_run_status AFTER UPDATE OF status,workspace ON ledger_runs
WHEN OLD.status IS NOT NEW.status OR OLD.workspace IS NOT NEW.workspace BEGIN
  INSERT INTO dsh_memory_processing_state(workspace,context_revision) VALUES('global',1)
    ON CONFLICT(workspace) DO UPDATE SET context_revision=context_revision+1;
END;
CREATE TRIGGER lifecycle_version_dsh_memory_observations_insert AFTER INSERT ON dsh_memory_observations BEGIN
  INSERT INTO dsh_memory_processing_state(workspace,source_revision,context_revision) VALUES(NEW.workspace,1,1)
    ON CONFLICT(workspace) DO UPDATE SET source_revision=source_revision+1,context_revision=context_revision+1;
  INSERT INTO dsh_memory_processing_state(workspace,context_revision) SELECT 'global',1 WHERE NEW.workspace<>'global'
    ON CONFLICT(workspace) DO UPDATE SET context_revision=context_revision+1;
END;
CREATE TRIGGER lifecycle_version_dsh_memory_observations_update AFTER UPDATE ON dsh_memory_observations BEGIN
  INSERT INTO dsh_memory_processing_state(workspace,source_revision,context_revision) VALUES(NEW.workspace,1,1)
    ON CONFLICT(workspace) DO UPDATE SET source_revision=source_revision+1,context_revision=context_revision+1;
  INSERT INTO dsh_memory_processing_state(workspace,context_revision) SELECT 'global',1 WHERE NEW.workspace<>'global'
    ON CONFLICT(workspace) DO UPDATE SET context_revision=context_revision+1;
END;
CREATE TRIGGER lifecycle_version_dsh_memory_observations_delete AFTER DELETE ON dsh_memory_observations BEGIN
  INSERT INTO dsh_memory_processing_state(workspace,source_revision,context_revision) VALUES(OLD.workspace,1,1)
    ON CONFLICT(workspace) DO UPDATE SET source_revision=source_revision+1,context_revision=context_revision+1;
  INSERT INTO dsh_memory_processing_state(workspace,context_revision) SELECT 'global',1 WHERE OLD.workspace<>'global'
    ON CONFLICT(workspace) DO UPDATE SET context_revision=context_revision+1;
END;
CREATE TRIGGER lifecycle_version_memory_capture_exclusions_insert AFTER INSERT ON memory_capture_exclusions BEGIN
  INSERT INTO dsh_memory_processing_state(workspace,source_revision,context_revision) VALUES(NEW.workspace,1,1)
    ON CONFLICT(workspace) DO UPDATE SET source_revision=source_revision+1,context_revision=context_revision+1;
  INSERT INTO dsh_memory_processing_state(workspace,context_revision) SELECT 'global',1 WHERE NEW.workspace<>'global'
    ON CONFLICT(workspace) DO UPDATE SET context_revision=context_revision+1;
END;
CREATE TRIGGER lifecycle_version_memory_capture_exclusions_update AFTER UPDATE ON memory_capture_exclusions BEGIN
  INSERT INTO dsh_memory_processing_state(workspace,source_revision,context_revision) VALUES(NEW.workspace,1,1)
    ON CONFLICT(workspace) DO UPDATE SET source_revision=source_revision+1,context_revision=context_revision+1;
  INSERT INTO dsh_memory_processing_state(workspace,context_revision) SELECT 'global',1 WHERE NEW.workspace<>'global'
    ON CONFLICT(workspace) DO UPDATE SET context_revision=context_revision+1;
END;
CREATE TRIGGER lifecycle_version_memory_capture_exclusions_delete AFTER DELETE ON memory_capture_exclusions BEGIN
  INSERT INTO dsh_memory_processing_state(workspace,source_revision,context_revision) VALUES(OLD.workspace,1,1)
    ON CONFLICT(workspace) DO UPDATE SET source_revision=source_revision+1,context_revision=context_revision+1;
  INSERT INTO dsh_memory_processing_state(workspace,context_revision) SELECT 'global',1 WHERE OLD.workspace<>'global'
    ON CONFLICT(workspace) DO UPDATE SET context_revision=context_revision+1;
END;
CREATE TRIGGER lifecycle_version_dsh_memory_routine_revisions_insert AFTER INSERT ON dsh_memory_routine_revisions BEGIN
  INSERT INTO dsh_memory_processing_state(workspace,source_revision,context_revision) VALUES(NEW.workspace,0,1)
    ON CONFLICT(workspace) DO UPDATE SET source_revision=source_revision+0,context_revision=context_revision+1;
  INSERT INTO dsh_memory_processing_state(workspace,context_revision) SELECT 'global',1 WHERE NEW.workspace<>'global'
    ON CONFLICT(workspace) DO UPDATE SET context_revision=context_revision+1;
END;
CREATE TRIGGER lifecycle_version_dsh_memory_routine_revisions_update AFTER UPDATE ON dsh_memory_routine_revisions BEGIN
  INSERT INTO dsh_memory_processing_state(workspace,source_revision,context_revision) VALUES(NEW.workspace,0,1)
    ON CONFLICT(workspace) DO UPDATE SET source_revision=source_revision+0,context_revision=context_revision+1;
  INSERT INTO dsh_memory_processing_state(workspace,context_revision) SELECT 'global',1 WHERE NEW.workspace<>'global'
    ON CONFLICT(workspace) DO UPDATE SET context_revision=context_revision+1;
END;
CREATE TRIGGER lifecycle_version_dsh_memory_routine_revisions_delete AFTER DELETE ON dsh_memory_routine_revisions BEGIN
  INSERT INTO dsh_memory_processing_state(workspace,source_revision,context_revision) VALUES(OLD.workspace,0,1)
    ON CONFLICT(workspace) DO UPDATE SET source_revision=source_revision+0,context_revision=context_revision+1;
  INSERT INTO dsh_memory_processing_state(workspace,context_revision) SELECT 'global',1 WHERE OLD.workspace<>'global'
    ON CONFLICT(workspace) DO UPDATE SET context_revision=context_revision+1;
END;
CREATE TRIGGER lifecycle_reference_dsh_memory_principle_sources_insert AFTER INSERT ON dsh_memory_principle_sources BEGIN
  INSERT INTO dsh_memory_processing_state(workspace,context_revision) VALUES('global',1)
    ON CONFLICT(workspace) DO UPDATE SET context_revision=context_revision+1;
END;
CREATE TRIGGER lifecycle_reference_dsh_memory_principle_sources_update AFTER UPDATE ON dsh_memory_principle_sources BEGIN
  INSERT INTO dsh_memory_processing_state(workspace,context_revision) VALUES('global',1)
    ON CONFLICT(workspace) DO UPDATE SET context_revision=context_revision+1;
END;
CREATE TRIGGER lifecycle_reference_dsh_memory_principle_sources_delete AFTER DELETE ON dsh_memory_principle_sources BEGIN
  INSERT INTO dsh_memory_processing_state(workspace,context_revision) VALUES('global',1)
    ON CONFLICT(workspace) DO UPDATE SET context_revision=context_revision+1;
END;
CREATE TRIGGER lifecycle_reference_entries_insert AFTER INSERT ON entries BEGIN
  INSERT INTO dsh_memory_processing_state(workspace,context_revision) VALUES('global',1)
    ON CONFLICT(workspace) DO UPDATE SET context_revision=context_revision+1;
END;
CREATE TRIGGER lifecycle_reference_entries_update AFTER UPDATE ON entries BEGIN
  INSERT INTO dsh_memory_processing_state(workspace,context_revision) VALUES('global',1)
    ON CONFLICT(workspace) DO UPDATE SET context_revision=context_revision+1;
END;
CREATE TRIGGER lifecycle_reference_entries_delete AFTER DELETE ON entries BEGIN
  INSERT INTO dsh_memory_processing_state(workspace,context_revision) VALUES('global',1)
    ON CONFLICT(workspace) DO UPDATE SET context_revision=context_revision+1;
END;
CREATE TRIGGER lifecycle_reference_entry_revisions_insert AFTER INSERT ON entry_revisions BEGIN
  INSERT INTO dsh_memory_processing_state(workspace,context_revision) VALUES('global',1)
    ON CONFLICT(workspace) DO UPDATE SET context_revision=context_revision+1;
END;
CREATE TRIGGER lifecycle_reference_entry_revisions_update AFTER UPDATE ON entry_revisions BEGIN
  INSERT INTO dsh_memory_processing_state(workspace,context_revision) VALUES('global',1)
    ON CONFLICT(workspace) DO UPDATE SET context_revision=context_revision+1;
END;
CREATE TRIGGER lifecycle_reference_entry_revisions_delete AFTER DELETE ON entry_revisions BEGIN
  INSERT INTO dsh_memory_processing_state(workspace,context_revision) VALUES('global',1)
    ON CONFLICT(workspace) DO UPDATE SET context_revision=context_revision+1;
END;
CREATE TRIGGER lifecycle_reference_entry_revision_tags_insert AFTER INSERT ON entry_revision_tags BEGIN
  INSERT INTO dsh_memory_processing_state(workspace,context_revision) VALUES('global',1)
    ON CONFLICT(workspace) DO UPDATE SET context_revision=context_revision+1;
END;
CREATE TRIGGER lifecycle_reference_entry_revision_tags_update AFTER UPDATE ON entry_revision_tags BEGIN
  INSERT INTO dsh_memory_processing_state(workspace,context_revision) VALUES('global',1)
    ON CONFLICT(workspace) DO UPDATE SET context_revision=context_revision+1;
END;
CREATE TRIGGER lifecycle_reference_entry_revision_tags_delete AFTER DELETE ON entry_revision_tags BEGIN
  INSERT INTO dsh_memory_processing_state(workspace,context_revision) VALUES('global',1)
    ON CONFLICT(workspace) DO UPDATE SET context_revision=context_revision+1;
END;
CREATE TRIGGER lifecycle_reference_context_feedback_insert AFTER INSERT ON context_feedback BEGIN
  INSERT INTO dsh_memory_processing_state(workspace,context_revision) VALUES('global',1)
    ON CONFLICT(workspace) DO UPDATE SET context_revision=context_revision+1;
END;
CREATE TRIGGER lifecycle_reference_context_feedback_update AFTER UPDATE ON context_feedback BEGIN
  INSERT INTO dsh_memory_processing_state(workspace,context_revision) VALUES('global',1)
    ON CONFLICT(workspace) DO UPDATE SET context_revision=context_revision+1;
END;
CREATE TRIGGER lifecycle_reference_context_feedback_delete AFTER DELETE ON context_feedback BEGIN
  INSERT INTO dsh_memory_processing_state(workspace,context_revision) VALUES('global',1)
    ON CONFLICT(workspace) DO UPDATE SET context_revision=context_revision+1;
END;
CREATE TRIGGER lifecycle_reference_auto_global_projections_insert AFTER INSERT ON auto_global_projections BEGIN
  INSERT INTO dsh_memory_processing_state(workspace,context_revision) VALUES('global',1)
    ON CONFLICT(workspace) DO UPDATE SET context_revision=context_revision+1;
END;
CREATE TRIGGER lifecycle_reference_auto_global_projections_update AFTER UPDATE ON auto_global_projections BEGIN
  INSERT INTO dsh_memory_processing_state(workspace,context_revision) VALUES('global',1)
    ON CONFLICT(workspace) DO UPDATE SET context_revision=context_revision+1;
END;
CREATE TRIGGER lifecycle_reference_auto_global_projections_delete AFTER DELETE ON auto_global_projections BEGIN
  INSERT INTO dsh_memory_processing_state(workspace,context_revision) VALUES('global',1)
    ON CONFLICT(workspace) DO UPDATE SET context_revision=context_revision+1;
END;
CREATE TRIGGER lifecycle_reference_auto_global_application_receipts_insert AFTER INSERT ON auto_global_application_receipts BEGIN
  INSERT INTO dsh_memory_processing_state(workspace,context_revision) VALUES('global',1)
    ON CONFLICT(workspace) DO UPDATE SET context_revision=context_revision+1;
END;
CREATE TRIGGER lifecycle_reference_auto_global_application_receipts_update AFTER UPDATE ON auto_global_application_receipts BEGIN
  INSERT INTO dsh_memory_processing_state(workspace,context_revision) VALUES('global',1)
    ON CONFLICT(workspace) DO UPDATE SET context_revision=context_revision+1;
END;
CREATE TRIGGER lifecycle_reference_auto_global_application_receipts_delete AFTER DELETE ON auto_global_application_receipts BEGIN
  INSERT INTO dsh_memory_processing_state(workspace,context_revision) VALUES('global',1)
    ON CONFLICT(workspace) DO UPDATE SET context_revision=context_revision+1;
END;
CREATE TRIGGER lifecycle_reference_memory_forget_tombstones_insert AFTER INSERT ON memory_forget_tombstones BEGIN
  INSERT INTO dsh_memory_processing_state(workspace,context_revision) VALUES('global',1)
    ON CONFLICT(workspace) DO UPDATE SET context_revision=context_revision+1;
END;
CREATE TRIGGER lifecycle_reference_memory_forget_tombstones_update AFTER UPDATE ON memory_forget_tombstones BEGIN
  INSERT INTO dsh_memory_processing_state(workspace,context_revision) VALUES('global',1)
    ON CONFLICT(workspace) DO UPDATE SET context_revision=context_revision+1;
END;
CREATE TRIGGER lifecycle_reference_memory_forget_tombstones_delete AFTER DELETE ON memory_forget_tombstones BEGIN
  INSERT INTO dsh_memory_processing_state(workspace,context_revision) VALUES('global',1)
    ON CONFLICT(workspace) DO UPDATE SET context_revision=context_revision+1;
END;
CREATE TRIGGER lifecycle_reference_memory_derivations_insert AFTER INSERT ON memory_derivations BEGIN
  INSERT INTO dsh_memory_processing_state(workspace,context_revision) VALUES('global',1)
    ON CONFLICT(workspace) DO UPDATE SET context_revision=context_revision+1;
END;
CREATE TRIGGER lifecycle_reference_memory_derivations_update AFTER UPDATE ON memory_derivations BEGIN
  INSERT INTO dsh_memory_processing_state(workspace,context_revision) VALUES('global',1)
    ON CONFLICT(workspace) DO UPDATE SET context_revision=context_revision+1;
END;
CREATE TRIGGER lifecycle_reference_memory_derivations_delete AFTER DELETE ON memory_derivations BEGIN
  INSERT INTO dsh_memory_processing_state(workspace,context_revision) VALUES('global',1)
    ON CONFLICT(workspace) DO UPDATE SET context_revision=context_revision+1;
END;
CREATE TRIGGER lifecycle_reference_memory_evolution_settings_insert AFTER INSERT ON memory_evolution_settings BEGIN
  INSERT INTO dsh_memory_processing_state(workspace,context_revision) VALUES('global',1)
    ON CONFLICT(workspace) DO UPDATE SET context_revision=context_revision+1;
END;
CREATE TRIGGER lifecycle_reference_memory_evolution_settings_update AFTER UPDATE ON memory_evolution_settings BEGIN
  INSERT INTO dsh_memory_processing_state(workspace,context_revision) VALUES('global',1)
    ON CONFLICT(workspace) DO UPDATE SET context_revision=context_revision+1;
END;
CREATE TRIGGER lifecycle_reference_memory_evolution_settings_delete AFTER DELETE ON memory_evolution_settings BEGIN
  INSERT INTO dsh_memory_processing_state(workspace,context_revision) VALUES('global',1)
    ON CONFLICT(workspace) DO UPDATE SET context_revision=context_revision+1;
END;
CREATE TRIGGER lifecycle_reference_memory_index_facts_insert AFTER INSERT ON memory_index_facts BEGIN
  INSERT INTO dsh_memory_processing_state(workspace,context_revision) VALUES('global',1)
    ON CONFLICT(workspace) DO UPDATE SET context_revision=context_revision+1;
END;
CREATE TRIGGER lifecycle_reference_memory_index_facts_update AFTER UPDATE ON memory_index_facts BEGIN
  INSERT INTO dsh_memory_processing_state(workspace,context_revision) VALUES('global',1)
    ON CONFLICT(workspace) DO UPDATE SET context_revision=context_revision+1;
END;
CREATE TRIGGER lifecycle_reference_memory_index_facts_delete AFTER DELETE ON memory_index_facts BEGIN
  INSERT INTO dsh_memory_processing_state(workspace,context_revision) VALUES('global',1)
    ON CONFLICT(workspace) DO UPDATE SET context_revision=context_revision+1;
END;
CREATE TRIGGER lifecycle_reference_memory_index_settings_insert AFTER INSERT ON memory_index_settings BEGIN
  INSERT INTO dsh_memory_processing_state(workspace,context_revision) VALUES('global',1)
    ON CONFLICT(workspace) DO UPDATE SET context_revision=context_revision+1;
END;
CREATE TRIGGER lifecycle_reference_memory_index_settings_update AFTER UPDATE ON memory_index_settings BEGIN
  INSERT INTO dsh_memory_processing_state(workspace,context_revision) VALUES('global',1)
    ON CONFLICT(workspace) DO UPDATE SET context_revision=context_revision+1;
END;
CREATE TRIGGER lifecycle_reference_memory_index_settings_delete AFTER DELETE ON memory_index_settings BEGIN
  INSERT INTO dsh_memory_processing_state(workspace,context_revision) VALUES('global',1)
    ON CONFLICT(workspace) DO UPDATE SET context_revision=context_revision+1;
END;
CREATE TRIGGER lifecycle_reference_memory_index_sources_insert AFTER INSERT ON memory_index_sources BEGIN
  INSERT INTO dsh_memory_processing_state(workspace,context_revision) VALUES('global',1)
    ON CONFLICT(workspace) DO UPDATE SET context_revision=context_revision+1;
END;
CREATE TRIGGER lifecycle_reference_memory_index_sources_update AFTER UPDATE ON memory_index_sources BEGIN
  INSERT INTO dsh_memory_processing_state(workspace,context_revision) VALUES('global',1)
    ON CONFLICT(workspace) DO UPDATE SET context_revision=context_revision+1;
END;
CREATE TRIGGER lifecycle_reference_memory_index_sources_delete AFTER DELETE ON memory_index_sources BEGIN
  INSERT INTO dsh_memory_processing_state(workspace,context_revision) VALUES('global',1)
    ON CONFLICT(workspace) DO UPDATE SET context_revision=context_revision+1;
END;
CREATE TRIGGER lifecycle_reference_external_skill_entries_insert AFTER INSERT ON external_skill_entries BEGIN
  INSERT INTO dsh_memory_processing_state(workspace,context_revision) VALUES('global',1)
    ON CONFLICT(workspace) DO UPDATE SET context_revision=context_revision+1;
END;
CREATE TRIGGER lifecycle_reference_external_skill_entries_update AFTER UPDATE ON external_skill_entries BEGIN
  INSERT INTO dsh_memory_processing_state(workspace,context_revision) VALUES('global',1)
    ON CONFLICT(workspace) DO UPDATE SET context_revision=context_revision+1;
END;
CREATE TRIGGER lifecycle_reference_external_skill_entries_delete AFTER DELETE ON external_skill_entries BEGIN
  INSERT INTO dsh_memory_processing_state(workspace,context_revision) VALUES('global',1)
    ON CONFLICT(workspace) DO UPDATE SET context_revision=context_revision+1;
END;
CREATE TRIGGER lifecycle_reference_external_skills_insert AFTER INSERT ON external_skills BEGIN
  INSERT INTO dsh_memory_processing_state(workspace,context_revision) VALUES('global',1)
    ON CONFLICT(workspace) DO UPDATE SET context_revision=context_revision+1;
END;
CREATE TRIGGER lifecycle_reference_external_skills_update AFTER UPDATE ON external_skills BEGIN
  INSERT INTO dsh_memory_processing_state(workspace,context_revision) VALUES('global',1)
    ON CONFLICT(workspace) DO UPDATE SET context_revision=context_revision+1;
END;
CREATE TRIGGER lifecycle_reference_external_skills_delete AFTER DELETE ON external_skills BEGIN
  INSERT INTO dsh_memory_processing_state(workspace,context_revision) VALUES('global',1)
    ON CONFLICT(workspace) DO UPDATE SET context_revision=context_revision+1;
END;
CREATE TRIGGER lifecycle_reference_entry_links_insert AFTER INSERT ON entry_links BEGIN
  INSERT INTO dsh_memory_processing_state(workspace,context_revision) VALUES('global',1)
    ON CONFLICT(workspace) DO UPDATE SET context_revision=context_revision+1;
END;
CREATE TRIGGER lifecycle_reference_entry_links_update AFTER UPDATE ON entry_links BEGIN
  INSERT INTO dsh_memory_processing_state(workspace,context_revision) VALUES('global',1)
    ON CONFLICT(workspace) DO UPDATE SET context_revision=context_revision+1;
END;
CREATE TRIGGER lifecycle_reference_entry_links_delete AFTER DELETE ON entry_links BEGIN
  INSERT INTO dsh_memory_processing_state(workspace,context_revision) VALUES('global',1)
    ON CONFLICT(workspace) DO UPDATE SET context_revision=context_revision+1;
END;
CREATE TRIGGER lifecycle_reference_knowledge_sources_insert AFTER INSERT ON knowledge_sources BEGIN
  INSERT INTO dsh_memory_processing_state(workspace,context_revision) VALUES('global',1)
    ON CONFLICT(workspace) DO UPDATE SET context_revision=context_revision+1;
END;
CREATE TRIGGER lifecycle_reference_knowledge_sources_update AFTER UPDATE ON knowledge_sources BEGIN
  INSERT INTO dsh_memory_processing_state(workspace,context_revision) VALUES('global',1)
    ON CONFLICT(workspace) DO UPDATE SET context_revision=context_revision+1;
END;
CREATE TRIGGER lifecycle_reference_knowledge_sources_delete AFTER DELETE ON knowledge_sources BEGIN
  INSERT INTO dsh_memory_processing_state(workspace,context_revision) VALUES('global',1)
    ON CONFLICT(workspace) DO UPDATE SET context_revision=context_revision+1;
END;
CREATE TRIGGER lifecycle_reference_memory_episodes_insert AFTER INSERT ON memory_episodes BEGIN
  INSERT INTO dsh_memory_processing_state(workspace,context_revision) VALUES('global',1)
    ON CONFLICT(workspace) DO UPDATE SET context_revision=context_revision+1;
END;
CREATE TRIGGER lifecycle_reference_memory_episodes_update AFTER UPDATE ON memory_episodes BEGIN
  INSERT INTO dsh_memory_processing_state(workspace,context_revision) VALUES('global',1)
    ON CONFLICT(workspace) DO UPDATE SET context_revision=context_revision+1;
END;
CREATE TRIGGER lifecycle_reference_memory_episodes_delete AFTER DELETE ON memory_episodes BEGIN
  INSERT INTO dsh_memory_processing_state(workspace,context_revision) VALUES('global',1)
    ON CONFLICT(workspace) DO UPDATE SET context_revision=context_revision+1;
END;
CREATE TRIGGER lifecycle_reference_memory_episode_entries_insert AFTER INSERT ON memory_episode_entries BEGIN
  INSERT INTO dsh_memory_processing_state(workspace,context_revision) VALUES('global',1)
    ON CONFLICT(workspace) DO UPDATE SET context_revision=context_revision+1;
END;
CREATE TRIGGER lifecycle_reference_memory_episode_entries_update AFTER UPDATE ON memory_episode_entries BEGIN
  INSERT INTO dsh_memory_processing_state(workspace,context_revision) VALUES('global',1)
    ON CONFLICT(workspace) DO UPDATE SET context_revision=context_revision+1;
END;
CREATE TRIGGER lifecycle_reference_memory_episode_entries_delete AFTER DELETE ON memory_episode_entries BEGIN
  INSERT INTO dsh_memory_processing_state(workspace,context_revision) VALUES('global',1)
    ON CONFLICT(workspace) DO UPDATE SET context_revision=context_revision+1;
END;
