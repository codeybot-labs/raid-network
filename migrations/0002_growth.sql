-- Raid welcomes, auto-clips, growth page and !recap.

-- One row per broadcast (Twitch stream id; demo/seed rows use synthetic ids).
CREATE TABLE IF NOT EXISTS streams (
  id            TEXT PRIMARY KEY,
  channel_id    TEXT NOT NULL,
  channel_login TEXT NOT NULL,
  title         TEXT,
  game_name     TEXT,
  started_at    INTEGER NOT NULL,
  ended_at      INTEGER,
  peak_viewers  INTEGER NOT NULL DEFAULT 0,
  messages      INTEGER NOT NULL DEFAULT 0,
  timeline      TEXT,                          -- JSON [{t, msgs, chatters, viewers}] per minute, written by OverlayDO
  source        TEXT NOT NULL DEFAULT 'live',  -- live | demo | seed
  updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_streams_channel ON streams(channel_id, started_at);

-- First time we ever saw a chatter in a channel ("new chatters").
CREATE TABLE IF NOT EXISTS chatters (
  channel_id      TEXT NOT NULL,
  user_id         TEXT NOT NULL,
  login           TEXT NOT NULL,
  first_seen_at   INTEGER NOT NULL,
  first_stream_id TEXT,
  PRIMARY KEY (channel_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_chatters_first ON chatters(channel_id, first_stream_id);

-- Who chatted in which stream (flushed from OverlayDO about once a minute, not per message).
CREATE TABLE IF NOT EXISTS stream_chatters (
  stream_id TEXT NOT NULL,
  user_id   TEXT NOT NULL,
  login     TEXT NOT NULL,
  messages  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (stream_id, user_id)
);

ALTER TABLE clips ADD COLUMN stream_id TEXT;
ALTER TABLE clips ADD COLUMN channel_login TEXT;
ALTER TABLE clips ADD COLUMN url TEXT;
ALTER TABLE clips ADD COLUMN score REAL;           -- hype ratio (window rate / baseline)
ALTER TABLE clips ADD COLUMN quote TEXT;           -- most common message in the hype window
ALTER TABLE clips ADD COLUMN demo INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_clips_stream ON clips(stream_id);

-- Every chat message Raid Network sends (welcomes, recaps), with outcome. Demo mode logs here instead of calling Twitch.
CREATE TABLE IF NOT EXISTS bot_messages (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id        TEXT NOT NULL,
  stream_id         TEXT,
  kind              TEXT NOT NULL,             -- welcome | recap
  text              TEXT NOT NULL,
  status            TEXT NOT NULL,             -- sent | demo | failed | dropped
  twitch_message_id TEXT,
  error             TEXT,
  created_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bot_messages_channel ON bot_messages(channel_id, created_at);
