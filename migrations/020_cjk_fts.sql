-- Keep word and substring semantics in separate external-content indexes. The
-- application-owned content table contains only each entry's current revision.
DROP TABLE entries_fts;
DROP TABLE entries_trigram;

CREATE TABLE entry_search_documents (
    entry_rowid INTEGER PRIMARY KEY CHECK (entry_rowid > 0),
    entry_id TEXT NOT NULL UNIQUE REFERENCES entries(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    summary TEXT NOT NULL,
    tags_text TEXT NOT NULL
);

CREATE VIRTUAL TABLE entries_fts USING fts5(
    title,
    body,
    summary,
    tags_text,
    content='entry_search_documents',
    content_rowid='entry_rowid',
    tokenize='unicode61 remove_diacritics 2'
);

CREATE VIRTUAL TABLE entries_trigram USING fts5(
    title,
    body,
    summary,
    tags_text,
    content='entry_search_documents',
    content_rowid='entry_rowid',
    tokenize='trigram'
);

CREATE TRIGGER entry_search_documents_ai
AFTER INSERT ON entry_search_documents
BEGIN
    INSERT INTO entries_fts(rowid, title, body, summary, tags_text)
    VALUES (new.entry_rowid, new.title, new.body, new.summary, new.tags_text);
    INSERT INTO entries_trigram(rowid, title, body, summary, tags_text)
    VALUES (new.entry_rowid, new.title, new.body, new.summary, new.tags_text);
END;

CREATE TRIGGER entry_search_documents_ad
AFTER DELETE ON entry_search_documents
BEGIN
    INSERT INTO entries_fts(entries_fts, rowid, title, body, summary, tags_text)
    VALUES ('delete', old.entry_rowid, old.title, old.body, old.summary, old.tags_text);
    INSERT INTO entries_trigram(entries_trigram, rowid, title, body, summary, tags_text)
    VALUES ('delete', old.entry_rowid, old.title, old.body, old.summary, old.tags_text);
END;

CREATE TRIGGER entry_search_documents_au
AFTER UPDATE ON entry_search_documents
BEGIN
    INSERT INTO entries_fts(entries_fts, rowid, title, body, summary, tags_text)
    VALUES ('delete', old.entry_rowid, old.title, old.body, old.summary, old.tags_text);
    INSERT INTO entries_trigram(entries_trigram, rowid, title, body, summary, tags_text)
    VALUES ('delete', old.entry_rowid, old.title, old.body, old.summary, old.tags_text);
    INSERT INTO entries_fts(rowid, title, body, summary, tags_text)
    VALUES (new.entry_rowid, new.title, new.body, new.summary, new.tags_text);
    INSERT INTO entries_trigram(rowid, title, body, summary, tags_text)
    VALUES (new.entry_rowid, new.title, new.body, new.summary, new.tags_text);
END;

INSERT INTO entry_search_documents(entry_rowid, entry_id, title, body, summary, tags_text)
SELECT e.rowid,
       e.id,
       r.title,
       r.body,
       COALESCE(r.summary, ''),
       COALESCE((SELECT group_concat(tag, ' ')
                   FROM entry_revision_tags
                  WHERE entry_id = e.id AND revision = e.current_revision), '')
  FROM entries AS e
  JOIN entry_revisions AS r
    ON r.entry_id = e.id AND r.revision = e.current_revision;

INSERT INTO entries_fts(entries_fts, rank) VALUES ('integrity-check', 1);
INSERT INTO entries_trigram(entries_trigram, rank) VALUES ('integrity-check', 1);
