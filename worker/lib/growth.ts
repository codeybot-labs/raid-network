import { isDemo, type Env } from '../env';
import type { ChannelRef, ClipInfo, DuelFormat, GrowthReport, StreamSummary, TimelinePoint } from '../../shared/types';
import { fakeChatter } from '../durable/chat';
import { welcomeText } from './chatbot';
import { getClips } from './helix';

export interface StreamRow {
  id: string; channel_id: string; channel_login: string; title: string | null; game_name: string | null;
  started_at: number; ended_at: number | null; peak_viewers: number; messages: number; timeline: string | null; source: string;
}

type SummaryRow = StreamRow & { chatters: number; new_chatters: number; raids_in: number };

const toSummary = (r: SummaryRow): StreamSummary => ({
  id: r.id, title: r.title, gameName: r.game_name, startedAt: r.started_at, endedAt: r.ended_at, peakViewers: r.peak_viewers,
  messages: r.messages, chatters: r.chatters, newChatters: r.new_chatters, raidsIn: r.raids_in, source: r.source,
});

const SUMMARY_SQL = `SELECT s.*,
  (SELECT COUNT(*) FROM stream_chatters sc WHERE sc.stream_id = s.id) AS chatters,
  (SELECT COUNT(*) FROM chatters c WHERE c.channel_id = s.channel_id AND c.first_stream_id = s.id) AS new_chatters,
  (SELECT COUNT(*) FROM raids r WHERE r.to_id = s.channel_id AND r.created_at BETWEEN s.started_at AND COALESCE(s.ended_at, ?2)) AS raids_in
  FROM streams s`;

export async function listStreams(env: Env, channelId: string, limit = 12): Promise<StreamSummary[]> {
  const rows = await env.DB.prepare(`${SUMMARY_SQL} WHERE s.channel_id = ?1 ORDER BY s.started_at DESC LIMIT ?3`)
    .bind(channelId, Date.now(), limit).all<SummaryRow>();
  return rows.results.map(toSummary);
}

/** One finished duel from this channel's point of view (1v1, free-for-all or teams). */
function duelResult(d: Record<string, any>, ch: string): GrowthReport['duels'][number] {
  const format: DuelFormat = d.format ?? '1v1';
  const mySide: string = d.my_side ?? (d.challenger_id === ch ? 'a' : 'b');
  const results: { key: string; name: string; score: number }[] | null = d.results ? JSON.parse(d.results) : null;
  const others: { id: string; login: string; name: string | null; side: string }[] = d.others ? JSON.parse(d.others) : [];
  const scoreOf = (k: string) => results?.find((r) => r.key === k)?.score ?? (k === 'a' ? d.score_a : k === 'b' ? d.score_b : 0);
  const myScore = scoreOf(mySide);
  const rivalKeys = results ? results.map((r) => r.key).filter((k) => k !== mySide) : [mySide === 'a' ? 'b' : 'a'];
  const theirScore = Math.max(0, ...rivalKeys.map(scoreOf));
  const result = d.winner === 'tie' ? 'tie' as const : d.winner === mySide ? 'win' as const : 'loss' as const;
  let opponent: ChannelRef;
  if (format === '1v1' || !others.length) {
    opponent = d.challenger_id === ch
      ? { id: d.opponent_id, login: d.opponent_login, displayName: d.opponent_name ?? d.opponent_login }
      : { id: d.challenger_id, login: d.challenger_login, displayName: d.challenger_name ?? d.challenger_login };
  } else {
    const rivals = format === 'teams' ? others.filter((o) => o.side !== mySide) : others;
    const lead = rivals[0] ?? others[0];
    const name = (o: typeof lead) => o.name ?? o.login;
    opponent = { id: lead.id, login: lead.login, displayName: rivals.length > 1 ? `${name(lead)} +${rivals.length - 1}` : name(lead) };
  }
  return { id: d.id, opponent, format, mode: d.mode, result, myScore, theirScore, at: d.ended_at };
}

export async function streamReport(env: Env, streamId: string): Promise<GrowthReport | null> {
  const now = Date.now();
  const s = await env.DB.prepare(`${SUMMARY_SQL} WHERE s.id = ?1`).bind(streamId, now).first<SummaryRow>();
  if (!s) return null;
  const from = s.started_at;
  const to = s.ended_at ?? now;
  const ch = s.channel_id;
  const [rin, rout, clips, duels, newList, top, bots] = await env.DB.batch([
    env.DB.prepare('SELECT from_id, from_login, from_name, viewers, created_at, source FROM raids WHERE to_id = ? AND created_at BETWEEN ? AND ? ORDER BY created_at').bind(ch, from, to),
    env.DB.prepare('SELECT to_id, to_login, to_name, viewers, created_at, source FROM raids WHERE from_id = ? AND created_at BETWEEN ? AND ? ORDER BY created_at').bind(ch, from, to),
    env.DB.prepare('SELECT * FROM clips WHERE stream_id = ?1 OR (stream_id IS NULL AND channel_id = ?2 AND created_at BETWEEN ?3 AND ?4) ORDER BY score DESC, created_at DESC LIMIT 20').bind(s.id, ch, from, to),
    env.DB.prepare(`SELECT d.*, dc.side AS my_side,
      (SELECT json_group_array(json_object('id', o.channel_id, 'login', o.login, 'name', o.display_name, 'side', o.side))
         FROM duel_channels o WHERE o.duel_id = d.id AND o.channel_id != ?1 AND o.status IN ('host', 'accepted')) AS others
      FROM duels d LEFT JOIN duel_channels dc ON dc.duel_id = d.id AND dc.channel_id = ?1
      WHERE (d.challenger_id = ?1 OR d.opponent_id = ?1 OR dc.channel_id IS NOT NULL) AND d.status = 'finished' AND d.ended_at BETWEEN ?2 AND ?3
      ORDER BY d.ended_at`).bind(ch, from, to),
    env.DB.prepare(`SELECT c.login, sc.messages FROM chatters c JOIN stream_chatters sc ON sc.stream_id = c.first_stream_id AND sc.user_id = c.user_id
      WHERE c.channel_id = ? AND c.first_stream_id = ? ORDER BY sc.messages DESC LIMIT 16`).bind(ch, s.id),
    env.DB.prepare(`SELECT sc.login, sc.messages, (c.first_stream_id = sc.stream_id) AS is_new FROM stream_chatters sc
      LEFT JOIN chatters c ON c.channel_id = ? AND c.user_id = sc.user_id WHERE sc.stream_id = ? ORDER BY sc.messages DESC LIMIT 8`).bind(ch, s.id),
    env.DB.prepare('SELECT kind, text, status, created_at FROM bot_messages WHERE channel_id = ? AND created_at BETWEEN ? AND ? ORDER BY created_at DESC LIMIT 20').bind(ch, from, to),
  ]);
  type R = Record<string, any>;
  const timeline: TimelinePoint[] = s.timeline ? JSON.parse(s.timeline) : [];
  return {
    stream: toSummary(s),
    durationMs: to - from,
    live: s.ended_at === null,
    timeline,
    raidsIn: (rin.results as R[]).map((r) => ({ from: { id: r.from_id, login: r.from_login, displayName: r.from_name ?? r.from_login }, viewers: r.viewers, at: r.created_at, confirmed: r.source === 'eventsub' || r.source === 'demo' || r.source === 'seed' })),
    raidsOut: (rout.results as R[]).map((r) => ({ to: { id: r.to_id, login: r.to_login, displayName: r.to_name ?? r.to_login }, viewers: r.viewers, at: r.created_at, confirmed: r.source === 'eventsub' || r.source === 'demo' || r.source === 'seed' })),
    clips: (clips.results as R[]).map(rowToClip),
    duels: (duels.results as R[]).map((d) => duelResult(d, ch)),
    newChatterList: (newList.results as R[]).map((r) => ({ login: r.login, messages: r.messages })),
    topChatters: (top.results as R[]).map((r) => ({ login: r.login, messages: r.messages, isNew: !!r.is_new })),
    returningChatters: Math.max(0, s.chatters - s.new_chatters),
    botMessages: (bots.results as R[]).map((b) => ({ kind: b.kind, text: b.text, status: b.status, at: b.created_at })),
  };
}

const rowToClip = (r: Record<string, any>): ClipInfo => ({
  id: r.id, url: r.url ?? `https://clips.twitch.tv/${r.id}`, editUrl: r.edit_url, score: r.score ?? 0, rate: 0,
  quote: r.quote ?? '', demo: !!r.demo, createdAt: r.created_at,
});

export const fmtDuration = (ms: number) => {
  const m = Math.max(0, Math.round(ms / 60_000));
  return m >= 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m` : `${m}m`;
};

/** The !recap reply (≤500 chars) plus short lines for the overlay card. */
export async function recapMessage(env: Env, r: GrowthReport): Promise<{ text: string; lines: string[] }> {
  const lines: string[] = [`⏱ Live ${fmtDuration(r.durationMs)}`];
  if (r.raidsIn.length) {
    const viewers = r.raidsIn.reduce((s, x) => s + x.viewers, 0);
    const big = [...r.raidsIn].sort((a, b) => b.viewers - a.viewers)[0];
    lines.push(`🚀 ${r.raidsIn.length} raid${r.raidsIn.length > 1 ? 's' : ''} in (+${viewers} viewers, biggest: ${big.from.displayName})`);
  } else lines.push('🚀 No raids in yet');
  let top = r.clips[0];
  if (top && !isDemo(env)) {
    // Prefer the most-viewed clip when Twitch has view counts; fall back to the hype score.
    try {
      const views = await getClips(env, r.clips.map((c) => c.id));
      const best = views.sort((a, b) => b.view_count - a.view_count)[0];
      if (best) top = r.clips.find((c) => c.id === best.id) ?? top;
    } catch { /* keep hype-ranked */ }
  }
  lines.push(top ? `🎬 ${r.clips.length} clip${r.clips.length > 1 ? 's' : ''}, top: ${top.url}` : '🎬 No clips yet');
  if (r.duels.length) {
    const w = r.duels.filter((d) => d.result === 'win').length;
    const l = r.duels.filter((d) => d.result === 'loss').length;
    const t = r.duels.length - w - l;
    const last = r.duels[r.duels.length - 1];
    const verb = last.result === 'win' ? 'beat' : last.result === 'loss' ? 'lost to' : 'tied';
    lines.push(`⚔ Duels ${w}W-${l}L${t ? `-${t}T` : ''} (last: ${verb} ${last.opponent.displayName} ${last.myScore}-${last.theirScore})`);
  } else lines.push('⚔ No duels yet');
  lines.push(`👋 ${r.stream.newChatters} new chatter${r.stream.newChatters === 1 ? '' : 's'}, ${r.stream.chatters} total`);
  const text = `📊 Stream recap · ${lines.join(' · ')} 💜`;
  return { text: text.length > 500 ? `${text.slice(0, 497)}…` : text, lines };
}

// ---------------------------------------------------------------- Demo data ----------------------------------------------------------------

function mulberry32(seed: number) {
  return () => {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const hashStr = (s: string) => [...s].reduce((h, c) => Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0, 2166136261);

const HYPE_QUOTES = ['lets goooo', 'no wayyyy', 'clip it!!', 'kekw', 'pogchamp', 'the luck 😭', 'perfection'];

/**
 * Synthesizes one stream's per-minute chat/viewer timeline plus chatter rows (D1 `chatters` and
 * `stream_chatters`). Returning chatters come from a channel pool that grows each stream, so
 * "new chatters" and "returning" come out naturally. Demo only.
 */
export async function synthStreamActivity(env: Env, o: {
  channelId: string; streamId: string; startedAt: number; endedAt: number; baseViewers: number; seed: number; poolStart: number;
}): Promise<{ timeline: TimelinePoint[]; messages: number; peak: number; spikes: number[]; poolEnd: number }> {
  const rnd = mulberry32(o.seed);
  const minutes = Math.max(1, Math.floor((o.endedAt - o.startedAt) / 60_000));
  const spikes = Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => Math.floor(minutes * (0.2 + rnd() * 0.7)));
  const timeline: TimelinePoint[] = [];
  let messages = 0, peak = 0;
  for (let i = 0; i < minutes; i++) {
    const ramp = Math.min(1, i / 25) * (i > minutes - 10 ? 0.85 : 1);
    const viewers = Math.max(1, Math.round(o.baseViewers * (0.55 + 0.45 * ramp) * (0.9 + rnd() * 0.25)));
    const spike = spikes.some((m) => Math.abs(m - i) <= 1) ? 3.5 + rnd() * 2 : 1;
    const msgs = Math.round(viewers * (0.18 + rnd() * 0.22) * spike);
    timeline.push({ t: o.startedAt + i * 60_000, msgs, chatters: Math.max(1, Math.round(msgs * (0.45 + rnd() * 0.2))), viewers });
    messages += msgs;
    peak = Math.max(peak, viewers);
  }
  // Chatters: ~70% returning from the existing pool, the rest brand new.
  const total = Math.round(o.baseViewers * (0.9 + rnd() * 0.6));
  const fresh = Math.round(total * (0.18 + rnd() * 0.2));
  const picked = new Set<number>();
  while (picked.size < total - fresh && picked.size < o.poolStart) picked.add(Math.floor(rnd() ** 1.6 * o.poolStart));
  for (let i = 0; i < fresh; i++) picked.add(o.poolStart + i);
  const rows = [...picked].map((n) => {
    const who = fakeChatter(n + 7, 'x');
    return { id: `seed-${o.channelId}-${n}`, login: who.login, msgs: Math.max(1, Math.round(rnd() ** 2 * messages * 0.08)) };
  });
  const ins = env.DB.prepare('INSERT OR IGNORE INTO chatters (channel_id, user_id, login, first_seen_at, first_stream_id) VALUES (?, ?, ?, ?, ?)');
  const sc = env.DB.prepare('INSERT OR REPLACE INTO stream_chatters (stream_id, user_id, login, messages) VALUES (?, ?, ?, ?)');
  const stmts = rows.flatMap((r) => [ins.bind(o.channelId, r.id, r.login, o.startedAt, o.streamId), sc.bind(o.streamId, r.id, r.login, r.msgs)]);
  for (let i = 0; i < stmts.length; i += 100) await env.DB.batch(stmts.slice(i, i + 100));
  return { timeline, messages, peak, spikes: spikes.map((m) => o.startedAt + m * 60_000), poolEnd: o.poolStart + fresh };
}

export const DEMO_POOL_AFTER_SEED = 140;

/** Five past streams for a demo channel (idempotent: deterministic ids + INSERT OR IGNORE). */
export async function ensureDemoGrowthSeed(env: Env, ch: ChannelRef & { baseViewers: number; gameName: string }, rivals: ChannelRef[]): Promise<void> {
  if (await env.DB.prepare("SELECT 1 FROM streams WHERE channel_id = ? AND source = 'seed' LIMIT 1").bind(ch.id).first()) return;
  const now = Date.now();
  const DAY = 86_400_000;
  const titles = ['cozy morning farm ☕', 'community center grind', 'greenhouse day!', 'fishing for legends 🎣', 'year 2 spring planning'];
  const raidsIn = (await env.DB.prepare('SELECT from_id, from_login, from_name, viewers, created_at FROM raids WHERE to_id = ? ORDER BY created_at')
    .bind(ch.id).all<{ from_id: string; from_login: string; from_name: string; viewers: number; created_at: number }>()).results;
  let pool = 25;
  const days = [12, 9, 5, 3, 2];
  for (const [k, d] of days.entries()) {
    const id = `seed-${ch.login}-${k}`;
    const startedAt = now - d * DAY - 150 * 60_000;
    const endedAt = startedAt + (190 + k * 12) * 60_000;
    const act = await synthStreamActivity(env, { channelId: ch.id, streamId: id, startedAt, endedAt, baseViewers: Math.round(ch.baseViewers * (0.7 + k * 0.08)), seed: hashStr(id), poolStart: pool });
    pool = act.poolEnd;
    const rnd = mulberry32(hashStr(id + 'x'));
    const stmts = [env.DB.prepare(`INSERT OR IGNORE INTO streams (id, channel_id, channel_login, title, game_name, started_at, ended_at, peak_viewers, messages, timeline, source, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'seed', ?)`).bind(id, ch.id, ch.login, titles[k], ch.gameName, startedAt, endedAt, act.peak, act.messages, JSON.stringify(act.timeline), now)];
    act.spikes.forEach((at, j) => {
      const cid = `SeedClip${ch.login.slice(0, 8)}${k}${j}`;
      stmts.push(env.DB.prepare(`INSERT OR IGNORE INTO clips (id, channel_id, edit_url, reason, created_at, stream_id, channel_login, url, score, quote, demo)
        VALUES (?, ?, NULL, 'hype', ?, ?, ?, ?, ?, ?, 1)`).bind(cid, ch.id, at, id, ch.login, `https://clips.twitch.tv/${cid}`,
        Math.round((4 + rnd() * 5) * 10) / 10, HYPE_QUOTES[Math.floor(rnd() * HYPE_QUOTES.length)]));
    });
    if (k % 2 === 1 && rivals.length) {
      const rival = rivals[(k + ch.login.length) % rivals.length];
      const tug = k === 1;
      const a = Math.round(40 + rnd() * 60), b = Math.round(30 + rnd() * 60);
      stmts.push(env.DB.prepare(`INSERT OR IGNORE INTO duels (id, challenger_id, challenger_login, challenger_name, opponent_id, opponent_login, opponent_name, mode, question, options, duration_s, status, winner, score_a, score_b, voters_a, voters_b, created_at, started_at, ended_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 90, 'finished', ?, ?, ?, ?, ?, ?, ?, ?)`).bind(`seed${k}${ch.id}`, ch.id, ch.login, ch.displayName, rival.id, rival.login, rival.displayName,
        tug ? 'tug' : 'poll', tug ? 'Tug of War' : 'Best fish in the valley?', tug ? '[]' : '["Legend","Glacierfish","Crimsonfish"]',
        a === b ? 'tie' : a > b ? 'a' : 'b', a, b, Math.round(a * 0.6), Math.round(b * 0.6), startedAt + 60 * 60_000, startedAt + 61 * 60_000, startedAt + 62 * 60_000));
    }
    for (const r of raidsIn.filter((x) => x.created_at >= startedAt && x.created_at <= endedAt)) {
      const n = raidsIn.filter((x) => x.from_id === r.from_id && x.created_at <= r.created_at).length;
      stmts.push(env.DB.prepare(`INSERT INTO bot_messages (channel_id, stream_id, kind, text, status, created_at) VALUES (?, ?, 'welcome', ?, 'demo', ?)`)
        .bind(ch.id, id, welcomeText(r.from_name ?? r.from_login, r.from_login, r.viewers, n, ch.gameName), r.created_at));
    }
    await env.DB.batch(stmts);
  }
}
