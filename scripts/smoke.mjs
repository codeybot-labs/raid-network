// End-to-end smoke test against a running `npm run dev` (DEMO_MODE).
// Exercises matchmaking, raids, network map, both duel modes over WebSockets, and signed EventSub.
import { chatPayload, raidPayload, sendEventSub } from './fake-eventsub.mjs';

const BASE = process.env.BASE ?? 'http://127.0.0.1:8787';
const WS = BASE.replace(/^http/, 'ws');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok, msg) => { console.log(`${ok ? '✓' : '✗'} ${msg}`); if (!ok) failures++; };

async function api(path, json) {
  const res = await fetch(BASE + path, json === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(json) });
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
const rr = await sendEventSub('channel.raid', raidPayload(opp.stream.login, opp.stream.id, mm.me.login, mm.me.id, 33));
check(rr.status === 204, 'signed channel.raid accepted');
check(!!(await waitFor(() => ovR.msgs.some((m) => m.type === 'raid'))), 'raid welcome pushed to raided channel overlay');
ovR.ws.close();

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
