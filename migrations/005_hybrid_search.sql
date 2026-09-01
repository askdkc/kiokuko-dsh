-- Current-revision hybrid-search projections. Historical revisions are never
-- indexed; application code refreshes these projections after each mutation.
CREATE VIRTUAL TABLE entries_trigram USING fts5(
    title,
    body,
    summary,
    tags_text,
    tokenize='trigram'
);

CREATE TABLE entry_search_signals (
    entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
    signal_type TEXT NOT NULL CHECK (
        signal_type IN ('language', 'framework', 'runtime', 'database', 'tool',
                        'platform', 'package', 'symbol', 'path', 'error', 'command', 'tag')
    ),
    normalized_value TEXT NOT NULL,
    PRIMARY KEY (entry_id, signal_type, normalized_value)
);

CREATE INDEX idx_entry_search_signals_lookup
    ON entry_search_signals(signal_type, normalized_value);

INSERT INTO entries_trigram(rowid, title, body, summary, tags_text)
SELECT e.rowid,
       r.title,
       r.body,
       COALESCE(r.summary, ''),
       COALESCE((SELECT group_concat(tag, ' ')
                   FROM entry_revision_tags
                  WHERE entry_id = e.id AND revision = e.current_revision), '')
  FROM entries AS e
  JOIN entry_revisions AS r
    ON r.entry_id = e.id AND r.revision = e.current_revision;

INSERT INTO entry_search_signals(entry_id, signal_type, normalized_value)
SELECT t.entry_id, 'tag', lower(trim(t.tag))
  FROM entry_revision_tags AS t
  JOIN entries AS e ON e.id = t.entry_id AND e.current_revision = t.revision
 WHERE length(trim(t.tag)) > 0;
