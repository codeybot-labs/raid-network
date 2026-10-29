import { isDemo, type Env } from '../env';
import type { StreamCache, StreamInfo } from '../../shared/types';
import { DEMO_GAMES, demoFindStream, demoStreams } from './demo';
import { getChannelInfo, getStreamByUser, getStreamsByGame } from './helix';

const CACHE_TTL_S = 60 * 30; // entries outlive the 10-min cron so a missed run never empties the dashboard
const cacheKey = (gameId: string) => `streams:${gameId}`;

/** Live streams for a game from the KV cache (written by the cron). On a cold miss, fetches once under a short lock. */
export async function getCachedStreams(env: Env, gameId: string, gameName = ''): Promise<StreamCache> {
  if (isDemo(env)) return demoStreams(gameId);
  const hit = await env.KV.get<StreamCache>(cacheKey(gameId), 'json');
  if (hit) return hit;
  const lock = await env.KV.get(`lock:${cacheKey(gameId)}`);
  if (lock) return { gameId, gameName, fetchedAt: 0, streams: [] };
  await env.KV.put(`lock:${cacheKey(gameId)}`, '1', { expirationTtl: 60 });
  return refreshGame(env, gameId, gameName);
}

async function refreshGame(env: Env, gameId: string, gameName: string): Promise<StreamCache> {
  const streams = await getStreamsByGame(env, gameId, Number(env.MAX_STREAM_PAGES ?? '10'));
  const cache: StreamCache = { gameId, gameName: streams[0]?.gameName ?? gameName, fetchedAt: Date.now(), streams };
  await env.KV.put(cacheKey(gameId), JSON.stringify(cache), { expirationTtl: CACHE_TTL_S });
  return cache;
}

/** Games to cache: TRACKED_GAME_IDS plus the current game of every signed-in (tracked) channel. */
export async function trackedGames(env: Env): Promise<string[]> {
  if (isDemo(env)) return DEMO_GAMES.map((g) => g.id);
  const fromVar = (env.TRACKED_GAME_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const rows = await env.DB.prepare(
    'SELECT DISTINCT game_id FROM channels WHERE tracked = 1 AND game_id IS NOT NULL AND updated_at > ?',
  ).bind(Date.now() - 14 * 86_400_000).all<{ game_id: string }>();
  return [...new Set([...fromVar, ...rows.results.map((r) => r.game_id)])].slice(0, 50);
}

/** Cron handler: refresh every tracked game's live-stream cache. */
export async function refreshAllStreams(env: Env): Promise<{ games: number; streams: number }> {
  const games = await trackedGames(env);
  if (isDemo(env)) return { games: games.length, streams: games.reduce((n, g) => n + demoStreams(g).streams.length, 0) };
  let total = 0;
  for (const g of games) {
    try {
      total += (await refreshGame(env, g, '')).streams.length;
    } catch (e) {
      console.error('stream refresh failed', g, e);
    }
  }
  return { games: games.length, streams: total };
}

/** The viewer's own stream (live) or their channel info (offline) for matchmaking. */
export async function myStreamContext(env: Env, userId: string, login: string): Promise<{
  stream: StreamInfo | null; gameId: string | null; gameName: string; baseViewers: number; tags: string[]; language: string;
}> {
  if (isDemo(env)) {
    const s = demoFindStream(login) ?? demoFindStream('pixelpaladin')!;
    return { stream: s, gameId: s.gameId, gameName: s.gameName, baseViewers: s.viewerCount, tags: s.tags, language: s.language };
  }
  const cacheK = `me:stream:${userId}`;
  let stream = await env.KV.get<StreamInfo | { offline: true }>(cacheK, 'json');
  if (!stream) {
    stream = (await getStreamByUser(env, userId)) ?? { offline: true };
    await env.KV.put(cacheK, JSON.stringify(stream), { expirationTtl: 120 });
  }
  const row = await env.DB.prepare('SELECT game_id, game_name, viewer_count, tags, language FROM channels WHERE id = ?').bind(userId)
    .first<{ game_id: string | null; game_name: string | null; viewer_count: number; tags: string | null; language: string | null }>();
  if ('offline' in stream) {
    let gameId = row?.game_id ?? null;
    let gameName = row?.game_name ?? '';
    let tags: string[] = row?.tags ? JSON.parse(row.tags) : [];
    if (!gameId) {
      const info = await getChannelInfo(env, userId);
      gameId = info?.game_id || null;
      gameName = info?.game_name ?? '';
      tags = info?.tags ?? [];
    }
    return { stream: null, gameId, gameName, baseViewers: row?.viewer_count || 5, tags, language: row?.language ?? 'en' };
  }
  // Keep channels row fresh so the cron caches this game.
  await env.DB.prepare(
    `UPDATE channels SET game_id=?, game_name=?, viewer_count=?, tags=?, language=?, is_live=1, title=?, started_at=?, updated_at=? WHERE id=?`,
  ).bind(stream.gameId, stream.gameName, stream.viewerCount, JSON.stringify(stream.tags), stream.language, stream.title, stream.startedAt, Date.now(), userId).run();
  return { stream, gameId: stream.gameId, gameName: stream.gameName, baseViewers: stream.viewerCount, tags: stream.tags, language: stream.language };
}
