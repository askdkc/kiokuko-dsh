CREATE TABLE akinator_sessions (
    id TEXT PRIMARY KEY,
    workspace TEXT NOT NULL,
    task_text TEXT NOT NULL,
    profile_json TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('active', 'ready', 'exhausted')),
    question_count INTEGER NOT NULL DEFAULT 0 CHECK (question_count >= 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX idx_akinator_sessions_workspace
    ON akinator_sessions(workspace, updated_at DESC);

CREATE TABLE akinator_answers (
    session_id TEXT NOT NULL REFERENCES akinator_sessions(id) ON DELETE CASCADE,
    question_id TEXT NOT NULL,
    answer_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (session_id, question_id)
);

CREATE TABLE knowledge_sources (
    source_id TEXT PRIMARY KEY,
    repository_url TEXT NOT NULL UNIQUE,
    ref_name TEXT NOT NULL,
    commit_sha TEXT NOT NULL,
    document_count INTEGER NOT NULL DEFAULT 0,
    last_synced_at TEXT NOT NULL
);
