# Raid Network

Find live raid partners at about your size, see who raids whom, and run **chat-vs-chat duels** on one shared OBS overlay across two Twitch channels.

Runs entirely on **Cloudflare Workers (Workers Paid, $5/mo)** using only the included allowances: one Worker, Static Assets, Durable Objects (SQLite-backed, hibernating WebSockets), D1, KV and a cron trigger. No R2, Queues, Workers AI, Images or Hyperdrive.

```
Browser / OBS ──HTTP/WS──▶ Worker (Hono)  ──▶ Static Assets (Astro + SolidJS, ./dist)
                              │  /api/*  /auth/*  /webhooks/eventsub
                              ├──▶ OverlayDO  (1 per channel: OBS overlay socket + chat router)
                              ├──▶ DuelDO     (1 per duel: board, votes, timer, winner)
                              ├──▶ D1  (users, channels, tokens, raids, duels, duel_votes, clips)
                              └──▶ KV  (sessions, live-streams cache, app token, EventSub dedupe)
Twitch EventSub ─webhook─▶ /webhooks/eventsub (HMAC-verified) ─▶ OverlayDO ─▶ DuelDO
Cron */10 ─▶ Helix GET /streams per tracked game ─▶ KV
```

## Status

| Feature | State |
|---|---|
| Matchmaking dashboard (same game, 0.5×–2× viewers, ranked, Raid + Duel buttons) | ✅ built |
| Raid network map (SVG force graph, draggable, my network / everyone) | ✅ built |
| Duels: invite → accept → countdown → live → winner; Tug of War and Chat Poll modes | ✅ built |
| Shared duel overlay on both channels (`/overlay/:channel`) | ✅ built |
| Twitch OAuth, encrypted token storage, refresh | ✅ built (needs real credentials to test) |
| EventSub webhook (HMAC verify, replay window, dedupe) for stream.online/offline, channel.raid, channel.chat.message | ✅ built |
| Cron cache of live streams per tracked game | ✅ built |
| DEMO_MODE: fake streamers, seeded raid history, chat simulator | ✅ built |
| Raider welcomes | 🟡 stub: overlay card shows on `channel.raid`; chat shout-out TODO |
| Auto-clips (chat-velocity spikes → POST /clips) | ⏳ TODO (hook in `OverlayDO.chat`) |
| Post-stream growth page | ⏳ TODO (`/growth/` placeholder, `/api/growth` 501) |
| `!recap` | ⏳ TODO, last (hook in `OverlayDO.chat`) |

## Run it locally in demo mode (no Twitch account needed)

```bash
npm install
npm run dev          # builds the site, applies D1 migrations locally, starts wrangler dev with DEMO_MODE=true
# open http://localhost:8787  → "Open dashboard"
npm run smoke        # in a second terminal: end-to-end checks (matchmaking, raid, map, both duel modes over WebSocket, signed EventSub)
```

In demo mode you're signed in as **PixelPaladin** (Stardew Valley, ~40 viewers). Use the banner's "Viewing as" picker to switch to any fake streamer.

- **Duel walkthrough:** Dashboard → ⚔ Duel on any card → *Send challenge* → (demo) *Accept duel* → *Start duel* → *Run chat simulator*, or send `!pull` or `!1`–`!4` from the demo chat box. Open both overlay URLs (`/overlay/<login>`) in other tabs or as OBS browser sources to watch them update live.
- **Fake EventSub:** `node scripts/fake-eventsub.mjs chat <login> <id> "!pull"` and `… raid <from_login> <from_id> <to_login> <to_id> 25` send HMAC-signed webhooks using the demo secret.
- **Cron:** `curl "http://localhost:8787/cdn-cgi/handler/scheduled?cron=*/10+*+*+*+*"` (dev runs with `--test-scheduled`).
- `npm run dev:web` runs Astro's dev server on :4321, which proxies `/api` and `/auth` to wrangler on :8787 for hot reload while you change the UI.

Scripts: `npm run typecheck` (tsc for the worker + `astro check`), `npm run build`, `npm run deploy`.

## Going live

### 1. Register the Twitch app
1. Go to https://dev.twitch.tv/console/apps → **Register Your Application**.
2. Name: `Raid Network` (must be unique; add a suffix if it's taken). Category: **Website Integration**. Client type: **Confidential**.
3. OAuth Redirect URLs (add all you'll use):
   - `http://localhost:8787/auth/callback` (local)
   - `https://raid-network.<your-subdomain>.workers.dev/auth/callback` (production; shown after the first deploy)
4. Copy the **Client ID**, then **New Secret** → copy the **Client Secret**.

Scopes requested at sign-in (`worker/lib/helix.ts`):
`user:read:chat user:write:chat user:bot channel:bot channel:manage:raids clips:edit moderator:read:followers`
(`user:bot` is required by Twitch for `channel.chat.message` webhook subscriptions and for sending chat with an app token.)

EventSub webhooks need a public **HTTPS** URL on port 443, so they only work on the deployed Worker, or locally through a tunnel (`cloudflared tunnel --url http://localhost:8787`, with APP_URL set to the tunnel URL).

### 2. Create Cloudflare resources
```bash
npx wrangler login
npx wrangler d1 create raid-network            # paste database_id into wrangler.jsonc
npx wrangler kv namespace create KV            # paste id into wrangler.jsonc
npm run db:migrate:remote
```
Set `vars.APP_URL` in `wrangler.jsonc` to your production URL (e.g. `https://raid-network.<sub>.workers.dev`), leave `DEMO_MODE` as `"false"`, and optionally set `TRACKED_GAME_IDS`.

### 3. Secrets (never committed)
```bash
npx wrangler secret put TWITCH_CLIENT_ID
npx wrangler secret put TWITCH_CLIENT_SECRET
npx wrangler secret put EVENTSUB_SECRET     # random 10-100 chars
npx wrangler secret put TOKEN_ENC_KEY       # node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
npx wrangler secret put BOT_USER_ID         # optional bot account id for reading/sending chat
```
For local live testing, copy `.dev.vars.example` to `.dev.vars` and fill it in, then `npm run dev:live`.

### 4. Deploy
```bash
npm run deploy
```
Sign in with Twitch on the deployed site. Raid Network then subscribes your channel to `stream.online`, `stream.offline`, `channel.raid` (in and out) and `channel.chat.message`. Add `https://<app>/overlay/<your_login>` to OBS as a 1920×1080 browser source.

## Staying inside the $5 plan
- Matchmaking reads the KV cache, never Helix per page view. The cron makes about 6 runs/hour × tracked games × up to `MAX_STREAM_PAGES` Helix calls.
- Overlay/duel sockets use the **WebSocket Hibernation API** with auto-response pings, so idle overlays don't keep DOs billed for duration.
- Duel votes live in the DuelDO's SQLite while a duel runs and are written to D1 in one batch at the end.
- Chat webhooks aren't deduped through KV (that would cost a KV write per message). OverlayDO dedupes them in memory.
- The included Workers Paid quotas are 10M requests/mo, D1 25B row reads / 50M writes, KV 10M reads / 1M writes, and DO 1M requests + 400k GB-s. A hackathon demo uses a tiny fraction.

## Layout
```
worker/index.ts            Hono routes, auth, page-shell rewrites, cron
worker/durable/overlay.ts  OverlayDO: per-channel overlay socket + chat router (+ TODO hooks)
worker/durable/duel.ts     DuelDO: board state, votes, alarms, simulator, D1 persistence
worker/lib/                helix client, tokens (AES-GCM), eventsub, matchmaking, streams cache, demo data
migrations/0001_init.sql   D1 schema
web/                       Astro pages + SolidJS islands (Dashboard, RaidMap, DuelRoom, DuelBoard, Overlay)
shared/types.ts            types shared by worker and UI
scripts/smoke.mjs          end-to-end demo checks; scripts/fake-eventsub.mjs signs test webhooks
```

Notes: OverlayDOs are keyed by channel login (from EventSub's `broadcaster_user_login`). If a streamer renames, their overlay URL changes. Overlay URLs are read-only and unauthenticated.
