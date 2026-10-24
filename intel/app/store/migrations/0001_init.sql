-- News store: feeds with their poll health, stories (one per clustered event),
-- the outlets that reported each story, and an FTS5 index over stories.
-- Times are Unix epoch seconds (UTC). Only headline, short summary, source,
-- URL and time are kept: never article bodies.

CREATE TABLE feeds (
  id                 TEXT PRIMARY KEY,
  name               TEXT NOT NULL,
  url                TEXT NOT NULL,
  kind               TEXT NOT NULL DEFAULT 'rss',
  category           TEXT NOT NULL,
  region             TEXT,
  terms              TEXT NOT NULL,
  terms_note         TEXT,
  enabled            INTEGER NOT NULL DEFAULT 1,
  etag               TEXT,
  last_modified      TEXT,
  last_attempt_at    INTEGER,
  last_success_at    INTEGER,
  last_status        INTEGER,
  last_error         TEXT,
  consecutive_errors INTEGER NOT NULL DEFAULT 0,
  next_poll_at       INTEGER,
  item_count         INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE stories (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  title          TEXT NOT NULL,
  summary        TEXT NOT NULL DEFAULT '',
  url            TEXT NOT NULL,
  url_hash       TEXT NOT NULL UNIQUE,
  published_at   INTEGER NOT NULL,
  first_seen_at  INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  category       TEXT NOT NULL,
  severity       INTEGER NOT NULL DEFAULT 1,
  lat            REAL,
  lon            REAL,
  geo_confidence REAL,
  place_name     TEXT,
  country_code   TEXT,
  source_count   INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX stories_published_at ON stories (published_at);
CREATE INDEX stories_category ON stories (category);
CREATE INDEX stories_lat_lon ON stories (lat, lon);

CREATE TABLE story_sources (
  id            INTEGER PRIMARY KEY,
  story_id      INTEGER NOT NULL REFERENCES stories (id) ON DELETE CASCADE,
  feed_id       TEXT NOT NULL,
  source_name   TEXT NOT NULL,
  url           TEXT NOT NULL,
  url_hash      TEXT NOT NULL UNIQUE,
  title         TEXT NOT NULL,
  published_at  INTEGER NOT NULL,
  first_seen_at INTEGER NOT NULL
);

CREATE INDEX story_sources_story ON story_sources (story_id);

CREATE VIRTUAL TABLE news_fts USING fts5 (
  title,
  summary,
  place_name,
  content = 'stories',
  content_rowid = 'id',
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TRIGGER stories_fts_insert AFTER INSERT ON stories BEGIN
  INSERT INTO news_fts (rowid, title, summary, place_name)
  VALUES (new.id, new.title, new.summary, coalesce(new.place_name, ''));
END;

CREATE TRIGGER stories_fts_delete AFTER DELETE ON stories BEGIN
  INSERT INTO news_fts (news_fts, rowid, title, summary, place_name)
  VALUES ('delete', old.id, old.title, old.summary, coalesce(old.place_name, ''));
END;

CREATE TRIGGER stories_fts_update AFTER UPDATE OF title, summary, place_name ON stories BEGIN
  INSERT INTO news_fts (news_fts, rowid, title, summary, place_name)
  VALUES ('delete', old.id, old.title, old.summary, coalesce(old.place_name, ''));
  INSERT INTO news_fts (rowid, title, summary, place_name)
  VALUES (new.id, new.title, new.summary, coalesce(new.place_name, ''));
END;
