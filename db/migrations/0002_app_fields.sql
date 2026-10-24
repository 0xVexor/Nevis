-- 0002_app_fields: what the app gained after 0001 (folders, tags, status, cover, history, flashcards, settings).
-- Mirrors the IndexedDB stores in spike/tiptap/src/db.ts. Applied in a transaction; PRAGMA user_version -> 2.

ALTER TABLE pages ADD COLUMN kind      TEXT NOT NULL DEFAULT 'page' CHECK (kind IN ('page','folder'));  -- a folder only groups pages
ALTER TABLE pages ADD COLUMN status    TEXT CHECK (status IN ('todo','doing','done'));
ALTER TABLE pages ADD COLUMN title_dir TEXT CHECK (title_dir IN ('rtl','ltr'));                          -- NULL = automatic
ALTER TABLE pages ADD COLUMN cover     TEXT;                                                             -- JSON: gradient or attachment

CREATE TABLE page_tags (
  page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  tag     TEXT NOT NULL,
  PRIMARY KEY (page_id, tag)
) WITHOUT ROWID;
CREATE INDEX idx_tags_tag ON page_tags(tag);

-- Page history: the app keeps at most 40 per page, at most one per 10 minutes (pruned by the app).
CREATE TABLE page_versions (
  page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  ts      INTEGER NOT NULL,
  title   TEXT NOT NULL,
  content TEXT NOT NULL,
  PRIMARY KEY (page_id, ts)
) WITHOUT ROWID;

-- Flashcard schedule. card_key = '<page_id>:<hash of the normalized question>'; no FK so a card survives page edits.
CREATE TABLE srs (
  card_key TEXT PRIMARY KEY,
  ease     REAL NOT NULL,
  interval INTEGER NOT NULL,   -- days; 0 = "again", due in minutes
  reps     INTEGER NOT NULL,
  due      INTEGER NOT NULL    -- unix ms
) WITHOUT ROWID;
CREATE INDEX idx_srs_due ON srs(due);

-- App settings that are not page data (backup config, ...). JSON text values.
CREATE TABLE kv (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) WITHOUT ROWID;
