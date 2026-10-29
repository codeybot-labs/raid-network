import type { Env } from '../env';
import type { Match, MatchmakingResponse, RaidGraph, StreamInfo, Viewer } from '../../shared/types';
import { getCachedStreams, myStreamContext } from './streams';
import { demoFindStream } from './demo';
import { isDemo } from '../env';

export function viewerRange(v: number): [number, number] {
  return [Math.floor(v * 0.5), Math.max(3, Math.ceil(v * 2))];
}

function uptime(startedAt: string): number {
  return (Date.now() - Date.parse(startedAt)) / 60_000;
}

const fmtUptime = (m: number) => (m < 60 ? `${Math.round(m)}m` : `${Math.floor(m / 60)}h ${Math.round(m % 60)}m`);

/** Pure ranking: exported for reuse/testing. */
export function rankMatches(
  me: { id: string; baseViewers: number; tags: string[]; language: string },
  streams: StreamInfo[],
  history: { raidedYou: Map<string, number>; youRaided: Map<string, { n: number; last: number }> },
): Match[] {
  const [lo, hi] = viewerRange(me.baseViewers);
  const myTags = new Set(me.tags.map((t) => t.toLowerCase()));
  const out: Match[] = [];
  for (const s of streams) {
    if (s.id === me.id || s.viewerCount < lo || s.viewerCount > hi) continue;
    const ratio = s.viewerCount / Math.max(1, me.baseViewers);
    const reasons: string[] = [];
    // 0..40: closeness in log space (1x = 40, 0.5x/2x = 0).
    let score = 40 * (1 - Math.min(1, Math.abs(Math.log2(ratio))));
    reasons.push(`${ratio.toFixed(1)}× your size`);
    const shared = s.tags.filter((t) => myTags.has(t.toLowerCase()));
    if (shared.length) {
      score += Math.min(20, shared.length * 8);
      reasons.push(`Shares ${shared.slice(0, 3).join(', ')}`);
    }
    if (s.language === me.language) score += 10;
    else reasons.push(`Streams in ${s.language.toUpperCase()}`);
    const inRaids = history.raidedYou.get(s.id) ?? 0;
    const out_ = history.youRaided.get(s.id);
    if (inRaids) {
      score += Math.min(25, 12 + inRaids * 6);
      reasons.push(inRaids > 1 ? `Raided you ${inRaids}× — return the favor` : 'Raided you before — return the favor');
    }
    if (out_ && Date.now() - out_.last < 7 * 86_400_000) {
      score -= 15;
      reasons.push('You raided them this week');
    } else if (!inRaids && !out_) {
      score += 5;
      reasons.push('New connection');
    }
    const up = uptime(s.startedAt);
    if (up >= 45 && up <= 6 * 60) score += 8;
    reasons.push(`Live ${fmtUptime(up)}`);
    out.push({ stream: s, score: Math.round(score), ratio, reasons, raidedYou: inRaids, youRaided: out_?.n ?? 0 });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 24);
}

export async function matchmaking(env: Env, viewer: Viewer): Promise<MatchmakingResponse> {
  const ctx = await myStreamContext(env, viewer.id, viewer.login);
  const range = viewerRange(ctx.baseViewers);
  const base = { me: viewer, myStream: ctx.stream, live: !!ctx.stream, baseViewers: ctx.baseViewers, gameName: ctx.gameName, range, demo: viewer.demo };
  if (!ctx.gameId) return { ...base, matches: [], cacheAge: 0 };
  const cache = await getCachedStreams(env, ctx.gameId, ctx.gameName);
  const since = Date.now() - 90 * 86_400_000;
  const [inRows, outRows] = await Promise.all([
    env.DB.prepare('SELECT from_id AS id, COUNT(*) AS n FROM raids WHERE to_id = ? AND created_at > ? GROUP BY from_id').bind(viewer.id, since).all<{ id: string; n: number }>(),
    env.DB.prepare('SELECT to_id AS id, COUNT(*) AS n, MAX(created_at) AS last FROM raids WHERE from_id = ? AND created_at > ? GROUP BY to_id').bind(viewer.id, since).all<{ id: string; n: number; last: number }>(),
  ]);
  const matches = rankMatches(
    { id: viewer.id, baseViewers: ctx.baseViewers, tags: ctx.tags, language: ctx.language },
    cache.streams,
    {
      raidedYou: new Map(inRows.results.map((r) => [r.id, r.n])),
      youRaided: new Map(outRows.results.map((r) => [r.id, { n: r.n, last: r.last }])),
    },
  );
  return { ...base, gameName: cache.gameName || ctx.gameName, matches, cacheAge: cache.fetchedAt ? Date.now() - cache.fetchedAt : -1 };
}

/** Raid network graph: the viewer's 2-hop neighbourhood (scope=me) or every recorded raid (scope=all). */
export async function raidGraph(env: Env, viewer: Viewer, scope: 'me' | 'all'): Promise<RaidGraph> {
  type Row = { from_id: string; from_login: string; from_name: string | null; to_id: string; to_login: string; to_name: string | null; n: number; viewers: number; last: number };
  const all = await env.DB.prepare(
    `SELECT from_id, from_login, from_name, to_id, to_login, to_name, COUNT(*) AS n, SUM(viewers) AS viewers, MAX(created_at) AS last
     FROM raids WHERE created_at > ? GROUP BY from_id, to_id ORDER BY last DESC LIMIT 2000`,
  ).bind(Date.now() - 180 * 86_400_000).all<Row>();
  let rows = all.results;
  if (scope === 'me') {
    const hop1 = new Set<string>([viewer.id]);
    for (const r of rows) if (r.from_id === viewer.id || r.to_id === viewer.id) { hop1.add(r.from_id); hop1.add(r.to_id); }
    rows = rows.filter((r) => hop1.has(r.from_id) || hop1.has(r.to_id));
  }
  const nodes = new Map<string, RaidGraph['nodes'][number]>();
  const addNode = (id: string, login: string, name: string | null) => {
    if (nodes.has(id)) return;
    let viewers = 0; let live = false;
    if (isDemo(env)) { const s = demoFindStream(login); if (s) { viewers = s.viewerCount; live = true; } }
    nodes.set(id, { id, login, displayName: name ?? login, viewers, live, isMe: id === viewer.id });
  };
  addNode(viewer.id, viewer.login, viewer.displayName);
  for (const r of rows) { addNode(r.from_id, r.from_login, r.from_name); addNode(r.to_id, r.to_login, r.to_name); }
  if (!isDemo(env)) {
    // Live mode: viewer counts from the tracked channels table (no extra Helix calls).
    const ids = [...nodes.keys()].slice(0, 90);
    if (ids.length) {
      const res = await env.DB.prepare(`SELECT id, viewer_count, is_live FROM channels WHERE id IN (${ids.map(() => '?').join(',')})`).bind(...ids)
        .all<{ id: string; viewer_count: number; is_live: number }>();
      for (const c of res.results) { const n = nodes.get(c.id); if (n) { n.viewers = c.viewer_count; n.live = !!c.is_live; } }
    }
  }
  return {
    nodes: [...nodes.values()],
    edges: rows.map((r) => ({ from: r.from_id, to: r.to_id, count: r.n, viewers: r.viewers, last: r.last })),
  };
}
