-- Multi-streamer duels: free-for-all (3-4 channels) and team battles (up to 4 v 4).
-- duels.challenger_* stays the host and duels.opponent_* the first invitee, so 1v1 rows read as before.

ALTER TABLE duels ADD COLUMN format TEXT NOT NULL DEFAULT '1v1';   -- 1v1 | ffa | teams
ALTER TABLE duels ADD COLUMN race_target INTEGER NOT NULL DEFAULT 0;
ALTER TABLE duels ADD COLUMN results TEXT;                          -- JSON [{key, name, score, voters}] per side, written at finish

-- Every channel in a duel (host included), its side/team and invite status.
CREATE TABLE IF NOT EXISTS duel_channels (
  duel_id       TEXT NOT NULL REFERENCES duels(id) ON DELETE CASCADE,
  channel_id    TEXT NOT NULL,
  login         TEXT NOT NULL,
  display_name  TEXT,
  side          TEXT NOT NULL,                 -- a | b (1v1, teams) or a-d (ffa lanes)
  status        TEXT NOT NULL,                 -- host | pending | accepted | declined | dropped
  score         INTEGER NOT NULL DEFAULT 0,    -- this channel's contribution (pulls or voters)
  voters        INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  responded_at  INTEGER,
  PRIMARY KEY (duel_id, channel_id)
);
CREATE INDEX IF NOT EXISTS idx_duel_channels_channel ON duel_channels(channel_id, created_at);

-- Backfill existing 1v1 duels so every duel has participant rows.
INSERT OR IGNORE INTO duel_channels (duel_id, channel_id, login, display_name, side, status, score, voters, created_at)
  SELECT id, challenger_id, challenger_login, challenger_name, 'a', 'host', score_a, voters_a, created_at FROM duels;
INSERT OR IGNORE INTO duel_channels (duel_id, channel_id, login, display_name, side, status, score, voters, created_at)
  SELECT id, opponent_id, opponent_login, opponent_name, 'b',
    CASE WHEN status = 'pending' THEN 'pending' WHEN status = 'declined' THEN 'declined' ELSE 'accepted' END,
    score_b, voters_b, created_at FROM duels;
