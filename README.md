# Raid Network

Find live raid partners at about your size, see who raids whom, and run **chat-vs-chat duels** on one shared OBS overlay across 2–8 Twitch channels: 1v1, free-for-all (3–4 lanes) or Team A vs Team B (up to 4 channels a side).

Runs entirely on **Cloudflare Workers (Workers Paid, $5/mo)** using only the included allowances: one Worker, Static Assets, Durable Objects (SQLite-backed, hibernating WebSockets), D1, KV and a cron trigger. No R2, Queues, Workers AI, Images or Hyperdrive.

Optional **AI co-host + dashboard assistant** via [Ollama Cloud](https://docs.ollama.com/cloud) (an external API called with `fetch`, not a Cloudflare product). Without a key, or in demo mode, it uses deterministic templates, so everything works offline.

```
Browser / OBS ──HTTP/WS──▶ Worker (Hono)  ──▶ Static Assets (Astro + SolidJS, ./dist)
                              │  /api/*  /auth/*  /webhooks/eventsub
                              ├──▶ OverlayDO  (1 per channel: overlay socket, chat router, hype detector,
                              │                stream session, welcomes, !recap; flushes to D1 ~1×/min)
                              ├──▶ DuelDO     (1 per duel, any format: board, routing, votes, timer, winner)
                              ├──▶ D1  (users, channels, tokens, raids, duels, duel_channels, duel_votes, clips, streams,
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
| Free-for-all duels (3–4 channels, own lane + color each): **Chat Race** (first to the finish line, or highest at the buzzer) and per-channel **Chat Poll** (most voters wins) | ✅ built |
| Team duels (Team A vs Team B, up to 4 channels each, uneven teams OK): pulls/votes add up per team, rope tug or poll, per-channel contribution, top channel (👑), top chatters | ✅ built |
| Group-duel invites: host picks format, invites from partner suggestions or by Twitch login, assigns teams; invitees accept/decline from their dashboard; host starts once ≥2 sides are in, pending/declined channels are dropped | ✅ built (demo auto-accept) |
| Twitch OAuth, encrypted token storage, refresh | ✅ built (needs real credentials to test) |
| EventSub webhook (HMAC verify, replay window, dedupe) for stream.online/offline, channel.raid, channel.chat.message | ✅ built |
| Cron cache of live streams per tracked game | ✅ verified against real Helix (follows cursors past short pages, dedupes) |
| DEMO_MODE: fake streamers, seeded raid history, chat simulator | ✅ built |
| Raider welcomes: overlay card (first raid / raid #n, their game) + chat shout-out via `POST /chat/messages` | ✅ built (chat send mocked in demo) |
| Auto-clips: chat-velocity hype detector → `POST /clips` → clip card on overlay, stored in D1 | ✅ built (Helix call mocked in demo) |
| Post-stream growth page `/growth/` (new vs returning chatters, raids in/out, clips, duel results, timeline chart, bot log) | ✅ built |
| `!recap`: chat reply + overlay card (uptime, raids in, top clip, duels, new chatters), 60 s per-channel cooldown | ✅ built (chat send mocked in demo) |
| Self-hosted fonts (Fontsource, OFL; no Google Fonts requests) | ✅ built |
| **Assistant** (`/assistant/` + slide-out panel on the dashboard): streaming chat grounded in your matchmaking, growth report, duel history and raid map; suggests Raid/Duel as buttons that open the normal confirm dialogs | ✅ built (templates without a key) |
| **AI co-host in Twitch chat**: personalised raid welcomes (raider's game + title), AI `!recap`, duel host lines (round start + winner), AI poll questions, `!ask <question>` | ✅ built (chat send mocked in demo) |
| AI "why you'd collab" pitch on every match card, cached in KV for 6 h | ✅ built |
| AI safety and limits: 1 AI message per channel per 20 s, 60 s per-viewer `!ask` cooldown, per-channel daily cap, under 300 chars, ban-word filter, template fallback on any error, dashboard toggles per feature | ✅ built |

## Run it locally in demo mode (no Twitch account needed)

```bash
npm install
npm run dev          # builds the site, applies D1 migrations locally, starts wrangler dev with DEMO_MODE=true
# open http://localhost:8787  → "Open dashboard"
npm run smoke        # in a second terminal: end-to-end checks (matchmaking, raid, map, both duel modes in 1v1, FFA-3/4 and teams 2v2/4v4, signed EventSub, welcomes, auto-clips, !recap, growth report, AI assistant + co-host in template mode, rate limits, toggles, fonts)
```

In demo mode you're signed in as **PixelPaladin** (Stardew Valley, ~40 viewers). Use the banner's "Viewing as" picker to switch to any fake streamer.

- **Assistant walkthrough:** Dashboard → **✨ Assistant** (bottom right) or **✨ Ask AI**, or the **Assistant** tab for the full page. Try the chips: *Who should I raid tonight?*, *Set up a duel with someone my size*, *How did my last stream go?*, *Show my raid network*. Raid/Duel buttons under a reply open the same confirm dialogs as the cards, and nothing is sent until you confirm. The page version hands off to `/dashboard/?raid=<login>` or `?duel=<login>`. History is kept per tab (sessionStorage).
- **AI co-host walkthrough:** the *AI co-host* panel on the dashboard toggles each feature and sets the daily cap. Then try the chat features:
  ```bash
  curl -XPOST localhost:8787/api/demo/chat -H 'content-type: application/json' -d '{"channel":"pixelpaladin","messages":[{"user":"fan1","text":"!ask what game is this?"}]}'
  ```
  The duel dialog's Chat Poll has **✨ Suggest question**. Starting any duel posts a host line in every chat (see `/api/demo/outbox`).

- **Duel walkthrough:** Dashboard → ⚔ Duel on any card → *Send challenge* → (demo) *Accept duel* → *Start duel* → *Run chat simulator*, or send `!pull` or `!1`–`!4` from the demo chat box. Open both overlay URLs (`/overlay/<login>`) in other tabs or as OBS browser sources to watch them update live.
- **Group duel walkthrough:** Dashboard → **⚔ Group duel** (or ⚔ Duel on a card, then switch format) → pick **Free-for-all** or **Teams** → add channels from the suggestions dropdown or type a Twitch login → (Teams) toggle each pick to A or B and name the teams → pick *Chat Race* (FFA; set the finish line) / *Tug of War* (Teams) or *Chat Poll* → *Send N invites*. With *Demo: invited streamers accept right away* ticked (default) everyone accepts at once; untick it to accept/decline each invite from the duel room (as host in demo) or from the invitee's dashboard (switch "Viewing as"). *▶ Start free-for-all / team battle* (host only) drops anyone still pending, then *Run chat simulator*. The demo chat box has a button per channel, and every participant's `/overlay/<login>` shows the same board.
  - FFA race: each `!pull` moves that chat's lane; the first lane to the finish line (default 2 × duration seconds) wins on the spot, otherwise the highest lane at the buzzer.
  - FFA poll: one question in every chat, live per-channel bars and a stacked per-option breakdown; the chat with the most voters wins.
  - Teams: chatters belong to the team of the chat they first post in (they can hop between teammates' chats, never to the rival team); team score = sum of its channels.
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

Screenshots: `docs/screenshots/growth.png`, `docs/screenshots/overlay-cards.png` (and the full 1080p frame `overlay-cards-1080p.png`), group duel boards at 1080p: `overlay-ffa-1080p.png` (4-lane race), `overlay-ffa-poll-1080p.png`, `overlay-teams-1080p.png` (4v4 team tug). AI: `assistant-panel-1080p.png` (dashboard slide-out with raid + duel suggestions), `assistant-page-1080p.png` (`/assistant/`), `assistant-duel-handoff-1080p.png` (an assistant button opening the normal duel dialog), `dashboard-pitches-1080p.png` and `match-card-pitch.png` (collab pitch), `ai-cohost-settings.png`.

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
npx wrangler secret put OLLAMA_API_KEY      # optional: turns on AI (see "AI co-host and assistant")
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

## AI co-host and assistant (Ollama Cloud)

| | |
|---|---|
| Endpoint | `POST https://ollama.com/api/chat` with `Authorization: Bearer $OLLAMA_API_KEY` (`OLLAMA_HOST` overrides the base URL) |
| Model | `gemma4:31b` by default, set `OLLAMA_MODEL` to any [Ollama Cloud model](https://ollama.com/search?c=cloud), e.g. `gpt-oss:20b`, `gpt-oss:120b` |
| Provider module | `worker/lib/ai.ts`: `aiComplete` (JSON or text, timeout, `num_predict` cap, never throws) and `aiStream` (NDJSON streaming, strips `<think>`, 15 s first-token / 60 s total timeout). On any error, empty or unsafe output it returns the template answer. |
| Switching | **No key, or `DEMO_MODE=true` → template provider** (deterministic, offline). Set the key and it switches to Ollama automatically. `AI_IN_DEMO=true` also uses Ollama in demo mode. |

**Enable it locally:** put `OLLAMA_API_KEY=<key>` in `.dev.vars` (ignored by git) and run `npm run dev:live`, or `npm run dev` with `AI_IN_DEMO=true` also in `.dev.vars`. `GET /api/dev/ai` (DEV_TOOLS only) makes one tiny call and reports `{provider, model, ok, ms, error}` without the key. The dashboard's *AI co-host* chip shows `Ollama · <model>` once it's active. **In production:** `npx wrangler secret put OLLAMA_API_KEY`.

What it does:
- **Assistant** (`POST /api/assistant`, NDJSON events `meta → delta* → actions? → done`): the server detects the intent (raid, duel with X, growth, network, duel record, help), builds context from matchmaking (top 8), the last finished stream's report, the last 10 duels and raid-graph stats, then streams the answer. Raid/Duel/link **actions are buttons only**: the endpoint never raids or creates a duel. 200 questions/streamer/day (`AI_ASSISTANT_DAILY`).
- **Chat co-host** (through the same `sendBotChat` path as welcomes): raid welcome (raider name, game, title, `twitch.tv/<login>` always kept), `!recap` (keeps the real numbers), duel host lines at go-live and at the finish (one generation per duel event, posted to each channel that has it on), poll questions (`POST /api/ai/poll-question`), and `!ask <question>` (the question is treated as untrusted text, and the answer uses stream info only).
- **Collab pitches** (`GET /api/ai/pitches`): one batched JSON call for the top 12 matches, cached per pair in KV (`pitch:v1:…`) for 6 h. Template fallbacks are cached for 10 min.

Limits and safety: ≤1 AI chat message per channel per 20 s (OverlayDO memory, no storage per message), 60 s per-viewer `!ask` cooldown, a per-channel daily cap (`AI_DAILY_CAP`, default 150, editable 0–1000 on the dashboard), messages trimmed to <300 chars on a word boundary, markdown and leading `/` or `.` commands stripped, and a ban-word filter (slurs, profanity, insults; leetspeak-normalised) on both the question and the answer. The system prompt forbids insults and negativity. A rate-limited, capped or failed AI welcome or recap still goes out as the classic template. Toggles: `GET/POST /api/ai/settings` (D1 `ai_settings`, everything on by default), and usage is counted in D1 `ai_usage`.

## Staying inside the $5 plan
- Matchmaking reads the KV cache, never Helix per page view. The cron makes about 6 runs/hour × tracked games × up to `MAX_STREAM_PAGES` Helix calls.
- Overlay/duel sockets use the **WebSocket Hibernation API** with auto-response pings, so idle overlays don't keep DOs billed for duration.
- Duel votes live in the DuelDO's SQLite while a duel runs and are written to D1 in one batch at the end. Group duels are still one DuelDO per duel (up to 8 channels) with one alarm; each channel's OverlayDO forwards chat into it, and board broadcasts go over hibernating sockets.
- Chat isn't written per message. OverlayDO buffers chatters, message counts and a per-minute timeline in memory, then flushes to D1 in one batch about once a minute while chat is active (DO alarm). That's about 60 small batches per live hour per channel.
- Hype detection runs in OverlayDO memory, so it costs nothing per message. Helix `/clips` is called at most once per cooldown.
- The growth report is one `D1.batch` of 7 indexed queries. Fonts are static assets.
- Chat webhooks aren't deduped through KV (that would cost a KV write per message). OverlayDO dedupes them in memory.
- AI uses **no Cloudflare AI products**. Calls go to Ollama Cloud over `fetch`, which is billed by Ollama, not Cloudflare (its free plan has usage limits, see ollama.com/pricing). Waiting on the model costs no Worker CPU. An OverlayDO awaiting an 8 s reply counts toward DO duration: even 150 messages/day × 8 s × 128 MB ≈ 150 GB-s/day, about 1% of the 400k GB-s/month included. There are no new cron triggers. Pitches are cached in KV (≤12 writes per streamer per 6 h), settings in D1 are cached in the DO for 30 s, and `ai_usage` is one D1 upsert per assistant question or pitch batch.
- The included Workers Paid quotas are 10M requests/mo, D1 25B row reads / 50M writes, KV 10M reads / 1M writes, and DO 1M requests + 400k GB-s. A hackathon demo uses a tiny fraction.

## Layout
```
worker/index.ts            Hono routes, auth, page-shell rewrites, cron
worker/durable/overlay.ts  OverlayDO: overlay socket, chat router, stream session, hype → clips, welcomes, !recap
worker/durable/duel.ts     DuelDO: board state, votes, alarms, simulator, D1 persistence
worker/lib/                helix, tokens (AES-GCM), eventsub, matchmaking, streams cache, demo data,
                           hype.ts (detector), clips.ts, chatbot.ts (welcome/recap send), growth.ts (reports, recap, demo seed),
                           ai.ts (Ollama provider + safety filter), cohost.ts (chat AI + templates, settings, quotas),
                           assistant.ts (assistant context, intents, template answers)
migrations/                0001_init.sql, 0002_growth.sql (streams, chatters, stream_chatters, bot_messages, clip columns),
                           0003_multi_duels.sql (duels.format/race_target/results, duel_channels invites + per-channel scores),
                           0004_ai.sql (ai_settings, ai_usage)
web/                       Astro pages + SolidJS islands (Dashboard, RaidMap, DuelRoom, DuelBoard, Overlay, Growth, Assistant, AiCohost)
shared/types.ts            types shared by worker and UI
scripts/smoke.mjs          end-to-end demo checks; scripts/fake-eventsub.mjs signs test webhooks
```

Notes and limits:
- Hype buckets and welcome cooldowns live in DO memory. If the DO is evicted (no chat for a while), the baseline restarts, which can only delay a clip, never cause a spurious one. Session state and clip/recap cooldowns are kept in DO storage.
- Anyone in chat can trigger `!recap`; the 60 s per-channel cooldown limits it.
- The 20 s AI gap is shared by every AI feature in a channel, so a duel host line right after an AI welcome is skipped rather than queued. The overlay still shows the duel, and the classic template welcome or recap is used instead of being dropped.
- AI context is the streamer's own data. The model never sees tokens or other streamers' private stats. `!ask` answers are limited to public stream info (game, title, uptime, viewers, duel, recent raiders, commands).
- Team totals are raw sums, so with uneven teams the bigger side has more chatters to pull with (by design: 'uneven teams allowed'). The demo simulator normalizes this; real chat doesn't.
- Group duels in live mode need every participant signed in to Raid Network (so their `channel.chat.message` subscription exists); inviting by login uses the app token to look up the channel. A 1v1 still lets either side start; FFA/Teams only the host.
- Stream sessions start on `stream.online`, or lazily on first chat, using the KV live cache or Helix. They end on `stream.offline`.
- OverlayDOs are keyed by channel login (from EventSub's `broadcaster_user_login`). If a streamer renames, their overlay URL changes. Overlay URLs are read-only and unauthenticated.
