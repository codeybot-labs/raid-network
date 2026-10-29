-- Per-streamer OBS overlay preferences. Missing row = defaults (board size 'l').
CREATE TABLE IF NOT EXISTS overlay_settings (
  channel_id  TEXT PRIMARY KEY,
  login       TEXT NOT NULL,
  board_size  TEXT NOT NULL DEFAULT 'l' CHECK (board_size IN ('s', 'm', 'l')),
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_overlay_settings_login ON overlay_settings (login);
