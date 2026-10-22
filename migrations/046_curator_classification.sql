-- Host-owned, content-bound assessments; no source text or authority labels.
CREATE TABLE curator_classifications (
  workspace TEXT NOT NULL,
  entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  entry_revision INTEGER NOT NULL CHECK(entry_revision > 0),
  input_digest TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  configuration_digest TEXT NOT NULL,
  result_json TEXT NOT NULL,
  result_digest TEXT NOT NULL,
  PRIMARY KEY(workspace,entry_id,entry_revision,input_digest,policy_version,configuration_digest)
);
