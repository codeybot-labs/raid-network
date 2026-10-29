// End-to-end smoke test against a running `npm run dev` (DEMO_MODE).
// Exercises matchmaking, raids, network map, both duel modes over WebSockets, and signed EventSub.
import { chatPayload, raidPayload, sendEventSub } from './fake-eventsub.mjs';

const BASE = process.env.BASE ?? 'http://127.0.0.1:8787';
const WS = BASE.replace(/^http/, 'ws');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok, msg) => { console.log(`${ok ? '✓' : '✗'} ${msg}`); if (!ok) failures++; };

async function api(path, json, headers = {}) {
  const res = await fetch(BASE + path, json === undefined ? { headers } : { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(json) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path} ${res.status} ${JSON.stringify(data)}`);
  return data;
}

function openSocket(path) {
  const ws = new WebSocket(WS + path);
  const msgs = [];
  ws.onmessage = (e) => { try { msgs.push(JSON.parse(e.data)); } catch {} };
  const ready = new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  return { ws, msgs, ready, last: (type) => [...msgs].reverse().find((m) => m.type === type) };
}

async function waitFor(fn, ms = 15000, step = 200) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const v = fn(); if (v) return v; await sleep(step); }
  return null;
}

const health = await api('/api/health');
check(health.demo === true, 'server is in DEMO_MODE');

// Clear leftovers from manual testing so the one-running-duel-per-channel guard doesn't trip.
for (const d of (await api('/api/duels')).duels ?? []) {
  if (['pending', 'accepted', 'countdown', 'live'].includes(d.status)) await api(`/api/duels/${d.id}/cancel`, {}).catch(() => {});
}

const mm = await api('/api/matchmaking');
await api('/api/demo/reset-cooldowns', { channel: mm.me.login });
const RUN = Date.now().toString(36).slice(-5);
check(mm.matches.length > 0, `matchmaking returned ${mm.matches.length} partners in ${mm.gameName} (range ${mm.range.join('-')})`);
check(mm.matches.every((m) => m.stream.viewerCount >= mm.range[0] && m.stream.viewerCount <= mm.range[1]), 'all partners inside 0.5x-2x range');
check(mm.matches.every((m, i, a) => i === 0 || a[i - 1].score >= m.score), 'partners sorted by score');

const net0 = await api('/api/network?scope=all');
const raid = await api('/api/raids', { toId: mm.matches[0].stream.id });
check(raid.ok, `raid button → ${raid.to.displayName}`);
const net1 = await api('/api/network?scope=all');
const raidsCount = (g) => g.edges.reduce((s, e) => s + e.count, 0);
check(raidsCount(net1) === raidsCount(net0) + 1, `network map gained the raid (${raidsCount(net0)} → ${raidsCount(net1)} raids, ${net1.nodes.length} nodes)`);

// ---------- Tug-of-war duel ----------
const opp = mm.matches[1] ?? mm.matches[0];
const created = await api('/api/duels', { opponentId: opp.stream.id, mode: 'tug', durationS: 20 });
const duel = created.duel;
check(duel.status === 'pending', `duel ${duel.id} created vs ${duel.b.displayName} (pending)`);

const board = openSocket(`/api/duels/${duel.id}/ws`);
const ovA = openSocket(`/api/overlay/${duel.a.login}/ws`);
const ovB = openSocket(`/api/overlay/${duel.b.login}/ws`);
await Promise.all([board.ready, ovA.ready, ovB.ready]);
check(!!(await waitFor(() => board.last('state'))), 'duel WebSocket sent initial state');
check(!!(await waitFor(() => ovA.last('hello') && ovB.last('hello'))), 'both overlay WebSockets connected');

await api(`/api/duels/${duel.id}/accept`, {});
check(!!(await waitFor(() => board.last('state')?.state.status === 'accepted')), 'accept pushed to board');
await api(`/api/duels/${duel.id}/start`, {});
check(!!(await waitFor(() => ovA.msgs.some((m) => m.type === 'duel' && m.duelId === duel.id) && ovB.msgs.some((m) => m.type === 'duel' && m.duelId === duel.id))), 'both overlays told about the duel');
check(!!(await waitFor(() => board.last('state')?.state.status === 'live', 9000)), 'countdown → live via DO alarm');

{
  const other = mm.matches.find((m) => m.stream.id !== opp.stream.id);
  const d2 = (await api('/api/duels', { opponentId: other.stream.id, mode: 'tug', durationS: 20 })).duel;
  await api(`/api/duels/${d2.id}/accept`, {});
  const r = await fetch(`${BASE}/api/duels/${d2.id}/start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  check(r.status === 409, `second concurrent duel for the same channel refused (${r.status})`);
  await api(`/api/duels/${d2.id}/cancel`, {});
}

const pulls = (n, prefix) => Array.from({ length: n }, (_, i) => ({ user: `${prefix}${i}`, text: '!pull' }));
const ra = await api('/api/demo/chat', { channel: duel.a.login, messages: [...pulls(10, 'a_user'), { user: 'a_user0', text: '!pull' }, { user: 'a_noise', text: 'hello chat' }] });
check(ra.counted === 10, `channel A: 10 pulls counted (cooldown blocked repeat + noise ignored) → ${ra.counted}`);
check(ra.hype && !ra.hype.hype && !ra.clip, `normal chat pace doesn't trigger an auto-clip (${ra.hype?.rate} msg/s)`);
const rb = await api('/api/demo/chat', { channel: duel.b.login, messages: [...pulls(4, 'b_user'), { user: 'a_user3', text: '!pull' }] });
check(rb.counted === 4, `channel B: 4 pulls counted (cross-chat double agent rejected) → ${rb.counted}`);
let st = await waitFor(() => { const s = board.last('state')?.state; return s && s.a.score === 10 && s.b.score === 4 ? s : null; });
check(!!st, `board state over WebSocket: A=${board.last('state')?.state.a.score} B=${board.last('state')?.state.b.score}`);

const es = await sendEventSub('channel.chat.message', chatPayload(duel.b.login, duel.b.id, '!pull', 'eventsub_fan'));
check(es.status === 204, `signed EventSub chat webhook accepted (${es.status})`);
st = await waitFor(() => { const s = board.last('state')?.state; return s && s.b.score === 5 ? s : null; });
check(!!st, 'EventSub chat message → OverlayDO → DuelDO counted (B=5)');
const forged = await sendEventSub('channel.chat.message', chatPayload(duel.b.login, duel.b.id, '!pull', 'forger'), { secret: 'wrong' });
check(forged.status === 403, `forged EventSub signature rejected (${forged.status})`);

await api(`/api/duels/${duel.id}/simulate`, { on: true });
const before = board.last('state').state;
st = await waitFor(() => { const s = board.last('state')?.state; return s && s.a.score + s.b.score > before.a.score + before.b.score + 10 ? s : null; }, 6000);
check(!!st, `chat simulator drives votes (A=${board.last('state').state.a.score} B=${board.last('state').state.b.score})`);

const fin = await waitFor(() => board.last('state')?.state.status === 'finished' ? board.last('state').state : null, 30000);
check(!!fin, `duel finished, winner=${fin?.winner} (A=${fin?.a.score} B=${fin?.b.score})`);
const list = await api('/api/duels');
const row = list.duels.find((d) => d.id === duel.id);
check(row?.status === 'finished' && row.score_a === fin?.a.score, `D1 duels row persisted (status=${row?.status}, score_a=${row?.score_a}, score_b=${row?.score_b})`);
check(ovA.msgs.some((m) => m.type === 'duel' && m.status === 'finished'), 'overlay notified of finish');
for (const s of [board, ovA, ovB]) s.ws.close();

// ---------- Poll duel ----------
const p = (await api('/api/duels', { opponentId: opp.stream.id, mode: 'poll', durationS: 20, question: 'Best crop?', options: ['Starfruit', 'Ancient Fruit', 'Strawberry'] })).duel;
await api(`/api/duels/${p.id}/accept`, {});
await api(`/api/duels/${p.id}/start`, {});
const pb = openSocket(`/api/duels/${p.id}/ws`);
await pb.ready;
await waitFor(() => pb.last('state')?.state.status === 'live', 9000);
await api('/api/demo/chat', { channel: p.a.login, messages: [{ user: 'v1', text: '!1' }, { user: 'v2', text: '2' }, { user: 'v3', text: '!vote 2' }, { user: 'v1', text: '!3' }, { user: 'v4', text: '!9' }] });
await api('/api/demo/chat', { channel: p.b.login, messages: [{ user: 'w1', text: '!2' }] });
st = await waitFor(() => { const s = pb.last('state')?.state; return s && s.a.voters === 3 && s.b.voters === 1 ? s : null; });
check(!!st && st.a.poll.join() === '0,2,1' && st.b.poll.join() === '0,1,0', `poll votes incl. vote change: A=${st?.a.poll} B=${st?.b.poll}`);
await api(`/api/duels/${p.id}/cancel`, {});
check(!!(await waitFor(() => pb.last('state')?.state.status === 'cancelled')), 'poll duel cancelled');
pb.ws.close();

// ---------- EventSub raid + verification ----------
const rv = await sendEventSub('stream.online', { challenge: 'abc123', subscription: { type: 'stream.online' } }, { messageType: 'webhook_callback_verification' });
check(rv.status === 200 && rv.text === 'abc123', 'EventSub callback verification echoes challenge');
const ovR = openSocket(`/api/overlay/${mm.me.login}/ws`);
await ovR.ready;
const rr = await sendEventSub('channel.raid', raidPayload(opp.stream.login, opp.stream.id, mm.me.login, mm.me.id, 33, opp.stream.displayName, mm.me.displayName));
check(rr.status === 204, 'signed channel.raid accepted');
check(!!(await waitFor(() => ovR.msgs.some((m) => m.type === 'raid'))), 'raid welcome pushed to raided channel overlay');
const wcard = ovR.msgs.find((m) => m.type === 'raid');
check(wcard?.status === 'demo' && wcard.message?.includes(opp.stream.displayName) && wcard.message.includes(`twitch.tv/${opp.stream.login}`),
  `raid welcome card + chat shout-out: "${wcard?.message}"`);
let outbox = (await api(`/api/demo/outbox?channel=${mm.me.login}`)).messages;
check(outbox.some((m) => m.kind === 'welcome' && m.text.includes(opp.stream.displayName)), 'shout-out logged to bot_messages (POST /chat/messages mocked in demo)');
const xr = await api('/api/demo/raid', { from: 'clutchcleo', to: mm.me.login });
check(xr.welcome?.game === 'VALORANT' && xr.welcome.message.includes('from their VALORANT stream') && xr.welcome.raidCount >= 1,
  `cross-game raid welcome mentions their game (raid #${xr.welcome?.raidCount})`);
const xr2 = await api('/api/demo/raid', { from: 'clutchcleo', to: mm.me.login });
check(xr2.welcome?.status === 'cooldown' && xr2.welcome.raidCount === xr.welcome.raidCount + 1, 'repeat raid within 5 min: card shown, no duplicate shout-out');

// ---------- Auto-clips (hype detector) ----------
const few = await api('/api/demo/hype', { channel: mm.me.login, count: 40, users: 2 });
check(!few.clip && few.hype?.reason === 'few-chatters', `40 msgs from only 2 chatters: no clip (${few.hype?.reason})`);
const h1 = await api('/api/demo/hype', { channel: mm.me.login, count: 40 });
check(h1.hype?.hype && !!h1.clip?.id, `hype burst → auto-clip ${h1.clip?.id} (${h1.hype?.rate} msg/s, ${h1.hype?.ratio}× baseline, “${h1.hype?.quote}”)`);
check(!!(await waitFor(() => ovR.msgs.some((m) => m.type === 'clip' && m.clip.id === h1.clip?.id))), 'clip card pushed to overlay');
const h2 = await api('/api/demo/hype', { channel: mm.me.login, count: 40 });
check(!h2.clip && h2.hype?.reason === 'cooldown', `second burst inside cooldown: no clip (${h2.hype?.reason})`);

// ---------- !recap ----------
const fan = `fan_${RUN}`;
const rc = await api('/api/demo/chat', { channel: mm.me.login, messages: [{ user: fan, text: '!recap' }] });
check(rc.recap?.status === 'demo' && /raids? in/.test(rc.recap.text) && rc.recap.text.includes('clip') && /Duels \d+W-\d+L/.test(rc.recap.text) && rc.recap.text.length <= 500,
  `!recap reply: "${rc.recap?.text}"`);
check(!!(await waitFor(() => ovR.msgs.some((m) => m.type === 'recap'))), 'recap card pushed to overlay');
const rc2 = await api('/api/demo/chat', { channel: mm.me.login, messages: [{ user: `${fan}_2`, text: '!recap' }] });
const rcNew = Number(rc.recap?.text.match(/(\d+) new chatters/)?.[1] ?? 1e9) - 1;
check(rc2.recap?.status === 'cooldown', `second !recap within cooldown ignored (${rc2.recap?.status})`);
ovR.ws.close();

// ---------- Growth page ----------
const g = await api('/api/growth');
const gr = g.report;
check(gr?.live && g.streams.length >= 6, `growth: live session + ${g.streams.length - 1} past streams`);
check(gr.raidsIn.some((r) => r.from.id === opp.stream.id) && gr.raidsIn.some((r) => r.from.login === 'clutchcleo'), `growth: raids in listed (${gr.raidsIn.length})`);
check(gr.raidsOut.some((r) => r.to.id === mm.matches[0].stream.id), `growth: raids out listed (${gr.raidsOut.length})`);
check(gr.clips.some((c) => c.id === h1.clip?.id), `growth: auto-clip stored in D1 (${gr.clips.length} clips)`);
check(gr.duels.some((d) => d.id === duel.id && d.myScore === fin?.a.score), `growth: duel result listed (${gr.duels.map((d) => d.result[0].toUpperCase()).join('')})`);
check(gr.stream.newChatters > rcNew && gr.newChatterList.length > 0, `growth: ${gr.stream.newChatters} new chatters (first-timers since the recap counted after DO flush)`);
check(gr.botMessages.some((m) => m.kind === 'welcome') && gr.botMessages.some((m) => m.kind === 'recap'), 'growth: welcomes + recap listed');
check(gr.timeline.length > 0 && gr.timeline.at(-1).msgs > 0, `growth: timeline has ${gr.timeline.length} minutes`);

// Another streamer ends their stream (stream.offline) → finished report; then goes live again.
const login = await fetch(`${BASE}/auth/login?as=${opp.stream.login}`, { redirect: 'manual' });
const cookie = { cookie: (login.headers.get('set-cookie') ?? '').split(';')[0] };
const off = await api('/api/demo/stream', { channel: opp.stream.login, action: 'offline' }, cookie);
const og = await api(`/api/growth?stream=${encodeURIComponent(off.ended ?? '')}`, undefined, cookie);
check(!!off.ended && og.channel.login === opp.stream.login && og.report && !og.report.live && og.report.stream.endedAt > 0,
  `stream.offline → finished report for ${opp.stream.displayName} (${og.report?.duels.length} duels, ${og.report?.stream.chatters} chatters)`);
check(og.report?.duels.some((d) => d.id === duel.id && d.myScore === fin?.b.score), 'finished report shows the duel from the opponent\'s side');
const on = await api('/api/demo/stream', { channel: opp.stream.login, action: 'online' }, cookie);
const og2 = await api('/api/growth', undefined, cookie);
check(og2.report?.live && og2.report.stream.id === on.started && og2.streams[1]?.id === off.ended, 'stream.online → new live session; ended one is in history');

// ---------- Self-hosted fonts ----------
const html = await (await fetch(`${BASE}/growth/`)).text();
const css = html.match(/\/_astro\/[^"]+\.css/g) ?? [];
const cssText = (await Promise.all(css.map((u) => fetch(BASE + u).then((r) => r.text())))).join('');
const woff = cssText.match(/\/_astro\/[^)"']+\.woff2/)?.[0];
check(!/fonts\.(googleapis|gstatic)\.com/.test(html + cssText) && !!woff && (await fetch(BASE + woff)).ok, `fonts self-hosted (${woff})`);

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
