-- A local process owned by the same OS user and operating in the canonical
-- repository is trusted to resume the repository's single active Enno run.
-- Client sessions are routing metadata, not immutable authorization owners.

DROP TRIGGER IF EXISTS enno_client_binding_update_guard;
