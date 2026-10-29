# Raid Network

Find live raid partners at about your size, see who raids whom, and run **chat-vs-chat duels** on one shared OBS overlay across two Twitch channels.

Runs entirely on **Cloudflare Workers (Workers Paid, $5/mo)** using only the included allowances: one Worker, Static Assets, Durable Objects (SQLite-backed, hibernating WebSockets), D1, KV and a cron trigger. No R2, Queues, Workers AI, Images or Hyperdrive.

```
Browser / OBS ──HTTP/WS──▶ Worker (Hono)  ──▶ Static Assets (Astro + SolidJS, ./dist)
                              │  /api/*  /auth/*  /webhooks/eventsub
                              ├──▶ OverlayDO  (1 per channel: overlay socket, chat router, hype detector,
                              │                stream session, welcomes, !recap; flushes to D1 ~1×/min)
                              ├──▶ DuelDO     (1 per duel: board, votes, timer, winner)
                              ├──▶ D1  (users, channels, tokens, raids, duels, duel_votes, clips, streams,
                              │        chatters, stream_chatters, bot_messages)
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
| Cron cache of live streams per tracked game | ✅ verified against real Helix (follows cursors past short pages, dedupes) |
| DEMO_MODE: fake streamers, seeded raid history, chat simulator | ✅ built |
| Raider welcomes: overlay card (first raid / raid #n, their game) + chat shout-out via `POST /chat/messages` | ✅ built (chat send mocked in demo) |
| Auto-clips: chat-velocity hype detector → `POST /clips` → clip card on overlay, stored in D1 | ✅ built (Helix call mocked in demo) |
| Post-stream growth page `/growth/` (new vs returning chatters, raids in/out, clips, duel results, timeline chart, bot log) | ✅ built |
| `!recap`: chat reply + overlay card (uptime, raids in, top clip, duels, new chatters), 60 s per-channel cooldown | ✅ built (chat send mocked in demo) |
| Self-hosted fonts (Fontsource, OFL; no Google Fonts requests) | ✅ built |

## Run it locally in demo mode (no Twitch account needed)

```bash
npm install
npm run dev          # builds the site, applies D1 migrations locally, starts wrangler dev with DEMO_MODE=true
# open http://localhost:8787  → "Open dashboard"
npm run smoke        # in a second terminal: end-to-end checks (matchmaking, raid, map, both duel modes, signed EventSub, welcomes, auto-clips, !recap, growth report, fonts)
```

In demo mode you're signed in as **PixelPaladin** (Stardew Valley, ~40 viewers). Use the banner's "Viewing as" picker to switch to any fake streamer.

- **Duel walkthrough:** Dashboard → ⚔ Duel on any card → *Send challenge* → (demo) *Accept duel* → *Start duel* → *Run chat simulator*, or send `!pull` or `!1`–`!4` from the demo chat box. Open both overlay URLs (`/overlay/<login>`) in other tabs or as OBS browser sources to watch them update live.
- **Fake EventSub:** `node scripts/fake-eventsub.mjs chat <login> <id> "!pull"` and `… raid <from_login> <from_id> <to_login> <to_id> 25` send HMAC-signed webhooks using the demo secret.
- **Cron:** `curl "http://localhost:8787/cdn-cgi/handler/scheduled?cron=*/10+*+*+*+*"` (dev runs with `--test-scheduled`).
- `npm run dev:web` runs Astro's dev server on :4321, which proxies `/api` and `/auth` to wrangler on :8787 for hot reload while you change the UI.

- **Growth page:** `/growth/` shows the live session plus five seeded past streams per channel. Click a bar in *Community growth* to open an older stream. The DEMO buttons send a hype burst (→ auto-clip), `!recap`, and end or start the stream.
- **Overlay cards:** open `/overlay/pixelpaladin?hold=60` (keeps cards up for 60 s), then:
  ```bash
  curl -XPOST localhost:8787/api/demo/reset-cooldowns -H 'content-type: application/json' -d '{"channel":"pixelpaladin"}'
  curl -XPOST localhost:8787/api/demo/raid  -H 'content-type: application/json' -d '{"from":"clutchcleo","to":"pixelpaladin"}'   # welcome card + shout-out
  curl -XPOST localhost:8787/api/demo/hype  -H 'content-type: application/json' -d '{"channel":"pixelpaladin","count":40}'          # auto-clip card
  curl -XPOST localhost:8787/api/demo/chat  -H 'content-type: application/json' -d '{"channel":"pixelpaladin","messages":[{"user":"fan1","text":"!recap"}]}'
  curl "localhost:8787/api/demo/outbox?channel=pixelpaladin"     # what the bot would have said in chat
  ```
  Other demo endpoints: `POST /api/demo/stream {channel, action: "online"|"offline"}`. All `/api/demo/*` routes return 404 unless `DEMO_MODE=true`.

Screenshots: `docs/screenshots/growth.png`, `docs/screenshots/overlay-cards.png` (and the full 1080p frame `overlay-cards-1080p.png`).

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
**Chat messages (welcomes, `!recap`):** if `BOT_USER_ID` is set, messages go out with the app access token and `sender_id = BOT_USER_ID`. The bot account must have authorized the app with `user:bot` and `user:write:chat`, and each broadcaster grants `channel:bot`, which is in the sign-in scopes. Without `BOT_USER_ID`, messages are sent with the broadcaster's own user token, so they appear as the streamer. Every attempt is logged to D1 `bot_messages` with status `sent`, `dropped`, `failed`, `cooldown` or `demo`, and the growth page shows the log.

**Auto-clips:** `POST /helix/clips` uses the broadcaster's token (`clips:edit`) and only works while they're live. Detector defaults are in `worker/lib/hype.ts`. It compares a 10 s window against a 120 s baseline and fires when there are ≥2 msg/s, at least 4× the baseline, and ≥8 distinct chatters, then waits out a 120 s cooldown. `!` commands are ignored when picking the quote.
### Local live mode (real Twitch, local D1/KV/DOs, nothing deployed)
Copy `.dev.vars.example` to `.dev.vars` and fill it in, then:
```bash
npm run dev:live    # scripts/dev-live.sh: build + local D1 migrations + wrangler dev on :8787 with
                    # DEMO_MODE=false, APP_URL=http://localhost:8787, DEV_TOOLS=true,
                    # TRACKED_GAME_IDS=33214,516575,27471,490744 (Fortnite, VALORANT, Minecraft, Stardew Valley)
curl "http://127.0.0.1:8787/cdn-cgi/handler/scheduled?cron=*/10+*+*+*+*"   # fill the live-streams cache now
```
Sign in at `http://localhost:8787/auth/login` (the redirect URL registered on the Twitch app). Dev-only helpers
(404 unless `DEV_TOOLS=true`, never set in production): `GET /api/dev/status` (config + app-token check, no secret values),
`GET /api/dev/cache/:gameId`, `GET /api/dev/matchmaking?login=<any live channel>`.

EventSub webhooks need a public HTTPS URL. Start a tunnel to `http://127.0.0.1:8787` and pass its base URL as
`EVENTSUB_CALLBACK=https://… npm run dev:live`; OAuth keeps using `APP_URL` (localhost). `npm run live:check [login]`
creates a `stream.online` subscription against that callback, waits for Twitch's signed challenge to be answered, then deletes it.

### 4. Deploy
```bash
npm run deploy
```
Sign in with Twitch on the deployed site. Raid Network then subscribes your channel to `stream.online`, `stream.offline`, `channel.raid` (in and out) and `channel.chat.message`. Add `https://<app>/overlay/<your_login>` to OBS as a 1920×1080 browser source.

## Staying inside the $5 plan
- Matchmaking reads the KV cache, never Helix per page view. The cron makes about 6 runs/hour × tracked games × up to `MAX_STREAM_PAGES` Helix calls.
- Overlay/duel sockets use the **WebSocket Hibernation API** with auto-response pings, so idle overlays don't keep DOs billed for duration.
- Duel votes live in the DuelDO's SQLite while a duel runs and are written to D1 in one batch at the end.
- Chat isn't written per message. OverlayDO buffers chatters, message counts and a per-minute timeline in memory, then flushes to D1 in one batch about once a minute while chat is active (DO alarm). That's about 60 small batches per live hour per channel.
- Hype detection runs in OverlayDO memory, so it costs nothing per message. Helix `/clips` is called at most once per cooldown.
- The growth report is one `D1.batch` of 7 indexed queries. Fonts are static assets.
- Chat webhooks aren't deduped through KV (that would cost a KV write per message). OverlayDO dedupes them in memory.
- The included Workers Paid quotas are 10M requests/mo, D1 25B row reads / 50M writes, KV 10M reads / 1M writes, and DO 1M requests + 400k GB-s. A hackathon demo uses a tiny fraction.

## Layout
```
worker/index.ts            Hono routes, auth, page-shell rewrites, cron
worker/durable/overlay.ts  OverlayDO: overlay socket, chat router, stream session, hype → clips, welcomes, !recap
worker/durable/duel.ts     DuelDO: board state, votes, alarms, simulator, D1 persistence
worker/lib/                helix, tokens (AES-GCM), eventsub, matchmaking, streams cache, demo data,
                           hype.ts (detector), clips.ts, chatbot.ts (welcome/recap send), growth.ts (reports, recap, demo seed)
migrations/                0001_init.sql, 0002_growth.sql (streams, chatters, stream_chatters, bot_messages, clip columns)
web/                       Astro pages + SolidJS islands (Dashboard, RaidMap, DuelRoom, DuelBoard, Overlay, Growth)
shared/types.ts            types shared by worker and UI
scripts/smoke.mjs          end-to-end demo checks; scripts/fake-eventsub.mjs signs test webhooks
```

Notes and limits:
- Hype buckets and welcome cooldowns live in DO memory. If the DO is evicted (no chat for a while), the baseline restarts, which can only delay a clip, never cause a spurious one. Session state and clip/recap cooldowns are kept in DO storage.
- Anyone in chat can trigger `!recap`; the 60 s per-channel cooldown limits it.
- Stream sessions start on `stream.online`, or lazily on first chat, using the KV live cache or Helix. They end on `stream.offline`.
- OverlayDOs are keyed by channel login (from EventSub's `broadcaster_user_login`). If a streamer renames, their overlay URL changes. Overlay URLs are read-only and unauthenticated.
