ALTER TABLE agent_task_skill_discovery_attempts RENAME TO agent_task_skill_discovery_attempts_v14;

-- A v14 started attempt belongs to a process that cannot be resumed safely
-- across this schema change. Preserve the row as a terminal, retryable
-- failure before adding the one-active-attempt index below.
UPDATE agent_task_skill_discovery_attempts_v14
SET state = 'failed',
    failure_json = '{"kind":"kiokuko","code":"CONFLICT"}',
    finished_at = started_at
WHERE state = 'started';

CREATE TABLE agent_task_skill_discovery_attempts (
    run_id TEXT NOT NULL REFERENCES ledger_runs(run_id) ON DELETE CASCADE,
    phase TEXT NOT NULL CHECK (phase IN ('intake', 'zenki')),
    request_digest TEXT NOT NULL CHECK (
        typeof(request_digest) = 'text'
        AND length(request_digest) = 64
        AND request_digest NOT GLOB '*[^0-9a-f]*'
    ),
    reserved_query_count INTEGER NOT NULL CHECK (typeof(reserved_query_count) = 'integer' AND reserved_query_count BETWEEN 0 AND 3),
    reserved_selection_count INTEGER NOT NULL CHECK (typeof(reserved_selection_count) = 'integer' AND reserved_selection_count BETWEEN 0 AND 2),
    consumed_query_count INTEGER NOT NULL CHECK (typeof(consumed_query_count) = 'integer' AND consumed_query_count BETWEEN 0 AND 3),
    consumed_selection_count INTEGER NOT NULL CHECK (typeof(consumed_selection_count) = 'integer' AND consumed_selection_count BETWEEN 0 AND 2),
    state TEXT NOT NULL CHECK (state IN ('started', 'completed', 'failed')),
    summary_json TEXT,
    failure_json TEXT,
    started_at TEXT NOT NULL CHECK (typeof(started_at) = 'text' AND length(started_at) > 0),
    finished_at TEXT,
    PRIMARY KEY (run_id, phase, request_digest),
    CHECK (consumed_query_count <= reserved_query_count),
    CHECK (consumed_selection_count <= reserved_selection_count),
    CHECK (
        finished_at IS NULL
        OR (typeof(finished_at) = 'text' AND length(finished_at) > 0 AND finished_at >= started_at)
    ),
    CHECK (
        (state = 'started'
            AND consumed_query_count = 0
            AND consumed_selection_count = 0
            AND summary_json IS NULL
            AND failure_json IS NULL
            AND finished_at IS NULL)
        OR (state = 'completed' AND typeof(summary_json) = 'text' AND failure_json IS NULL AND finished_at IS NOT NULL)
        OR (state = 'failed' AND summary_json IS NULL AND typeof(failure_json) = 'text' AND finished_at IS NOT NULL)
    )
);

INSERT INTO agent_task_skill_discovery_attempts (
    run_id, phase, request_digest,
    reserved_query_count, reserved_selection_count,
    consumed_query_count, consumed_selection_count,
    state, summary_json, failure_json, started_at, finished_at
)
SELECT run_id, phase, request_digest,
       CASE
           WHEN state = 'completed'
            AND json_valid(summary_json)
            AND json_type(CASE WHEN json_valid(summary_json) THEN summary_json ELSE 'null' END, '$.queries') = 'array'
           THEN MIN(3, json_array_length(summary_json, '$.queries'))
           ELSE 3
       END,
       CASE
           WHEN state = 'completed'
            AND json_valid(summary_json)
            AND json_type(CASE WHEN json_valid(summary_json) THEN summary_json ELSE 'null' END, '$.selected') = 'array'
           THEN MIN(2, json_array_length(summary_json, '$.selected'))
           ELSE 2
       END,
       CASE
           WHEN state = 'completed'
            AND json_valid(summary_json)
            AND json_type(CASE WHEN json_valid(summary_json) THEN summary_json ELSE 'null' END, '$.queries') = 'array'
           THEN MIN(3, json_array_length(summary_json, '$.queries'))
           ELSE 3
       END,
       CASE
           WHEN state = 'completed'
            AND json_valid(summary_json)
            AND json_type(CASE WHEN json_valid(summary_json) THEN summary_json ELSE 'null' END, '$.selected') = 'array'
           THEN MIN(2, json_array_length(summary_json, '$.selected'))
           ELSE 2
       END,
       state, summary_json, failure_json, started_at, finished_at
FROM agent_task_skill_discovery_attempts_v14;

DROP TABLE agent_task_skill_discovery_attempts_v14;

CREATE UNIQUE INDEX idx_skill_discovery_attempts_active
ON agent_task_skill_discovery_attempts(run_id, phase)
WHERE state = 'started';
