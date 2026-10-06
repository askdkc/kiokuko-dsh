CREATE TABLE memory_revision_evidence (
 entry_id TEXT NOT NULL, revision INTEGER NOT NULL, workspace TEXT NOT NULL,
 manifest_json TEXT NOT NULL CHECK(json_valid(manifest_json)),
 manifest_digest TEXT NOT NULL CHECK(length(manifest_digest)=64 AND manifest_digest NOT GLOB '*[^a-f0-9]*'),
 PRIMARY KEY(entry_id,revision),
 FOREIGN KEY(entry_id,revision) REFERENCES entry_revisions(entry_id,revision) ON DELETE CASCADE
);
CREATE TRIGGER memory_revision_evidence_workspace BEFORE INSERT ON memory_revision_evidence
WHEN NOT EXISTS(SELECT 1 FROM entry_revisions r WHERE r.entry_id=NEW.entry_id AND r.revision=NEW.revision AND r.workspace=NEW.workspace)
BEGIN SELECT RAISE(ABORT,'memory evidence workspace mismatch'); END;
CREATE TRIGGER memory_revision_evidence_immutable BEFORE UPDATE ON memory_revision_evidence
BEGIN SELECT RAISE(ABORT,'memory evidence is immutable'); END;
ALTER TABLE dsh_memory_finalizations ADD COLUMN evidence_contract_version INTEGER NOT NULL DEFAULT 3 CHECK(evidence_contract_version IN (3,4));
CREATE TRIGGER finalizer_evidence_contract_immutable BEFORE UPDATE OF evidence_contract_version ON dsh_memory_finalizations
BEGIN SELECT RAISE(ABORT,'finalizer evidence contract is immutable'); END;
