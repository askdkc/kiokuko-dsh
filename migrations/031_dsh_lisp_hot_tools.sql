CREATE TABLE dsh_lisp_hot_contracts (
  contract_ref TEXT PRIMARY KEY,
  project_root TEXT NOT NULL,
  name TEXT NOT NULL,
  digest TEXT NOT NULL,
  payload TEXT NOT NULL,
  approved_session TEXT NOT NULL,
  approved_agent TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX dsh_lisp_hot_contract_scope ON dsh_lisp_hot_contracts(project_root, name);
CREATE TABLE dsh_lisp_hot_versions (
  bundle_ref TEXT PRIMARY KEY,
  project_root TEXT NOT NULL,
  name TEXT NOT NULL,
  contract_ref TEXT NOT NULL REFERENCES dsh_lisp_hot_contracts(contract_ref),
  digest TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX dsh_lisp_hot_version_scope ON dsh_lisp_hot_versions(project_root, name);
CREATE TABLE dsh_lisp_hot_heads (
  project_root TEXT NOT NULL,
  name TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
  contract_ref TEXT NOT NULL REFERENCES dsh_lisp_hot_contracts(contract_ref),
  bundle_ref TEXT REFERENCES dsh_lisp_hot_versions(bundle_ref),
  updated_at TEXT NOT NULL,
  PRIMARY KEY(project_root, name)
);
