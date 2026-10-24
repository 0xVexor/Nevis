-- 0001_init: pages, attachments, links, full-text search.
-- Applied by the app inside a transaction; PRAGMA user_version is bumped to 1 afterwards.
-- IDs are UUIDv7 (time-ordered TEXT) so they can be generated offline on any device (sync-friendly).

CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) WITHOUT ROWID;
-- seeded by the app: device_id, created_at, app_version

CREATE TABLE pages (
  id             TEXT PRIMARY KEY,
  parent_id      TEXT REFERENCES pages(id) ON DELETE CASCADE,
  title          TEXT NOT NULL DEFAULT '',
  icon           TEXT,
  sort_key       TEXT NOT NULL,                 -- fractional index among siblings
  is_favorite    INTEGER NOT NULL DEFAULT 0 CHECK (is_favorite IN (0,1)),
  content        TEXT NOT NULL DEFAULT '{"type":"doc","content":[]}',  -- TipTap/ProseMirror JSON
  content_schema INTEGER NOT NULL DEFAULT 1,    -- bump when the editor schema changes (needs migration)
  plain_text     TEXT NOT NULL DEFAULT '',      -- normalized text derived from content, feeds FTS
  created_at     INTEGER NOT NULL,              -- unix ms
  updated_at     INTEGER NOT NULL,
  deleted_at     INTEGER                        -- soft delete (trash + future sync tombstone)
) WITHOUT ROWID;

CREATE INDEX idx_pages_parent ON pages(parent_id, sort_key) WHERE deleted_at IS NULL;
CREATE INDEX idx_pages_fav    ON pages(is_favorite)         WHERE is_favorite = 1 AND deleted_at IS NULL;
CREATE INDEX idx_pages_upd    ON pages(updated_at);

-- Derived: rebuilt from content on every save, used for backlinks.
CREATE TABLE page_links (
  source_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  target_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  PRIMARY KEY (source_id, target_id)
) WITHOUT ROWID;
CREATE INDEX idx_links_target ON page_links(target_id);

-- Attachments are content-addressed files on disk: <data>/files/<sha256[0:2]>/<sha256>
CREATE TABLE attachments (
  id            TEXT PRIMARY KEY,
  sha256        TEXT NOT NULL,
  mime          TEXT NOT NULL,
  size          INTEGER NOT NULL,
  original_name TEXT,
  created_at    INTEGER NOT NULL
) WITHOUT ROWID;
CREATE UNIQUE INDEX idx_att_sha ON attachments(sha256);

CREATE TABLE page_attachments (
  page_id       TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  attachment_id TEXT NOT NULL REFERENCES attachments(id),
  PRIMARY KEY (page_id, attachment_id)
) WITHOUT ROWID;
CREATE INDEX idx_pa_att ON page_attachments(attachment_id);

-- Full-text search. Text is normalized by the app before insert and before query
-- (Arabic ي/ك -> ی/ک, digits -> ASCII, ZWNJ -> space), so the tokenizer stays standard.
CREATE VIRTUAL TABLE pages_fts USING fts5(
  title, body,
  content = '',                 -- contentless: we feed it ourselves, no duplicate storage
  contentless_delete = 1,       -- allows DELETE by rowid
  tokenize = 'unicode61 remove_diacritics 2',
  prefix = '2 3'
);
-- rowid of pages_fts = pages.rowid is unavailable (WITHOUT ROWID), so the app keeps this map:
CREATE TABLE fts_map (
  rowid   INTEGER PRIMARY KEY AUTOINCREMENT,
  page_id TEXT NOT NULL UNIQUE REFERENCES pages(id) ON DELETE CASCADE
);
