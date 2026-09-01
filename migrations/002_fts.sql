CREATE VIRTUAL TABLE entries_fts USING fts5(
    title,
    body,
    summary,
    tags_text,
    tokenize='unicode61 remove_diacritics 2'
);

-- FTS is an application-controlled projection of the current revision. There
-- are deliberately no triggers on entries or tags: historical revisions must
-- never become searchable and projection refreshes must be explicit.
INSERT INTO entries_fts(rowid, title, body, summary, tags_text)
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
