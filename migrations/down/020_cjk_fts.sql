-- Manual rollback for migration 020. Run only after stopping every Kiokuko
-- process and backing up the database.
BEGIN IMMEDIATE;

DROP TRIGGER entry_search_documents_au;
DROP TRIGGER entry_search_documents_ad;
DROP TRIGGER entry_search_documents_ai;
DROP TABLE entries_trigram;
DROP TABLE entries_fts;

CREATE VIRTUAL TABLE entries_fts USING fts5(
    title,
    body,
    summary,
    tags_text,
    tokenize='unicode61 remove_diacritics 2'
);

CREATE VIRTUAL TABLE entries_trigram USING fts5(
    title,
    body,
    summary,
    tags_text,
    tokenize='trigram'
);

INSERT INTO entries_fts(rowid, title, body, summary, tags_text)
SELECT entry_rowid, title, body, summary, tags_text
  FROM entry_search_documents;

INSERT INTO entries_trigram(rowid, title, body, summary, tags_text)
SELECT entry_rowid, title, body, summary, tags_text
  FROM entry_search_documents;

DROP TABLE entry_search_documents;

DELETE FROM schema_migrations WHERE version = 20 AND name = '020_cjk_fts.sql';
COMMIT;
