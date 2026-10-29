import { Hono, type Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { appUrl, duelStub, eventsubCallbackUrl, isDemo, overlayStub, type AppEnv, type Env } from './env';
import { DEFAULT_BOARD_SIZE, isBoardSize, SIDE_KEYS, type BoardSize, type OverlaySettings, type ChannelRef, type ChatMessage, type DuelFormat, type DuelMode, type GrowthResponse, type Side, type Viewer } from '../shared/types';
import { listStreams, streamReport } from './lib/growth';
import { randomId } from './lib/crypto';
import { DEMO_ME, allDemoLogins, demoFindStream, ensureDemoSeed } from './lib/demo';
import { handleEventSub, subscribeChannel } from './lib/eventsub';
import { authorizeUrl, appToken, exchangeCode, getUsers, startRaid, HelixError } from './lib/helix';
import { matchmaking, raidGraph } from './lib/matchmaking';
import { createSession, demoViewer, destroySession, getViewer } from './lib/session';
import { getCachedStreams, refreshAllStreams, trackedGames } from './lib/streams';
import { saveTokens, userToken } from './lib/tokens';
import { aiComplete, aiConfig, type AiMessage } from './lib/ai';
import { runAssistant } from './lib/assistant';
import { aiPitches, aiPollQuestion, getAiSettings, saveAiSettings, takeDailyQuota } from './lib/cohost';
import type { AiSettings, AiSettingsResponse, AssistantEvent } from '../shared/types';

export { OverlayDO } from './durable/overlay';
export { DuelDO } from './durable/duel';

const app = new Hono<AppEnv>();
type C = Context<AppEnv>;

const redirectUri = (c: C) => `${appUrl(c.env, c.req.raw)}/auth/callback`;
const bad = (c: C, msg: string, status: 400 | 401 | 403 | 404 | 409 | 500 | 502 = 400) => c.json({ error: msg }, status);

app.onError((err, c) => {
  console.error(err);
  if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
  if (err instanceof HelixError) return c.json({ error: 'Twitch API error', status: err.status, detail: err.body.slice(0, 300) }, 502);
  return c.json({ error: err.message || 'internal error' }, 500);
});

// ---------- CSRF guard for state-changing API calls ----------
app.use('/api/*', async (c, next) => {
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
    const origin = c.req.header('Origin');
    if (origin && new URL(origin).host !== new URL(c.req.url).host) return bad(c, 'cross-origin request blocked', 403);
  }
  c.set('viewer', await getViewer(c));
  await next();
});

const requireViewer = (c: C): Viewer => {
  const v = c.get('viewer');
  if (!v) throw new HTTPException(401, { message: 'sign in required' });
  return v;
};
// ---------- Auth ----------
app.get('/auth/login', async (c) => {
  if (isDemo(c.env)) {
    const v = demoViewer(c.req.query('as') ?? DEMO_ME);
    if (!v) return c.text('unknown demo streamer', 404);
    await createSession(c, v);
    return c.redirect('/dashboard/');
  }
  const state = randomId(24);
  setCookie(c, 'rn_oauth_state', state, { httpOnly: true, sameSite: 'Lax', path: '/auth', maxAge: 600, secure: c.req.url.startsWith('https:') });
  return c.redirect(authorizeUrl(c.env, redirectUri(c), state));
});

app.get('/auth/callback', async (c) => {
  const { code, state, error } = c.req.query();
  if (error) return c.redirect(`/?auth_error=${encodeURIComponent(error)}`);
  const expected = getCookie(c, 'rn_oauth_state');
  deleteCookie(c, 'rn_oauth_state', { path: '/auth' });
  if (!code || !state || !expected || state !== expected) return c.text('OAuth state mismatch; try signing in again', 400);
  const tokens = await exchangeCode(c.env, code, redirectUri(c));
  const [u] = await getUsers(c.env, tokens.access_token);
  const now = Date.now();
  await c.env.DB.batch([
    c.env.DB.prepare(`INSERT INTO users (id, login, display_name, profile_image_url, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)
      ON CONFLICT(id) DO UPDATE SET login=?2, display_name=?3, profile_image_url=?4, updated_at=?5`).bind(u.id, u.login, u.display_name, u.profile_image_url, now),
    c.env.DB.prepare(`INSERT INTO channels (id, user_id, login, display_name, tracked, updated_at) VALUES (?1, ?1, ?2, ?3, 1, ?4)
      ON CONFLICT(id) DO UPDATE SET user_id=?1, login=?2, display_name=?3, tracked=1, updated_at=?4`).bind(u.id, u.login, u.display_name, now),
  ]);
  await saveTokens(c.env, u.id, tokens);
  c.executionCtx.waitUntil(subscribeChannel(c.env, u.id).then(async (r) => {
    if (r.failed.length) console.warn('eventsub subscribe failures', r.failed);
    await c.env.DB.prepare('UPDATE channels SET eventsub_ok = ? WHERE id = ?').bind(r.failed.length ? 0 : 1, u.id).run();
  }).catch((e) => console.error('eventsub subscribe', e)));
  await createSession(c, { id: u.id, login: u.login, displayName: u.display_name, avatarUrl: u.profile_image_url, demo: false });
  return c.redirect('/dashboard/');
});

app.on(['GET', 'POST'], '/auth/logout', async (c) => {
  await destroySession(c);
  return c.redirect('/');
});

// ---------- API ----------
app.get('/api/health', (c) => c.json({ ok: true, demo: isDemo(c.env), time: new Date().toISOString() }));

app.get('/api/me', (c) => {
  const v = c.get('viewer');
  return c.json({ viewer: v, demo: isDemo(c.env), demoStreamers: isDemo(c.env) ? allDemoLogins() : undefined });
});

app.get('/api/matchmaking', async (c) => {
  const v = requireViewer(c);
  if (isDemo(c.env)) await ensureDemoSeed(c.env);
  return c.json(await matchmaking(c.env, v));
});

app.get('/api/network', async (c) => {
  const v = requireViewer(c);
  if (isDemo(c.env)) await ensureDemoSeed(c.env);
  return c.json(await raidGraph(c.env, v, c.req.query('scope') === 'all' ? 'all' : 'me'));
});

/** Resolve a target channel the client sent us (never trust its display data). */
async function resolveChannel(c: C, id: string): Promise<ChannelRef | null> {
  if (isDemo(c.env)) {
    for (const login of allDemoLogins()) {
      const s = demoFindStream(login);
      if (s && s.id === id) return { id: s.id, login: s.login, displayName: s.displayName };
    }
    return null;
  }
  const [u] = await getUsers(c.env, await appToken(c.env), { ids: [id] });
  return u ? { id: u.id, login: u.login, displayName: u.display_name, avatarUrl: u.profile_image_url } : null;
}

app.post('/api/raids', async (c) => {
  const v = requireViewer(c);
  const { toId } = await c.req.json<{ toId: string }>();
  const to = await resolveChannel(c, toId);
  if (!to) return bad(c, 'unknown channel', 404);
  if (to.id === v.id) return bad(c, "you can't raid yourself");
  let viewers = 0;
  if (isDemo(c.env)) {
    viewers = demoFindStream(v.login)?.viewerCount ?? 0;
  } else {
    await startRaid(c.env, await userToken(c.env, v.id), v.id, to.id); // Twitch shows the raid countdown on the streamer's side
  }
  await c.env.DB.prepare(
    `INSERT INTO raids (from_id, from_login, from_name, to_id, to_login, to_name, viewers, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(v.id, v.login, v.displayName, to.id, to.login, to.displayName, viewers, isDemo(c.env) ? 'demo' : 'button', Date.now()).run();
  if (isDemo(c.env)) await overlayStub(c.env, to.login).raid({ id: v.id, login: v.login, displayName: v.displayName }, viewers, to);
  return c.json({ ok: true, to, demo: isDemo(c.env), note: isDemo(c.env) ? 'Demo raid recorded' : 'Raid started on Twitch; confirm it in your stream manager within 90s' });
});

// ----- Duels -----
type DuelRow = { id: string; challenger_id: string; opponent_id: string; status: string };
type DuelChannelRow = { duel_id: string; channel_id: string; login: string; display_name: string | null; side: string; status: string; score: number; voters: number };

/** Duels I host or was invited to (newest first), each with its channel list and my invite status. */
app.get('/api/duels', async (c) => {
  const v = requireViewer(c);
  const rows = (await c.env.DB.prepare(
    `SELECT * FROM duels WHERE challenger_id = ?1 OR opponent_id = ?1 OR id IN (SELECT duel_id FROM duel_channels WHERE channel_id = ?1)
     ORDER BY created_at DESC LIMIT 20`).bind(v.id).all<Record<string, unknown> & { id: string }>()).results;
  const ids = rows.map((r) => r.id);
  const chans = ids.length
    ? (await c.env.DB.prepare(`SELECT * FROM duel_channels WHERE duel_id IN (${ids.map(() => '?').join(',')}) ORDER BY created_at, rowid`).bind(...ids).all<DuelChannelRow>()).results
    : [];
  const duels = rows.map((r) => {
    const channels = chans.filter((x) => x.duel_id === r.id).map((x) => ({
      id: x.channel_id, login: x.login, displayName: x.display_name ?? x.login, side: x.side, invite: x.status, score: x.score, voters: x.voters }));
    return { ...r, format: r.format ?? '1v1', channels, my_invite: channels.find((x) => x.id === v.id)?.invite ?? (r.challenger_id === v.id ? 'host' : null) };
  });
  return c.json({ duels });
});

const MAX_TEAM = 4;
type InviteIn = { id?: string; login?: string; team?: 'a' | 'b' };

/** Resolve a channel by Twitch id or login (demo: fake streamers). */
async function resolveInvite(c: C, inv: InviteIn): Promise<ChannelRef | null> {
  if (inv.id) return resolveChannel(c, String(inv.id));
  const login = String(inv.login ?? '').trim().toLowerCase().replace(/^@/, '').replace(/^https?:\/\/(www\.)?twitch\.tv\//, '');
  if (!/^[a-z0-9_]{2,25}$/.test(login)) return null;
  if (isDemo(c.env)) {
    const s = demoFindStream(login);
    return s ? { id: s.id, login: s.login, displayName: s.displayName } : null;
  }
  const [u] = await getUsers(c.env, await appToken(c.env), { logins: [login] });
  return u ? { id: u.id, login: u.login, displayName: u.display_name, avatarUrl: u.profile_image_url } : null;
}

/**
 * Create a duel. 1v1 (legacy): { opponentId }. Multi: { format: 'ffa' | 'teams', invites: [{ id | login, team? }] }.
 * ffa = host + 2-3 invitees, one lane each. teams = host on Team A plus 1-7 invitees, max 4 per team.
 */
app.post('/api/duels', async (c) => {
  const v = requireViewer(c);
  const body = await c.req.json<{
    opponentId?: string; format?: DuelFormat; invites?: InviteIn[]; mode?: DuelMode; question?: string; options?: string[];
    durationS?: number; raceTarget?: number; teamNames?: string[]; autoAccept?: boolean;
  }>();
  const format: DuelFormat = body.format === 'ffa' || body.format === 'teams' ? body.format : '1v1';
  const rawInvites: InviteIn[] = body.invites?.length ? body.invites.slice(0, 8) : body.opponentId ? [{ id: body.opponentId }] : [];
  if (!rawInvites.length) return bad(c, 'invite at least one channel');
  const invited: { channel: ChannelRef; side: Side }[] = [];
  for (const inv of rawInvites) {
    const ch = await resolveInvite(c, inv);
    if (!ch) return bad(c, `unknown channel ${inv.login ?? inv.id ?? ''}`.trim(), 404);
    if (ch.id === v.id) return bad(c, "you can't duel yourself");
    if (invited.some((x) => x.channel.id === ch.id)) continue;
    invited.push({ channel: ch, side: 'b' });
  }
  if (format === '1v1') {
    if (invited.length !== 1) return bad(c, 'a 1v1 duel has exactly one opponent');
  } else if (format === 'ffa') {
    if (invited.length < 2 || invited.length > 3) return bad(c, 'a free-for-all needs 2-3 invited channels (3-4 lanes with you)');
    invited.forEach((x, i) => (x.side = SIDE_KEYS[i + 1]));
  } else {
    // Team B by default, alternating A/B for any invite without an explicit team.
    rawInvites.slice(0, invited.length).forEach((inv, i) => (invited[i].side = inv.team === 'a' ? 'a' : inv.team === 'b' ? 'b' : i % 2 === 0 ? 'b' : 'a'));
    const nA = 1 + invited.filter((x) => x.side === 'a').length;
    const nB = invited.filter((x) => x.side === 'b').length;
    if (nB < 1) return bad(c, 'Team B needs at least one channel');
    if (nA > MAX_TEAM || nB > MAX_TEAM) return bad(c, `teams are at most ${MAX_TEAM} channels each`);
  }
  const mode: DuelMode = body.mode === 'poll' ? 'poll' : 'tug';
  const durationS = Math.min(300, Math.max(20, Math.round(body.durationS ?? 90)));
  const options = mode === 'poll' ? (body.options ?? []).map((o) => String(o).trim().slice(0, 40)).filter(Boolean).slice(0, 4) : [];
  if (mode === 'poll' && options.length < 2) return bad(c, 'a poll duel needs 2-4 options');
  const defaultQ = mode === 'poll' ? '' : format === 'ffa' ? 'Chat Race: spam !pull to push your streamer to the finish!'
    : format === 'teams' ? 'Team Tug of War: every chat on your team pulls together!' : 'Tug of War: spam !pull for your streamer!';
  const question = String(body.question ?? defaultQ).slice(0, 120);
  // Race finish line: about 2 pulls per second of duel time unless the host picks one.
  const raceTarget = format === 'ffa' && mode === 'tug' ? Math.min(2000, Math.max(20, Math.round(body.raceTarget ?? durationS * 2))) : 0;
  const teamNames = format === 'teams'
    ? [0, 1].map((i) => String(body.teamNames?.[i] ?? '').trim().slice(0, 24) || (i ? 'Team B' : 'Team A')) as [string, string] : undefined;
  const id = randomId(10);
  const now = Date.now();
  const opp = invited[0].channel;
  const host: ChannelRef = { id: v.id, login: v.login, displayName: v.displayName, avatarUrl: v.avatarUrl };
  const chanStmt = c.env.DB.prepare(
    'INSERT INTO duel_channels (duel_id, channel_id, login, display_name, side, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO duels (id, challenger_id, challenger_login, challenger_name, opponent_id, opponent_login, opponent_name, mode, question, options, duration_s, status, created_at, format, race_target)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
    ).bind(id, v.id, v.login, v.displayName, opp.id, opp.login, opp.displayName, mode, question, JSON.stringify(options), durationS, now, format, raceTarget),
    chanStmt.bind(id, v.id, v.login, v.displayName, 'a', 'host', now),
    ...invited.map((x, i) => chanStmt.bind(id, x.channel.id, x.channel.login, x.channel.displayName, x.side, 'pending', now + i + 1)),
  ]);
  const stub = duelStub(c.env, id);
  let state = await stub.init({ id, format, mode, question, options, durationS, raceTarget, teamNames, demo: isDemo(c.env), a: host, invites: invited });
  const label = format === 'ffa' ? `a ${invited.length + 1}-way free-for-all` : format === 'teams' ? 'a team battle' : 'a duel';
  c.executionCtx.waitUntil(Promise.allSettled(invited.map((x) =>
    overlayStub(c.env, x.channel.login).toast(`${v.displayName} invited you to ${label}!`))).then(() => {}));
  // Demo: the fake streamers can't click Accept, so the host may have them all say yes at once.
  if (isDemo(c.env) && body.autoAccept) state = await stub.respond(true);
  return c.json({ duel: state, inviteUrl: `${appUrl(c.env, c.req.raw)}/duel/${id}` });
});

async function duelFor(c: C, id: string) {
  const row = await c.env.DB.prepare('SELECT id, challenger_id, opponent_id, status FROM duels WHERE id = ?').bind(id).first<DuelRow>();
  return row;
}

app.get('/api/duels/:id', async (c) => {
  const state = await duelStub(c.env, c.req.param('id')).getState();
  return state ? c.json({ duel: state }) : bad(c, 'duel not found', 404);
});

app.post('/api/duels/:id/:action{accept|decline|start|cancel|simulate}', async (c) => {
  const v = requireViewer(c);
  const id = c.req.param('id');
  const action = c.req.param('action');
  const row = await duelFor(c, id);
  if (!row) return bad(c, 'duel not found', 404);
  const demo = isDemo(c.env);
  const stub = duelStub(c.env, id);
  const cur = await stub.getState();
  if (!cur) return bad(c, 'duel not found', 404);
  const mine = cur.channels.find((x) => x.id === v.id);
  const isHost = cur.hostId === v.id;
  const isActive = !!mine && (mine.invite === 'host' || mine.invite === 'accepted');
  try {
    switch (action) {
      case 'accept':
      case 'decline': {
        const accept = action === 'accept';
        if (mine?.invite === 'pending') return c.json({ duel: await stub.respond(accept, [v.id]) });
        // In demo mode the host may answer on behalf of the fake invitees ({ channelId } for one, or all pending).
        if (demo && isHost) {
          const { channelId } = await c.req.json<{ channelId?: string }>().catch(() => ({} as { channelId?: string }));
          return c.json({ duel: await stub.respond(accept, channelId ? [channelId] : undefined) });
        }
        return bad(c, mine ? `your invite is ${mine.invite}` : 'only invited streamers can respond', 403);
      }
      case 'start': {
        // 1v1: either streamer may start (as before). Multi-channel duels: the host starts.
        if (!(isHost || (cur.format === '1v1' && isActive))) return bad(c, cur.format === '1v1' ? 'not your duel' : 'only the host can start this duel', 403);
        // One running duel per channel: the overlay can only show one board.
        for (const ch of cur.channels.filter((x) => x.invite === 'host' || x.invite === 'accepted')) {
          const other = await overlayStub(c.env, ch.login).getActiveDuel();
          if (other && other !== id) {
            const o = await duelStub(c.env, other).getState();
            if (o && ['countdown', 'live'].includes(o.status)) return bad(c, `${ch.displayName} is already in a running duel`, 409);
          }
        }
        return c.json({ duel: await stub.start() });
      }
      case 'cancel':
        if (!isHost && !isActive) return bad(c, 'not your duel', 403);
        return c.json({ duel: await stub.cancel() });
      case 'simulate': {
        if (!demo) return bad(c, 'simulator is demo-only', 403);
        const { on } = await c.req.json<{ on: boolean }>().catch(() => ({ on: true }));
        return c.json({ duel: await stub.setSimulate(on !== false) });
      }
    }
  } catch (e) {
    return bad(c, (e as Error).message, 409);
  }
  return bad(c, 'unknown action');
});

app.get('/api/duels/:id/ws', async (c) => {
  if (c.req.header('Upgrade')?.toLowerCase() !== 'websocket') return bad(c, 'expected websocket upgrade', 400);
  return duelStub(c.env, c.req.param('id')).fetch(c.req.raw);
});

// ----- OBS overlay settings (board size) -----
const getBoardSize = async (env: Env, where: 'channel_id' | 'login', key: string): Promise<BoardSize> => {
  const r = await env.DB.prepare(`SELECT board_size FROM overlay_settings WHERE ${where} = ? ORDER BY updated_at DESC LIMIT 1`).bind(key).first<{ board_size: string }>();
  return isBoardSize(r?.board_size) ? r!.board_size : DEFAULT_BOARD_SIZE;
};
/** Public (the overlay page has no session): the saved default board size for a channel. One D1 read per overlay load. */
app.get('/api/overlay/:channel/config', async (c) =>
  c.json({ size: await getBoardSize(c.env, 'login', c.req.param('channel').toLowerCase()) } satisfies OverlaySettings));
app.get('/api/overlay-settings', async (c) => {
  const v = requireViewer(c);
  return c.json({ size: await getBoardSize(c.env, 'channel_id', v.id) } satisfies OverlaySettings);
});
app.post('/api/overlay-settings', async (c) => {
  const v = requireViewer(c);
  const body = await c.req.json<Partial<OverlaySettings>>().catch(() => ({} as Partial<OverlaySettings>));
  if (!isBoardSize(body.size)) return bad(c, "size must be 's', 'm' or 'l'", 400);
  await c.env.DB.prepare(`INSERT INTO overlay_settings (channel_id, login, board_size, updated_at) VALUES (?1, ?2, ?3, ?4)
    ON CONFLICT(channel_id) DO UPDATE SET login=?2, board_size=?3, updated_at=?4`).bind(v.id, v.login.toLowerCase(), body.size, Date.now()).run();
  await overlayStub(c.env, v.login).sizeChanged(body.size);
  return c.json({ size: body.size } satisfies OverlaySettings);
});

app.get('/api/overlay/:channel/ws', async (c) => {
  if (c.req.header('Upgrade')?.toLowerCase() !== 'websocket') return bad(c, 'expected websocket upgrade', 400);
  const channel = c.req.param('channel').toLowerCase();
  const url = new URL(c.req.url);
  url.searchParams.set('channel', channel);
  return overlayStub(c.env, channel).fetch(new Request(url.toString(), c.req.raw));
});

// ----- Demo helpers (DEMO_MODE only) -----
app.post('/api/demo/chat', async (c) => {
  if (!isDemo(c.env)) return bad(c, 'demo only', 403);
  const { channel, messages } = await c.req.json<{ channel: string; messages: { user: string; text: string }[] }>();
  const s = demoFindStream(channel);
  if (!s) return bad(c, 'unknown demo channel', 404);
  const now = Date.now();
  const msgs: ChatMessage[] = (messages ?? []).slice(0, 200).map((m, i) => ({
    id: `demo-${now}-${i}-${randomId(4)}`, channelId: s.id, channelLogin: s.login, userId: `chat-${m.user.toLowerCase()}`,
    login: m.user.toLowerCase(), text: m.text, at: now + i,
  }));
  // Same path as EventSub: channel's OverlayDO routes into its active DuelDO.
  return c.json(await overlayStub(c.env, s.login).chat(msgs));
});

app.post('/api/demo/raid', async (c) => {
  if (!isDemo(c.env)) return bad(c, 'demo only', 403);
  const { from, to } = await c.req.json<{ from: string; to: string }>();
  const f = demoFindStream(from);
  const t = demoFindStream(to);
  if (!f || !t) return bad(c, 'unknown demo channel', 404);
  await c.env.DB.prepare(
    `INSERT INTO raids (from_id, from_login, from_name, to_id, to_login, to_name, viewers, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'demo', ?)`,
  ).bind(f.id, f.login, f.displayName, t.id, t.login, t.displayName, f.viewerCount, Date.now()).run();
  const welcome = await overlayStub(c.env, t.login).raid({ id: f.id, login: f.login, displayName: f.displayName }, f.viewerCount,
    { id: t.id, login: t.login, displayName: t.displayName });
  return c.json({ ok: true, welcome });
});

/** Demo: a burst of hype chat (many chatters spamming) to trip the auto-clip detector. */
app.post('/api/demo/hype', async (c) => {
  if (!isDemo(c.env)) return bad(c, 'demo only', 403);
  const { channel, count = 40, text, users } = await c.req.json<{ channel: string; count?: number; text?: string; users?: number }>();
  const s = demoFindStream(channel);
  if (!s) return bad(c, 'unknown demo channel', 404);
  const now = Date.now();
  const lines = text ? [text] : ['LETS GOOOOO', 'NO WAY', 'CLIP IT', 'PogChamp', 'LETS GOOOOO', 'KEKW', 'LETS GOOOOO'];
  const msgs: ChatMessage[] = Array.from({ length: Math.min(200, count) }, (_, i) => {
    const user = `hyper${i % (users ?? Math.max(10, Math.ceil(count / 2)))}`;
    return { id: `hype-${now}-${i}-${randomId(4)}`, channelId: s.id, channelLogin: s.login, userId: `chat-${user}`, login: user, text: lines[i % lines.length], at: now };
  });
  return c.json(await overlayStub(c.env, s.login).chat(msgs));
});

/** Demo: stream goes offline/online (what EventSub stream.offline/online would do). */
app.post('/api/demo/stream', async (c) => {
  if (!isDemo(c.env)) return bad(c, 'demo only', 403);
  const { channel, action } = await c.req.json<{ channel: string; action: 'online' | 'offline' }>();
  const s = demoFindStream(channel);
  if (!s) return bad(c, 'unknown demo channel', 404);
  const ref = { id: s.id, login: s.login, displayName: s.displayName };
  const stub = overlayStub(c.env, s.login);
  if (action === 'offline') return c.json({ ended: await stub.streamOffline(ref) });
  const now = Date.now();
  return c.json({ started: await stub.streamOnline({ channel: ref, streamId: `demo-${s.login}-${now}`, startedAt: now, title: s.title, gameName: s.gameName }) });
});

app.post('/api/demo/reset-cooldowns', async (c) => {
  if (!isDemo(c.env)) return bad(c, 'demo only', 403);
  const { channel, keepDaily } = await c.req.json<{ channel: string; keepDaily?: boolean }>();
  await overlayStub(c.env, channel).resetCooldowns({ keepDaily: !!keepDaily });
  return c.json({ ok: true });
});

/** Demo: chat messages Raid Network "sent" (welcomes, recaps). Live mode logs the same table with Twitch's result. */
app.get('/api/demo/outbox', async (c) => {
  if (!isDemo(c.env)) return bad(c, 'demo only', 403);
  const s = demoFindStream(c.req.query('channel') ?? '');
  if (!s) return bad(c, 'unknown demo channel', 404);
  const rows = await c.env.DB.prepare('SELECT kind, text, status, stream_id, created_at FROM bot_messages WHERE channel_id = ? ORDER BY id DESC LIMIT 20').bind(s.id).all();
  return c.json({ messages: rows.results });
});

// ----- Dev helpers (DEV_TOOLS=true only; `npm run dev:live` sets it, production never does) -----
app.use('/api/dev/*', async (c, next) => {
  if (c.env.DEV_TOOLS !== 'true') return bad(c, 'not found', 404);
  await next();
});

/** Config + app-token (client credentials) check. Never returns secret values. */
app.get('/api/dev/status', async (c) => {
  const t0 = Date.now();
  let appTokenOk = false; let tokenError: string | undefined;
  try { appTokenOk = (await appToken(c.env)).length > 0; } catch (e) { tokenError = (e as Error).message.slice(0, 200); }
  return c.json({
    demo: isDemo(c.env), appUrl: appUrl(c.env), oauthRedirect: redirectUri(c), eventsubCallback: eventsubCallbackUrl(c.env),
    trackedGames: await trackedGames(c.env), maxStreamPages: Number(c.env.MAX_STREAM_PAGES ?? '10'),
    secretsPresent: {
      TWITCH_CLIENT_ID: !!c.env.TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET: !!c.env.TWITCH_CLIENT_SECRET,
      EVENTSUB_SECRET: !!c.env.EVENTSUB_SECRET, TOKEN_ENC_KEY: !!c.env.TOKEN_ENC_KEY, BOT_USER_ID: !!c.env.BOT_USER_ID,
      OLLAMA_API_KEY: !!c.env.OLLAMA_API_KEY,
    },
    ai: aiStatus(c.env),
    appTokenOk, tokenError, ms: Date.now() - t0,
  });
});

/** One tiny model call to check the Ollama key/model/host. Never returns the key. */
app.get('/api/dev/ai', async (c) => {
  const r = await aiComplete(c.env, {
    messages: [{ role: 'user', content: 'Reply with exactly: Raid Network AI online' }], maxTokens: 20, temperature: 0, timeoutMs: Number(c.req.query('timeoutMs') ?? 12_000),
  }, () => 'mock: Raid Network AI online');
  return c.json({ ...aiStatus(c.env), ok: r.ok, ms: r.ms, error: r.error, reply: r.text.slice(0, 120) });
});

/** Summary of the KV live-streams cache for one game (fills it on a cold miss). */
app.get('/api/dev/cache/:gameId', async (c) => {
  const cache = await getCachedStreams(c.env, c.req.param('gameId'));
  const v = cache.streams.map((s) => s.viewerCount);
  return c.json({
    gameId: cache.gameId, gameName: cache.gameName, fetchedAt: cache.fetchedAt ? new Date(cache.fetchedAt).toISOString() : null,
    count: cache.streams.length, uniqueIds: new Set(cache.streams.map((s) => s.id)).size,
    maxViewers: v[0] ?? 0, minViewers: v[v.length - 1] ?? 0,
    sample: cache.streams.filter((_, i) => i % Math.max(1, Math.floor(cache.streams.length / 8)) === 0).slice(0, 8)
      .map((s) => ({ login: s.login, viewers: s.viewerCount, lang: s.language })),
  });
});

/** Matchmaking as if `login` were signed in (read-only: uses the app token, no user token). */
app.get('/api/dev/matchmaking', async (c) => {
  const login = (c.req.query('login') ?? '').toLowerCase();
  if (!login) return bad(c, 'login required');
  const [u] = await getUsers(c.env, await appToken(c.env), { logins: [login] });
  if (!u) return bad(c, 'unknown Twitch login', 404);
  const r = await matchmaking(c.env, { id: u.id, login: u.login, displayName: u.display_name, avatarUrl: u.profile_image_url, demo: false });
  return c.json({
    me: r.me.login, live: r.live, gameName: r.gameName, baseViewers: r.baseViewers, range: r.range, cacheAgeS: Math.round(r.cacheAge / 1000),
    matchCount: r.matches.length,
    allInRange: r.matches.every((m) => m.stream.viewerCount >= r.range[0] && m.stream.viewerCount <= r.range[1]),
    sameGame: r.matches.every((m) => m.stream.gameName === r.gameName),
    matches: r.matches.slice(0, 10).map((m) => ({ login: m.stream.login, viewers: m.stream.viewerCount, ratio: +m.ratio.toFixed(2), score: m.score, lang: m.stream.language, reasons: m.reasons })),
  });
});

// ----- Growth -----
app.get('/api/growth', async (c) => {
  const v = requireViewer(c);
  const ref = { id: v.id, login: v.login, displayName: v.displayName };
  // Starts/flushes the live session first so the report is current (demo: also seeds past streams).
  const live = await overlayStub(c.env, v.login).currentStream(ref);
  const streams = await listStreams(c.env, v.id);
  const wanted = c.req.query('stream') ?? live ?? streams[0]?.id;
  const report = wanted && streams.some((s) => s.id === wanted) ? await streamReport(c.env, wanted) : null;
  return c.json({ channel: ref, streams, report, demo: isDemo(c.env) } satisfies GrowthResponse);
});

// ----- AI co-host (Ollama Cloud, or templates without a key) -----
const aiStatus = (env: Env) => {
  const cfg = aiConfig(env);
  return { provider: cfg.provider, model: cfg.provider === 'ollama' ? cfg.model : null, keySet: cfg.keySet, demo: isDemo(env) };
};

app.get('/api/ai/settings', async (c) => {
  const v = requireViewer(c);
  const [settings, usedToday] = await Promise.all([getAiSettings(c.env, v.id), overlayStub(c.env, v.login).aiUsedToday()]);
  return c.json({ settings, status: aiStatus(c.env), usedToday } satisfies AiSettingsResponse);
});

app.post('/api/ai/settings', async (c) => {
  const v = requireViewer(c);
  const patch = await c.req.json<Partial<AiSettings>>().catch(() => ({}));
  const settings = await saveAiSettings(c.env, v.id, patch);
  await overlayStub(c.env, v.login).aiSettingsChanged();
  return c.json({ settings, status: aiStatus(c.env), usedToday: await overlayStub(c.env, v.login).aiUsedToday() } satisfies AiSettingsResponse);
});

/**
 * Assistant chat. Body: { messages: [{ role: 'user' | 'assistant', content }] } (client-side history, last 12 used).
 * Streams NDJSON AssistantEvents: meta, delta*, actions?, done. Actions are suggestions only.
 */
app.post('/api/assistant', async (c) => {
  const v = requireViewer(c);
  const body = await c.req.json<{ messages?: { role?: string; content?: unknown }[] }>().catch(() => ({ messages: [] as { role?: string; content?: unknown }[] }));
  const history: AiMessage[] = (body.messages ?? []).slice(-12)
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .map((m) => ({ role: m.role as 'user' | 'assistant', content: String(m.content).slice(0, 2000) }));
  if (!history.length || history[history.length - 1].role !== 'user') return bad(c, 'last message must be from the user');
  const cap = Number(c.env.AI_ASSISTANT_DAILY ?? '200');
  if (!(await takeDailyQuota(c.env, v.id, 'assistant', cap))) return c.json({ error: `Assistant limit reached for today (${cap} questions). Resets at 00:00 UTC.` }, 429);
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const w = writable.getWriter();
  const enc = new TextEncoder();
  const send = (ev: AssistantEvent) => w.write(enc.encode(`${JSON.stringify(ev)}\n`));
  c.executionCtx.waitUntil((async () => {
    try { await runAssistant(c.env, v, history, send); }
    catch (e) { console.error('assistant', e); await send({ type: 'error', error: 'The assistant hit a snag. Try again in a moment.' }).catch(() => {}); await send({ type: 'done', ok: false }).catch(() => {}); }
    finally { await w.close().catch(() => {}); }
  })());
  return new Response(readable, { headers: { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
});

/** One-line "why you'd collab" pitch per match (top 12), cached in KV for 6h per pair. */
const PITCH_TTL_S = 6 * 3600;
app.get('/api/ai/pitches', async (c) => {
  const v = requireViewer(c);
  const st = await getAiSettings(c.env, v.id);
  if (!st.pitch) return c.json({ enabled: false, pitches: {}, cached: 0, generated: 0 });
  if (isDemo(c.env)) await ensureDemoSeed(c.env);
  const mm = await matchmaking(c.env, v);
  const top = mm.matches.slice(0, 12);
  const cfg = aiConfig(c.env);
  const key = (id: string) => `pitch:v1:${cfg.provider}:${v.id}:${id}`;
  const got = await Promise.all(top.map((m) => c.env.KV.get<{ text: string; ai: boolean }>(key(m.stream.id), 'json')));
  const pitches: Record<string, { text: string; ai: boolean }> = {};
  const missing = top.filter((m, i) => (got[i] ? ((pitches[m.stream.id] = got[i]!), false) : true));
  if (missing.length && cfg.provider === 'ollama' && !(await takeDailyQuota(c.env, v.id, 'pitch', 100))) {
    return c.json({ enabled: true, pitches, cached: top.length - missing.length, generated: 0, limited: true });
  }
  const fresh = missing.length ? await aiPitches(c.env, { displayName: v.displayName, game: mm.gameName, viewers: mm.baseViewers }, missing) : {};
  // Cache AI results for 6h; template fallbacks only 10 minutes so a model hiccup gets retried soon.
  c.executionCtx.waitUntil(Promise.all(Object.entries(fresh).map(([id, p]) =>
    c.env.KV.put(key(id), JSON.stringify(p), { expirationTtl: p.ai ? PITCH_TTL_S : 600 }))).then(() => {}));
  Object.assign(pitches, fresh);
  return c.json({ enabled: true, pitches, cached: top.length - missing.length, generated: missing.length, provider: cfg.provider });
});

/** AI poll question for a duel, about the streamer's current game. */
app.post('/api/ai/poll-question', async (c) => {
  const v = requireViewer(c);
  const st = await getAiSettings(c.env, v.id);
  if (!st.duel) return bad(c, 'AI duel host is switched off in your AI settings', 403);
  if (aiConfig(c.env).provider === 'ollama' && !(await takeDailyQuota(c.env, v.id, 'poll', 100))) return c.json({ error: 'Poll question limit reached for today' }, 429);
  const { seed } = await c.req.json<{ seed?: string }>().catch(() => ({ seed: undefined }));
  const mm = await matchmaking(c.env, v);
  const q = await aiPollQuestion(c.env, mm.gameName, String(seed ?? Date.now()));
  return c.json({ ...q, game: mm.gameName, provider: aiConfig(c.env).provider });
});

// ---------- Webhooks ----------
app.post('/webhooks/eventsub', (c) => handleEventSub(c.env, c.req.raw, c.executionCtx));

// ---------- Dynamic page shells (static HTML from Astro) ----------
const shell = (path: string) => (c: C) => c.env.ASSETS.fetch(new Request(new URL(path, c.req.url), c.req.raw));
app.get('/overlay/:channel', shell('/overlay/'));
app.get('/overlay/:channel/', shell('/overlay/'));
app.get('/duel/:id', shell('/duel/'));
app.get('/duel/:id/', shell('/duel/'));
app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw));

export default {
  fetch: app.fetch,
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(refreshAllStreams(env).then((r) => console.log('stream cache refreshed', r)));
  },
} satisfies ExportedHandler<Env>;
