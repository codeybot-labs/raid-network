// End-to-end smoke test against a running `npm run dev` (DEMO_MODE).
// Exercises matchmaking, raids, network map, both duel modes over WebSockets (1v1, free-for-all, teams), and signed EventSub.
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

// ---------- Multi-channel duels (free-for-all + teams) ----------
const asUser = async (login) => {
  const r = await fetch(`${BASE}/auth/login?as=${login}`, { redirect: 'manual' });
  return { cookie: (r.headers.get('set-cookie') ?? '').split(';')[0] };
};
const post = (path, json, headers = {}) => fetch(BASE + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(json) });
const pool = mm.matches.map((m) => m.stream);
// Demo viewer counts jitter every 10 min, so the partner list is 9-12 long; wrap instead of assuming 11.
const P = (i) => pool[i % pool.length];
const chatIn = (login, msgs) => api('/api/demo/chat', { channel: login, messages: msgs });
const pullsFrom = (n, prefix) => Array.from({ length: n }, (_, i) => ({ user: `${prefix}_${RUN}_${i}`, text: '!pull' }));
const sideOf = (st, k) => st.sides.find((x) => x.key === k);
const chOf = (st, id) => st.channels.find((c) => c.id === id);
const overlaysFor = async (logins) => { const o = logins.map((l) => openSocket(`/api/overlay/${l}/ws`)); await Promise.all(o.map((x) => x.ready)); return o; };
const toldAll = (ovs, id) => waitFor(() => ovs.every((o) => o.msgs.some((m) => m.type === 'duel' && m.duelId === id)));

// Validation
{
  const r1 = await post('/api/duels', { format: 'ffa', invites: [{ id: pool[0].id }] });
  const r2 = await post('/api/duels', { format: 'teams', invites: pool.slice(0, 5).map((s) => ({ id: s.id, team: 'b' })) });
  const r3 = await post('/api/duels', { format: 'teams', invites: [{ id: pool[0].id, team: 'a' }] });
  check(r1.status === 400 && r2.status === 400 && r3.status === 400, `bad formats refused (ffa with 1 invite ${r1.status}, 5 on Team B ${r2.status}, empty Team B ${r3.status})`);
}

// FFA, 3 channels, Chat Race: first lane to the finish line wins before the timer.
{
  const [x, y] = [pool[2], pool[3]];
  const d = (await api('/api/duels', { format: 'ffa', mode: 'tug', durationS: 60, raceTarget: 20, invites: [{ id: x.id }, { login: y.login }] })).duel;
  check(d.format === 'ffa' && d.channels.length === 3 && d.sides.map((q) => q.key).join() === 'a,b,c' && d.raceTarget === 20 && d.status === 'pending',
    `FFA-3 created: lanes ${d.channels.map((c) => `${c.side}=${c.login}`).join(' ')} (invite by id + login), finish line ${d.raceTarget}`);
  const xs = await asUser(x.login);
  const inbox = (await api('/api/duels', undefined, xs)).duels.find((q) => q.id === d.id);
  check(inbox?.my_invite === 'pending' && inbox.format === 'ffa' && inbox.channels.length === 3, `FFA invite shows on ${x.displayName}'s dashboard (my_invite=${inbox?.my_invite})`);
  const early = await post(`/api/duels/${d.id}/start`, {});
  check(early.status === 409, `can't start before any invitee accepts (${early.status})`);
  const a1 = (await api(`/api/duels/${d.id}/accept`, {}, xs)).duel; // the invitee answers from their own session
  check(a1.status === 'accepted' && chOf(a1, x.id).invite === 'accepted' && chOf(a1, y.id).invite === 'pending', `invitee accepts from own session → startable with 2 of 3 lanes in (status=${a1.status})`);
  const notHost = await post(`/api/duels/${d.id}/start`, {}, xs);
  check(notHost.status === 403, `only the host starts a multi-channel duel (${notHost.status})`);
  const a2 = (await api(`/api/duels/${d.id}/accept`, { channelId: y.id })).duel; // demo: host answers for the fake streamer
  check(chOf(a2, y.id).invite === 'accepted', 'demo host accepts for the third lane');
  const board3 = openSocket(`/api/duels/${d.id}/ws`); await board3.ready;
  const ovs = await overlaysFor([d.a.login, x.login, y.login]);
  await api(`/api/duels/${d.id}/start`, {});
  check(!!(await toldAll(ovs, d.id)), 'all 3 overlays told about the FFA duel');
  check(!!(await waitFor(() => board3.last('state')?.state.status === 'live', 9000)), 'FFA countdown → live');
  await chatIn(d.a.login, pullsFrom(5, 'ra'));
  await chatIn(x.login, pullsFrom(3, 'rb'));
  const rc = await chatIn(y.login, [...pullsFrom(7, 'rc'), { user: `ra_${RUN}_0`, text: '!pull' }]);
  check(rc.counted === 7, `lane C: 7 pulls, rival-lane chatter rejected → ${rc.counted}`);
  let st = await waitFor(() => { const q = board3.last('state')?.state; return q && sideOf(q, 'a')?.score === 5 && sideOf(q, 'b')?.score === 3 && sideOf(q, 'c')?.score === 7 ? q : null; });
  check(!!st, `FFA chat routing per lane: ${board3.last('state')?.state.sides.map((q) => `${q.key}=${q.score}`).join(' ')}`);
  await chatIn(y.login, pullsFrom(14, 'rc2'));
  st = await waitFor(() => board3.last('state')?.state.status === 'finished' ? board3.last('state').state : null, 5000);
  check(!!st && st.winner === 'c' && st.endedAt < st.endsAt, `race finished early at the line: winner=${st?.winner} (${st?.sides.map((q) => q.score).join('/')})`);
  const row = (await api('/api/duels')).duels.find((q) => q.id === d.id);
  check(row?.format === 'ffa' && row.winner === 'c' && row.channels.find((c) => c.side === 'c')?.score === 21 && JSON.parse(row.results).length === 3,
    `FFA D1 row + per-channel scores persisted (winner=${row?.winner}, lane C=${row?.channels.find((c) => c.side === 'c')?.score})`);
  check(ovs.every((o) => o.msgs.some((m) => m.type === 'duel' && m.status === 'finished')), 'all FFA overlays notified of finish');
  for (const o of [board3, ...ovs]) o.ws.close();
}

// FFA, 4 channels, Chat Poll: same question everywhere, most voters wins at the timer.
{
  const four = [pool[4], pool[5], pool[6]];
  const d = (await api('/api/duels', { format: 'ffa', mode: 'poll', durationS: 20, question: 'Best season?', options: ['Spring', 'Summer', 'Fall', 'Winter'], autoAccept: true,
    invites: four.map((q) => ({ id: q.id })) })).duel;
  check(d.status === 'accepted' && d.channels.every((c) => c.invite === 'host' || c.invite === 'accepted') && d.sides.length === 4, `FFA-4 poll with demo auto-accept: ${d.sides.length} lanes, status=${d.status}`);
  const b4 = openSocket(`/api/duels/${d.id}/ws`); await b4.ready;
  await api(`/api/duels/${d.id}/start`, {});
  await waitFor(() => b4.last('state')?.state.status === 'live', 9000);
  const v = (pfx, n, opt) => Array.from({ length: n }, (_, i) => ({ user: `${pfx}_${RUN}_${i}`, text: `!${opt}` }));
  await chatIn(d.a.login, v('pa', 2, 1));
  await chatIn(four[0].login, v('pb', 3, 2));
  await chatIn(four[1].login, [...v('pc', 5, 3), { user: `pc_${RUN}_0`, text: '!4' }]);
  await chatIn(four[2].login, [...v('pd', 1, 4), { user: `pa_${RUN}_1`, text: '!2' }]);
  const st = await waitFor(() => { const q = b4.last('state')?.state; return q && q.sides.map((x) => x.voters).join() === '2,3,5,1' ? q : null; });
  check(!!st && sideOf(st, 'c').poll.join() === '0,0,4,1' && st.sides.reduce((t, x) => t + x.poll[3], 0) === 2,
    `FFA-4 poll per-lane results (voters ${st?.sides.map((x) => x.voters).join('/')}, lane C ${sideOf(st ?? { sides: [] }, 'c')?.poll}, vote change + cross-lane voter handled)`);
  const fin4 = await waitFor(() => b4.last('state')?.state.status === 'finished' ? b4.last('state').state : null, 30000);
  check(fin4?.winner === 'c', `FFA-4 poll winner = lane with most voters (${fin4?.winner})`);
  b4.ws.close();
}

// Teams 2v2, Team Tug: every chat on a team pulls the same rope.
{
  const [y, x, z] = [P(7), P(8), P(9)]; // y on A with the host, x + z on B
  const d = (await api('/api/duels', { format: 'teams', mode: 'tug', durationS: 20, teamNames: ['Cozy Crew', 'Night Owls'],
    invites: [{ login: x.login, team: 'b' }, { id: y.id, team: 'a' }, { id: z.id, team: 'b' }] })).duel;
  check(d.format === 'teams' && d.channels.filter((c) => c.side === 'a').length === 2 && d.channels.filter((c) => c.side === 'b').length === 2 && d.a.displayName === 'Cozy Crew',
    `Teams 2v2 created (${d.a.displayName}: ${d.channels.filter((c) => c.side === 'a').map((c) => c.login)} vs ${d.b.displayName}: ${d.channels.filter((c) => c.side === 'b').map((c) => c.login)})`);
  await api(`/api/duels/${d.id}/accept`, {}); // demo: everyone pending says yes
  const bt = openSocket(`/api/duels/${d.id}/ws`); await bt.ready;
  const ovs = await overlaysFor([d.a.login, y.login, x.login, z.login]);
  await api(`/api/duels/${d.id}/start`, {});
  check(!!(await toldAll(ovs, d.id)), 'all 4 team overlays told about the duel');
  await waitFor(() => bt.last('state')?.state.status === 'live', 9000);
  await chatIn(d.a.login, pullsFrom(4, 'ta'));
  await chatIn(y.login, pullsFrom(3, 'ty'));
  await chatIn(x.login, pullsFrom(2, 'tx'));
  const rz = await chatIn(z.login, [...pullsFrom(6, 'tz'), { user: `ta_${RUN}_1`, text: '!pull' }]);
  check(rz.counted === 6, `Team B chat rejects a Team A chatter → ${rz.counted}`);
  await sleep(1600); // past the per-chatter pull cooldown
  const hop = await chatIn(y.login, [{ user: `ta_${RUN}_0`, text: '!pull' }]);
  check(hop.counted === 1, 'chatter hopping between teammates\' chats still counts for their team');
  const st = await waitFor(() => { const q = bt.last('state')?.state; return q && q.a.score === 8 && q.b.score === 8 ? q : null; });
  check(!!st && sideOf(st, 'a').score === 8 && chOf(st, y.id).score === 4 && chOf(st, z.id).score === 6,
    `team totals aggregate channels: A=${bt.last('state')?.state.a.score} (host ${chOf(bt.last('state').state, d.a.id).score} + ${y.login} ${chOf(bt.last('state').state, y.id).score}) B=${bt.last('state')?.state.b.score}`);
  check(st?.top.some((t) => t.side === 'a') && st.top.some((t) => t.side === 'b') && st.top.filter((t) => t.side === 'a').length <= 3,
    `top chatters per team on the board (${st?.top.map((t) => `${t.side}:${t.login}@${t.channelLogin}`).slice(0, 2).join(', ')}…)`);
  await chatIn(x.login, pullsFrom(3, 'tx2'));
  const fin = await waitFor(() => bt.last('state')?.state.status === 'finished' ? bt.last('state').state : null, 30000);
  check(fin?.winner === 'b' && fin.b.score === 11, `Teams 2v2 winner=${fin?.winner} (${fin?.a.score}-${fin?.b.score})`);
  const og = await api('/api/growth', undefined, await asUser(z.login));
  const gd = og.report?.duels.find((q) => q.id === d.id);
  check(gd?.format === 'teams' && gd.result === 'win' && gd.myScore === 11 && gd.theirScore === 8, `teammate's growth page: ${gd?.result} ${gd?.myScore}-${gd?.theirScore} vs ${gd?.opponent.displayName}`);
  for (const o of [bt, ...ovs]) o.ws.close();
}

// Teams 4v4, Chat Poll: 7 invites, all chats aggregate; plus the multi-channel chat simulator.
{
  const seven = pool.slice(0, 7);
  const teamOf = (i) => (i < 3 ? 'a' : 'b');
  const d = (await api('/api/duels', { format: 'teams', mode: 'poll', durationS: 60, question: 'Best crop?', options: ['Starfruit', 'Melon', 'Pumpkin'],
    invites: seven.map((q, i) => ({ id: q.id, team: teamOf(i) })) })).duel;
  check(d.channels.length === 8 && d.channels.filter((c) => c.side === 'a').length === 4, 'Teams 4v4 created (8 channels)');
  const self = await asUser(seven[6].login);
  for (const q of seven.slice(0, 6)) await api(`/api/duels/${d.id}/accept`, { channelId: q.id });
  const last = (await api(`/api/duels/${d.id}/accept`, {}, self)).duel;
  check(last.channels.every((c) => c.invite === 'host' || c.invite === 'accepted'), 'all 7 invitees accepted (6 demo + 1 own session)');
  const b8 = openSocket(`/api/duels/${d.id}/ws`); await b8.ready;
  const ovs = await overlaysFor(last.channels.map((c) => c.login));
  await api(`/api/duels/${d.id}/start`, {});
  check(!!(await toldAll(ovs, d.id)), 'all 8 overlays told about the 4v4');
  await waitFor(() => b8.last('state')?.state.status === 'live', 9000);
  for (const [i, c] of last.channels.entries()) await chatIn(c.login, [{ user: `q${i}_${RUN}`, text: `!${(i % 3) + 1}` }, { user: `q${i}b_${RUN}`, text: '!1' }]);
  const st = await waitFor(() => { const q = b8.last('state')?.state; return q && q.a.voters === 8 && q.b.voters === 8 ? q : null; });
  check(!!st && st.a.poll.reduce((t, n) => t + n, 0) === 8 && st.channels.every((c) => c.voters === 2) && st.a.poll.join() === sideOf(st, 'a').poll.join(),
    `4v4 poll aggregates 8 chats: A voters=${st?.a.voters} ${st?.a.poll} · B voters=${st?.b.voters} ${st?.b.poll}`);
  await api(`/api/duels/${d.id}/simulate`, { on: true });
  const sim = await waitFor(() => { const q = b8.last('state')?.state; return q && q.channels.every((c) => c.voters > 3) ? q : null; }, 8000);
  check(!!sim, `chat simulator drives all 8 channels (${b8.last('state')?.state.channels.map((c) => c.voters).join('/')})`);
  await api(`/api/duels/${d.id}/cancel`, {});
  check(!!(await waitFor(() => ovs.every((o) => o.msgs.some((m) => m.type === 'duel' && m.status === 'cancelled')))), '4v4 cancelled; every overlay cleared');
  for (const o of [b8, ...ovs]) o.ws.close();
}

// Decliners and no-shows are dropped when the host starts.
{
  const [x, y, z] = [P(8), P(9), P(10)];
  const d = (await api('/api/duels', { format: 'teams', mode: 'tug', durationS: 20, invites: [{ id: x.id, team: 'b' }, { id: y.id, team: 'b' }, { id: z.id, team: 'a' }] })).duel;
  await api(`/api/duels/${d.id}/decline`, { channelId: y.id });
  const acc = (await api(`/api/duels/${d.id}/accept`, { channelId: x.id })).duel;
  check(acc.status === 'accepted' && chOf(acc, z.id).invite === 'pending', 'startable with one invitee still pending');
  const ovZ = openSocket(`/api/overlay/${z.login}/ws`); await ovZ.ready;
  const started = (await api(`/api/duels/${d.id}/start`, {})).duel;
  check(chOf(started, y.id).invite === 'declined' && chOf(started, z.id).invite === 'dropped' && started.sides.find((q) => q.key === 'b').channelIds.length === 1,
    'start drops the pending invitee; decliner stays out');
  const rz = await sleep(5600).then(() => chatIn(z.login, pullsFrom(3, 'dz')));
  check(rz.counted === 0 && !ovZ.msgs.some((m) => m.type === 'duel' && m.duelId === d.id), 'dropped channel\'s chat and overlay are not part of the duel');
  await api(`/api/duels/${d.id}/cancel`, {});
  ovZ.ws.close();
}

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

// ---------- AI co-host + assistant (mock provider: no OLLAMA_API_KEY / DEMO_MODE) ----------
const ALL_ON = { welcome: true, recap: true, duel: true, ask: true, pitch: true, dailyCap: 150 };
const aiS = await api('/api/ai/settings', ALL_ON);
check(aiS.status.provider === 'mock' && aiS.status.model === null && aiS.status.demo === true, `AI provider in demo: ${aiS.status.provider} (key set: ${aiS.status.keySet})`);
check(['welcome', 'recap', 'duel', 'ask', 'pitch'].every((k) => aiS.settings[k] === true) && aiS.settings.dailyCap === 150, 'AI settings: all features on, daily cap 150');

async function assistant(content, history = []) {
  const res = await fetch(`${BASE}/api/assistant`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messages: [...history, { role: 'user', content }] }) });
  const evs = (await res.text()).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return { status: res.status, type: res.headers.get('content-type'), evs, text: evs.filter((e) => e.type === 'delta').map((e) => e.text).join(''),
    deltas: evs.filter((e) => e.type === 'delta').length, actions: evs.find((e) => e.type === 'actions')?.actions ?? [] };
}
const duelsBefore = (await api('/api/duels')).duels.length;
const raidsBefore = raidsCount(await api('/api/network?scope=all'));
const mmNow = await api('/api/matchmaking');
const a1 = await assistant('Who should I raid tonight?');
check(a1.status === 200 && a1.type.includes('ndjson') && a1.evs[0]?.type === 'meta' && a1.evs[0].intent === 'raid' && a1.evs.at(-1)?.type === 'done' && a1.deltas > 5,
  `assistant streams NDJSON (${a1.deltas} deltas, intent ${a1.evs[0]?.intent}, provider ${a1.evs[0]?.provider})`);
const top3 = mmNow.matches.slice(0, 3).map((m) => m.stream.id);
check(a1.actions.length >= 1 && a1.actions.every((x) => x.type === 'raid' && top3.includes(x.id)) && a1.text.includes(a1.actions[0].displayName),
  `assistant raid picks grounded in matchmaking: ${a1.actions.map((x) => x.displayName).join(', ')}`);
const duelTarget = mmNow.matches[2] ?? mmNow.matches[0];
const a2 = await assistant(`Set up a duel with ${duelTarget.stream.login}`, [{ role: 'user', content: 'Who should I raid tonight?' }, { role: 'assistant', content: a1.text }]);
check(a2.evs[0]?.intent === 'duel' && a2.actions.length === 1 && a2.actions[0].type === 'duel' && a2.actions[0].login === duelTarget.stream.login,
  `assistant duel → one "Duel ${a2.actions[0]?.displayName}" button`);
const a3 = await assistant('How did my last stream go?');
check(a3.evs[0]?.intent === 'growth' && /Peak viewers/.test(a3.text) && /new/.test(a3.text) && a3.actions.some((x) => x.type === 'link' && x.href.startsWith('/growth/')),
  'assistant growth answer from the stream report + link');
const a4 = await assistant('show my raid network');
check(a4.evs[0]?.intent === 'network' && /Raids in/.test(a4.text), 'assistant raid-network stats');
check((await api('/api/duels')).duels.length === duelsBefore && raidsCount(await api('/api/network?scope=all')) === raidsBefore,
  'assistant never raids or invites by itself (duel + raid counts unchanged)');
const aBad = await fetch(`${BASE}/api/assistant`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messages: [] }) });
check(aBad.status === 400, `assistant rejects empty history (${aBad.status})`);

const p1 = await api('/api/ai/pitches');
const pv = Object.values(p1.pitches);
check(p1.enabled && pv.length === Math.min(12, mmNow.matches.length) && pv.every((x) => x.text.length > 10 && x.text.length <= 140),
  `collab pitch per match card (${pv.length}): "${pv[0]?.text}"`);
const p2 = await api('/api/ai/pitches');
check(p2.cached === pv.length && p2.generated === 0, `pitches cached in KV on 2nd load (${p2.cached} cached, ${p2.generated} generated)`);
await api('/api/ai/settings', { pitch: false });
check((await api('/api/ai/pitches')).enabled === false, 'pitch toggle off → no pitches');
await api('/api/ai/settings', { pitch: true });
const pq = await api('/api/ai/poll-question', { seed: RUN });
check(typeof pq.question === 'string' && pq.question.length > 5 && pq.options.length >= 2 && pq.options.length <= 4 && pq.game === mm.gameName,
  `AI poll question for ${pq.game}: "${pq.question}" [${pq.options?.join(' / ')}]`);

const me = mm.me.login;
const chat = (msgs) => api('/api/demo/chat', { channel: me, messages: msgs });
await api('/api/demo/reset-cooldowns', { channel: me });
const k1 = await chat([{ user: `asker_${RUN}`, text: '!ask what game is this?' }]);
check(k1.ask?.status === 'demo' && k1.ask.text.startsWith(`@asker_${RUN}`) && k1.ask.text.includes(mm.gameName) && k1.ask.text.length <= 300, `!ask answered: "${k1.ask?.text}"`);
const k2 = await chat([{ user: `asker_${RUN}`, text: '!ask how long have you been live?' }]);
check(k2.ask?.status === 'cooldown', `same viewer !ask again → ${k2.ask?.status} (60s per-user cooldown)`);
const k3 = await chat([{ user: `asker2_${RUN}`, text: '!ask how long have you been live?' }]);
check(k3.ask?.status === 'rate-limited', `another viewer within 20s → ${k3.ask?.status} (1 AI message / channel / 20s)`);
await api('/api/demo/reset-cooldowns', { channel: me, keepDaily: true });
const k3b = await chat([{ user: `asker2_${RUN}`, text: '!ask how long have you been live?' }]);
check(k3b.ask?.status === 'demo' && /live for \d/.test(k3b.ask.text), `after the gap: "${k3b.ask?.text}"`);
await api('/api/demo/reset-cooldowns', { channel: me });
const k4 = await chat([{ user: `troll_${RUN}`, text: '!ask why is the streamer so stupid' }]);
check(k4.ask?.status === 'blocked', `ban-word filter on !ask → ${k4.ask?.status}`);
await api('/api/ai/settings', { ask: false });
const k5 = await chat([{ user: `asker4_${RUN}`, text: '!ask hello?' }]);
check(k5.ask?.status === 'disabled', `!ask toggle off → ${k5.ask?.status}`);
await api('/api/ai/settings', { ask: true, dailyCap: 1 });
await api('/api/demo/reset-cooldowns', { channel: me });
const k6 = await chat([{ user: `asker5_${RUN}`, text: '!ask what are the commands?' }]);
await api('/api/demo/reset-cooldowns', { channel: me, keepDaily: true });
const k7 = await chat([{ user: `asker6_${RUN}`, text: '!ask what are the commands?' }]);
check(k6.ask?.status === 'demo' && k6.ask.text.includes('!pull') && k7.ask?.status === 'daily-cap', `daily cap 1 → next AI message ${k7.ask?.status}`);
const used = await api('/api/ai/settings', ALL_ON);
check(used.usedToday === 1, `AI usage today reported on dashboard (${used.usedToday})`);

await api('/api/demo/reset-cooldowns', { channel: me });
const wr = mmNow.matches.find((m) => m.stream.login !== opp.stream.login && m.stream.login !== duelTarget.stream.login) ?? mmNow.matches[0];
const aw = await api('/api/demo/raid', { from: wr.stream.login, to: me });
check(aw.welcome?.ai === true && aw.welcome.status === 'demo' && aw.welcome.message.includes(wr.stream.displayName) && aw.welcome.message.includes(`twitch.tv/${wr.stream.login}`) && aw.welcome.message.length <= 300,
  `AI raid welcome uses their game/title: "${aw.welcome?.message}"`);
await api('/api/ai/settings', { welcome: false });
await api('/api/demo/reset-cooldowns', { channel: me });
const aw2 = await api('/api/demo/raid', { from: 'clutchcleo', to: me });
check(aw2.welcome?.ai !== true && aw2.welcome?.status === 'demo' && aw2.welcome.message.includes('from their VALORANT stream'), 'welcome toggle off → classic template shout-out');
await api('/api/ai/settings', ALL_ON);
await api('/api/demo/reset-cooldowns', { channel: me });
const ar = await chat([{ user: `fan2_${RUN}`, text: '!recap' }]);
check(ar.recap?.ai === true && ar.recap.status === 'demo' && /Duels \d+W-\d+L/.test(ar.recap.text) && ar.recap.text.length <= 300, `AI !recap (≤300 chars): "${ar.recap?.text}"`);

await api('/api/demo/reset-cooldowns', { channel: me });
await api('/api/demo/reset-cooldowns', { channel: duelTarget.stream.login });
const hd = (await api('/api/duels', { opponentId: duelTarget.stream.id, mode: 'tug', durationS: 20 })).duel;
await api(`/api/duels/${hd.id}/accept`, {});
await api(`/api/duels/${hd.id}/start`, {});
let duelMsg = null;
for (let i = 0; i < 60 && !duelMsg; i++) {
  await sleep(250);
  duelMsg = (await api(`/api/demo/outbox?channel=${me}`)).messages.find((m) => m.kind === 'duel' && m.created_at >= hd.createdAt);
}
check(!!duelMsg && /!pull/.test(duelMsg.text) && duelMsg.text.length <= 300, `AI duel host line in chat at go-live: "${duelMsg?.text}"`);
const oppLine = (await api(`/api/demo/outbox?channel=${duelTarget.stream.login}`)).messages.find((m) => m.kind === 'duel' && m.created_at >= hd.createdAt);
check(!!oppLine, 'duel host line also posted in the opponent chat');
await api(`/api/duels/${hd.id}/cancel`, {}).catch(() => {});
const ob = (await api(`/api/demo/outbox?channel=${me}`)).messages;
check(ob.filter((m) => ['ask', 'duel', 'recap', 'welcome'].includes(m.kind)).every((m) => m.text.length <= 500) && ob.filter((m) => ['ask', 'duel'].includes(m.kind)).every((m) => m.text.length <= 300),
  'AI chat lines logged to bot_messages and within Twitch limits');

// ---------- OBS overlay board size (s / m / l, default l) ----------
{
  const meLogin = mm.me.login;
  const raw = async (path, init) => { const r = await fetch(BASE + path, init); return { status: r.status, body: await r.json().catch(() => ({})) }; };
  const before = await api('/api/overlay-settings');
  check(['s', 'm', 'l'].includes(before.size), `overlay settings readable (size=${before.size})`);
  const bad = await raw('/api/overlay-settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ size: 'xl' }) });
  check(bad.status === 400, `invalid board size rejected (${bad.status})`);
  const ov = openSocket(`/api/overlay/${meLogin}/ws`); await ov.ready;
  await waitFor(() => ov.last('hello'));
  const saved = await api('/api/overlay-settings', { size: 'm' });
  const cfg = await api(`/api/overlay/${meLogin}/config`);
  check(saved.size === 'm' && cfg.size === 'm', `saved size persists and the public overlay config returns it (${cfg.size})`);
  check(!!(await waitFor(() => ov.msgs.some((m) => m.type === 'size' && m.size === 'm'), 5000)), 'open overlay told about the new size (live resize)');
  ov.ws.close();
  const other = await api(`/api/overlay/zz_nobody_${RUN}/config`);
  check(other.size === 'l', `channels without a saved size default to large (${other.size})`);
  await api('/api/overlay-settings', { size: before.size === 'm' ? 'l' : before.size });
  const page = await fetch(`${BASE}/overlay/${meLogin}?size=s`);
  check(page.ok && /text\/html/.test(page.headers.get('content-type') ?? ''), `overlay page serves with ?size= param (${page.status})`);
}

// ---------- Self-hosted fonts ----------
const html = await (await fetch(`${BASE}/growth/`)).text();
const css = html.match(/\/_astro\/[^"]+\.css/g) ?? [];
const cssText = (await Promise.all(css.map((u) => fetch(BASE + u).then((r) => r.text())))).join('');
const woff = cssText.match(/\/_astro\/[^)"']+\.woff2/)?.[0];
check(!/fonts\.(googleapis|gstatic)\.com/.test(html + cssText) && !!woff && (await fetch(BASE + woff)).ok, `fonts self-hosted (${woff})`);

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
