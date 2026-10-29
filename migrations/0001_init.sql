-- Raid Network initial schema (D1 / SQLite). Times are unix epoch milliseconds.

CREATE TABLE IF NOT EXISTS users (
  id                TEXT PRIMARY KEY,          -- Twitch user id
  login             TEXT NOT NULL UNIQUE,
  display_name      TEXT NOT NULL,
  profile_image_url TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS channels (
  id            TEXT PRIMARY KEY,              -- Twitch broadcaster id
  user_id       TEXT REFERENCES users(id) ON DELETE SET NULL,
  login         TEXT NOT NULL,
  display_name  TEXT NOT NULL,
  game_id       TEXT,
  game_name     TEXT,
  language      TEXT,
  tags          TEXT,                          -- JSON array
  is_live       INTEGER NOT NULL DEFAULT 0,
  viewer_count  INTEGER NOT NULL DEFAULT 0,
  title         TEXT,
  started_at    TEXT,
  tracked       INTEGER NOT NULL DEFAULT 0,    -- 1 = signed-in user's channel; cron caches its game
  eventsub_ok   INTEGER NOT NULL DEFAULT 0,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_channels_login ON channels(login);
CREATE INDEX IF NOT EXISTS idx_channels_tracked_game ON channels(tracked, game_id);

CREATE TABLE IF NOT EXISTS tokens (
  user_id           TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  access_token_enc  TEXT NOT NULL,             -- AES-GCM, key = TOKEN_ENC_KEY secret
  refresh_token_enc TEXT NOT NULL,
  scopes            TEXT NOT NULL,
  expires_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS raids (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  from_id     TEXT NOT NULL,
  from_login  TEXT NOT NULL,
  from_name   TEXT,
  to_id       TEXT NOT NULL,
  to_login    TEXT NOT NULL,
  to_name     TEXT,
  viewers     INTEGER NOT NULL DEFAULT 0,
  source      TEXT NOT NULL,                   -- eventsub | button | demo
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_raids_from ON raids(from_id, created_at);
CREATE INDEX IF NOT EXISTS idx_raids_to ON raids(to_id, created_at);

CREATE TABLE IF NOT EXISTS duels (
  id               TEXT PRIMARY KEY,
  challenger_id    TEXT NOT NULL,
  challenger_login TEXT NOT NULL,
  challenger_name  TEXT,
  opponent_id      TEXT NOT NULL,
  opponent_login   TEXT NOT NULL,
  opponent_name    TEXT,
  mode             TEXT NOT NULL,              -- tug | poll
  question         TEXT,
  options          TEXT,                       -- JSON array
  duration_s       INTEGER NOT NULL,
  status           TEXT NOT NULL,              -- pending|accepted|countdown|live|finished|declined|cancelled
  winner           TEXT,                       -- a | b | tie
  score_a          INTEGER NOT NULL DEFAULT 0,
  score_b          INTEGER NOT NULL DEFAULT 0,
  voters_a         INTEGER NOT NULL DEFAULT 0,
  voters_b         INTEGER NOT NULL DEFAULT 0,
  created_at       INTEGER NOT NULL,
  started_at       INTEGER,
  ended_at         INTEGER
);
CREATE INDEX IF NOT EXISTS idx_duels_challenger ON duels(challenger_id, created_at);
CREATE INDEX IF NOT EXISTS idx_duels_opponent ON duels(opponent_id, created_at);

-- Written in one batch by DuelDO when a duel finishes (votes live in the DO while it runs).
CREATE TABLE IF NOT EXISTS duel_votes (
  duel_id     TEXT NOT NULL REFERENCES duels(id) ON DELETE CASCADE,
  voter_id    TEXT NOT NULL,
  voter_login TEXT NOT NULL,
  channel_id  TEXT NOT NULL,
  side        TEXT NOT NULL,                   -- a | b
  choice      TEXT,                            -- poll option index, or null for tug
  weight      INTEGER NOT NULL DEFAULT 1,      -- tug pulls counted
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (duel_id, voter_id)
);

CREATE TABLE IF NOT EXISTS clips (
  id          TEXT PRIMARY KEY,                -- Twitch clip id
  channel_id  TEXT NOT NULL,
  edit_url    TEXT,
  reason      TEXT,                            -- hype | manual | duel
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_clips_channel ON clips(channel_id, created_at);
