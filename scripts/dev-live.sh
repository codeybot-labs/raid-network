#!/usr/bin/env bash
# Local live mode against real Twitch: build, migrate local D1, run wrangler dev with DEMO_MODE=false.
# Secrets come from .dev.vars (never committed). Optional env:
#   EVENTSUB_CALLBACK  public HTTPS base URL (e.g. a cloudflared quick tunnel) for EventSub webhooks
#   TRACKED_GAME_IDS   comma-separated Twitch game ids the cron caches (default: Fortnite, VALORANT, Minecraft, Stardew Valley)
#   PORT               default 8787 (must match the redirect URL registered on the Twitch app)
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f .dev.vars ] || { echo ".dev.vars missing: copy .dev.vars.example and fill it in" >&2; exit 1; }
PORT="${PORT:-8787}"
npm run build
npm run db:migrate:local
args=(--port "$PORT" --ip 127.0.0.1 --test-scheduled
  --var DEMO_MODE:false
  --var "APP_URL:http://localhost:$PORT"
  --var DEV_TOOLS:true
  --var "TRACKED_GAME_IDS:${TRACKED_GAME_IDS:-33214,516575,27471,490744}")
[ -n "${EVENTSUB_CALLBACK:-}" ] && args+=(--var "EVENTSUB_CALLBACK:$EVENTSUB_CALLBACK")
exec npx wrangler dev "${args[@]}"
