-- User-selected decision backend; scoped to repository and the plugin's base config.
-- Logical request bindings remain immutable in dsh_decision_bindings.
CREATE TABLE dsh_decision_selections (
 repository_root TEXT NOT NULL, base_digest TEXT NOT NULL,
 revision INTEGER NOT NULL CHECK(revision > 0),
 config_json TEXT NOT NULL CHECK(json_valid(config_json)), config_digest TEXT NOT NULL,
 PRIMARY KEY(repository_root,base_digest)
);
