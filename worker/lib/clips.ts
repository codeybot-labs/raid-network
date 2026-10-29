import { isDemo, type Env } from '../env';
import type { ClipInfo } from '../../shared/types';
import { randomId } from './crypto';
import { createClip } from './helix';
import { userToken } from './tokens';

/**
 * Creates a clip of the broadcaster's stream (Helix POST /clips, broadcaster token with clips:edit)
 * and records it in D1 `clips`. DEMO_MODE fakes the Helix call.
 */
export async function makeClip(env: Env, o: { channelId: string; channelLogin: string; streamId: string | null; score: number; rate: number; quote: string; reason?: string }): Promise<ClipInfo> {
  const demo = isDemo(env);
  let id: string;
  let editUrl: string | null;
  if (demo) {
    id = `DemoClip${randomId(10)}`;
    editUrl = `https://clips.twitch.tv/${id}/edit`;
  } else {
    const r = await createClip(env, await userToken(env, o.channelId), o.channelId);
    id = r.data[0].id;
    editUrl = r.data[0].edit_url;
  }
  const url = `https://clips.twitch.tv/${id}`;
  const createdAt = Date.now();
  await env.DB.prepare(
    `INSERT INTO clips (id, channel_id, edit_url, reason, created_at, stream_id, channel_login, url, score, quote, demo)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(id, o.channelId, editUrl, o.reason ?? 'hype', createdAt, o.streamId, o.channelLogin, url, o.score, o.quote.slice(0, 80), demo ? 1 : 0).run();
  return { id, url, editUrl, score: o.score, rate: o.rate, quote: o.quote, demo, createdAt };
}
