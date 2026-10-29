import { Hono, type Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { appUrl, duelStub, isDemo, overlayStub, type AppEnv, type Env } from './env';
import type { ChannelRef, ChatMessage, DuelMode, GrowthResponse, Viewer } from '../shared/types';
import { listStreams, streamReport } from './lib/growth';
import { randomId } from './lib/crypto';
import { DEMO_ME, allDemoLogins, demoFindStream, ensureDemoSeed } from './lib/demo';
import { handleEventSub, subscribeChannel } from './lib/eventsub';
import { authorizeUrl, appToken, exchangeCode, getUsers, startRaid, HelixError } from './lib/helix';
import { matchmaking, raidGraph } from './lib/matchmaking';
import { createSession, demoViewer, destroySession, getViewer } from './lib/session';
import { refreshAllStreams } from './lib/streams';
import { saveTokens, userToken } from './lib/tokens';

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

app.get('/api/duels', async (c) => {
  const v = requireViewer(c);
  const rows = await c.env.DB.prepare(
    'SELECT * FROM duels WHERE challenger_id = ?1 OR opponent_id = ?1 ORDER BY created_at DESC LIMIT 20').bind(v.id).all();
  return c.json({ duels: rows.results });
});

app.post('/api/duels', async (c) => {
  const v = requireViewer(c);
  const body = await c.req.json<{ opponentId: string; mode?: DuelMode; question?: string; options?: string[]; durationS?: number }>();
  const opp = await resolveChannel(c, body.opponentId);
  if (!opp) return bad(c, 'unknown opponent', 404);
  if (opp.id === v.id) return bad(c, "you can't duel yourself");
  const mode: DuelMode = body.mode === 'poll' ? 'poll' : 'tug';
  const durationS = Math.min(300, Math.max(20, Math.round(body.durationS ?? 90)));
  const options = mode === 'poll' ? (body.options ?? []).map((o) => String(o).trim().slice(0, 40)).filter(Boolean).slice(0, 4) : [];
  if (mode === 'poll' && options.length < 2) return bad(c, 'a poll duel needs 2-4 options');
  const question = String(body.question ?? (mode === 'tug' ? 'Tug of War: spam !pull for your streamer!' : '')).slice(0, 120);
  const id = randomId(10);
  await c.env.DB.prepare(
    `INSERT INTO duels (id, challenger_id, challenger_login, challenger_name, opponent_id, opponent_login, opponent_name, mode, question, options, duration_s, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
  ).bind(id, v.id, v.login, v.displayName, opp.id, opp.login, opp.displayName, mode, question, JSON.stringify(options), durationS, Date.now()).run();
  const state = await duelStub(c.env, id).init({
    id, mode, question, options, durationS, demo: isDemo(c.env),
    a: { id: v.id, login: v.login, displayName: v.displayName, avatarUrl: v.avatarUrl }, b: opp,
  });
  c.executionCtx.waitUntil(overlayStub(c.env, opp.login).toast(`${v.displayName} challenged you to a duel!`).catch(() => {}));
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
  const isA = row.challenger_id === v.id;
  const isB = row.opponent_id === v.id;
  const demo = isDemo(c.env);
  const stub = duelStub(c.env, id);
  try {
    switch (action) {
      case 'accept':
      case 'decline':
        // In demo mode the challenger may answer on behalf of the fake opponent.
        if (!isB && !(demo && isA)) return bad(c, 'only the invited streamer can respond', 403);
        return c.json({ duel: await stub.respond(action === 'accept') });
      case 'start': {
        if (!isA && !isB) return bad(c, 'not your duel', 403);
        // One running duel per channel: the overlay can only show one board.
        const cur = await stub.getState();
        for (const side of cur ? [cur.a, cur.b] : []) {
          const other = await overlayStub(c.env, side.login).getActiveDuel();
          if (other && other !== id) {
            const o = await duelStub(c.env, other).getState();
            if (o && ['countdown', 'live'].includes(o.status)) return bad(c, `${side.displayName} is already in a running duel`, 409);
          }
        }
        return c.json({ duel: await stub.start() });
      }
      case 'cancel':
        if (!isA && !isB) return bad(c, 'not your duel', 403);
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
  const { channel } = await c.req.json<{ channel: string }>();
  await overlayStub(c.env, channel).resetCooldowns();
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
