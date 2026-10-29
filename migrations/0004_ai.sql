-- AI co-host (Ollama Cloud, or deterministic templates without a key).

-- Per-channel toggles for each AI feature, plus the daily cap on AI chat messages. Missing row = defaults (all on).
CREATE TABLE IF NOT EXISTS ai_settings (
  channel_id  TEXT PRIMARY KEY,
  welcome     INTEGER NOT NULL DEFAULT 1,   -- personalized raider welcomes
  recap       INTEGER NOT NULL DEFAULT 1,   -- AI-written !recap
  duel        INTEGER NOT NULL DEFAULT 1,   -- duel host lines + AI poll questions
  ask         INTEGER NOT NULL DEFAULT 1,   -- !ask <question>
  pitch       INTEGER NOT NULL DEFAULT 1,   -- "why you'd collab" line on match cards
  daily_cap   INTEGER NOT NULL DEFAULT 150, -- AI chat messages per channel per UTC day
  updated_at  INTEGER NOT NULL
);

-- Daily AI usage counters (assistant requests, pitch batches). day = YYYY-MM-DD (UTC).
CREATE TABLE IF NOT EXISTS ai_usage (
  user_id  TEXT NOT NULL,
  day      TEXT NOT NULL,
  kind     TEXT NOT NULL,
  n        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day, kind)
);
