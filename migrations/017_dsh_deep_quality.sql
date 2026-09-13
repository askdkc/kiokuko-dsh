-- Existing attempts retain NULL and continue to use the version 1 protocol.
ALTER TABLE dsh_deep_attempts ADD COLUMN job_json TEXT CHECK(job_json IS NULL OR json_valid(job_json));
