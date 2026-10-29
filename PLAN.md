# Raid Network: build plan (Codex x TwitchCon Hackathon)
Deadline: submit by Mon Nov 2 evening IST; hard stop Nov 3, 2:30 AM IST.

## Codex eligibility (decide first)
All app code must come out of ONE main Codex thread (its session ID goes in the submission). So I write no app code myself. Two workflows:
- A) Sushmit runs Codex on his machine; I write the spec (AGENTS.md + SPEC.md) and a numbered prompt for each step, review diffs, and handle Twitch/Cloudflare setup and the Devpost write-up.
- B) I install the Codex CLI on my computer, Sushmit signs in with his ChatGPT account once, and I drive that single thread with the same prompts. Same eligibility, less of his time.
Also: the repo should live on Sushmit's GitHub (private), not the codeybot-labs test account.

## Architecture (all on Cloudflare Workers Paid, $5)
- One Worker serving an Astro site (static + SolidJS islands) and the API.
- Twitch OAuth (auth code flow) for Sign in with Twitch; sessions in KV.
- D1: users, channels, tokens (encrypted), raid history, duel results, clip/recap log.
- Durable Objects (WebSocket hibernation so idle sockets cost almost nothing):
  - OverlayDO per channel: pushes welcomes, clips, duel state to that streamer's OBS browser-source URL.
  - DuelDO per duel: shared board state, votes from both chats, timer, winner.
- EventSub over webhooks (HMAC-verified): stream.online/offline, channel.raid, channel.chat.message (for duel votes, !recap, hype detection), channel.follow optional.
- Helix: GET /streams (by game_id, live, viewer counts) for matchmaking; POST /raids (channel:manage:raids) for the Raid button; POST /clips (clips:edit) for auto-clips; POST /chat/messages (user:write:chat) for welcomes and !recap replies; GET /users, /channels.
- Cron trigger every 5-10 min: refresh live streams per tracked game into D1/KV cache, so matchmaking never fans out per page view.

### Staying inside included allowances
Workers Paid includes 10M requests/mo, D1 25B row reads / 50M row writes / 5 GB, KV 10M reads / 1M writes, Durable Objects 1M requests + 400k GB-s. A hackathon demo uses a tiny fraction. Guards: hibernating WebSockets, cached matchmaking (no per-request Helix fan-out), chat messages batched into the DO, no R2/Queues/AI/Images. I'll check the Cloudflare usage page before the demo and flag anything that moves toward a limit.

## Features, in build order
1. Matchmaking: same game, live, viewer count within ~0.5x-2x, ranked by overlap (tags, language, past raids). Dashboard cards with Raid and Duel buttons.
2. Raid network map: graph of who raided whom (from channel.raid + history), SVG force layout, nodes sized by viewers.
3. Duel board: invite -> accept -> DuelDO; both chats vote/play via chat commands; one shared overlay on both streams; result to growth page.
4. Raider welcomes: on channel.raid, overlay card + chat shout-out of the raiding channel.
5. Auto-clips: chat-velocity spike detector in OverlayDO -> POST /clips; listed on growth page.
6. !recap (last): bot replies with a short summary of the stream so far (top moments, clips, raids in).
7. Post-stream growth page: new chatters, raids in/out, clips, duel results.

## Twitch setup Sushmit needs to do (dev.twitch.tv console)
1. Register an app (category: Website Integration), add redirect URLs for localhost and the workers.dev URL.
2. Copy Client ID and generate a Client Secret (I'll store them as Worker secrets, never in the repo).
3. Optional bot account for chat messages (or use his own channel).
4. A second Twitch account/channel to show the duel and a raid on camera.
Scopes: user:read:chat, user:write:chat, channel:bot, channel:manage:raids, clips:edit, moderator:read:followers.

## Schedule (IST)
- Thu Oct 29: decide workflow, Twitch app + Cloudflare + private repo, start the main Codex thread: scaffold, OAuth, D1 schema, deploy hello-world.
- Fri Oct 30: EventSub webhooks, stream cache cron, matchmaking dashboard, Raid button, network map.
- Sat Oct 31: DuelDO + overlay + chat voting, duel invites.
- Sun Nov 1: raider welcomes, auto-clips, growth page, !recap; design pass.
- Mon Nov 2: end-to-end test on real Twitch with two channels, README + setup instructions, record and upload video, Devpost write-up, submit by evening. Buffer until 2:30 AM Nov 3.

## Demo video (< 3 min, YouTube)
0:00-0:15 hook: small streamers can't find raid partners. 0:15-0:50 sign in, dashboard suggests live similar-sized streamers, click Raid, show the raid land live on Twitch with the welcome overlay. 0:50-1:35 duel: two channels, both chats voting on one overlay. 1:35-2:00 auto-clip fires on a hype spike, !recap in chat, growth page. 2:00-2:40 how Codex built it: the main thread, AGENTS.md, a few prompts and diffs, Cloudflare architecture diagram. 2:40-2:55 close.
