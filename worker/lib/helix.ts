import type { Env } from '../env';
import type { StreamInfo } from '../../shared/types';

const HELIX = 'https://api.twitch.tv/helix';
const ID = 'https://id.twitch.tv/oauth2';

export const SCOPES = [
  'user:read:chat',
  'user:write:chat',
  'user:bot', // required by Twitch for channel.chat.message webhooks and app-token chat sends
  'channel:bot',
  'channel:manage:raids',
  'clips:edit',
  'moderator:read:followers',
];

export class HelixError extends Error {
  constructor(public status: number, public body: string, public path: string) {
    super(`Helix ${path} -> ${status}: ${body.slice(0, 300)}`);
  }
}

function creds(env: Env) {
  if (!env.TWITCH_CLIENT_ID || !env.TWITCH_CLIENT_SECRET) {
    throw new Error('TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET are not configured (or enable DEMO_MODE)');
  }
  return { id: env.TWITCH_CLIENT_ID, secret: env.TWITCH_CLIENT_SECRET };
}

export interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope?: string[];
  token_type: string;
}

async function tokenRequest(params: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(`${ID}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  if (!res.ok) throw new HelixError(res.status, await res.text(), '/oauth2/token');
  return res.json();
}

export function authorizeUrl(env: Env, redirectUri: string, state: string): string {
  const u = new URL(`${ID}/authorize`);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', creds(env).id);
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('scope', SCOPES.join(' '));
  u.searchParams.set('state', state);
  return u.toString();
}

export const exchangeCode = (env: Env, code: string, redirectUri: string) =>
  tokenRequest({ client_id: creds(env).id, client_secret: creds(env).secret, code, grant_type: 'authorization_code', redirect_uri: redirectUri });

export const refreshUserToken = (env: Env, refreshToken: string) =>
  tokenRequest({ client_id: creds(env).id, client_secret: creds(env).secret, grant_type: 'refresh_token', refresh_token: refreshToken });

/** App access token (client credentials), cached in KV until shortly before expiry. */
export async function appToken(env: Env): Promise<string> {
  const cached = await env.KV.get('twitch:apptoken');
  if (cached) return cached;
  const t = await tokenRequest({ client_id: creds(env).id, client_secret: creds(env).secret, grant_type: 'client_credentials' });
  await env.KV.put('twitch:apptoken', t.access_token, { expirationTtl: Math.max(60, t.expires_in - 600) });
  return t.access_token;
}

async function helix<T>(env: Env, token: string, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${HELIX}${path}`, {
    method,
    headers: {
      'Client-Id': creds(env).id,
      Authorization: `Bearer ${token}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new HelixError(res.status, await res.text(), path);
  if (res.status === 204) return undefined as T;
  return res.json();
}

interface HelixStream {
  id: string; user_id: string; user_login: string; user_name: string; game_id: string; game_name: string;
  type: string; title: string; viewer_count: number; started_at: string; language: string;
  thumbnail_url: string; tags: string[] | null;
}
const toStream = (s: HelixStream): StreamInfo => ({
  id: s.user_id, login: s.user_login, displayName: s.user_name, streamId: s.id, gameId: s.game_id,
  gameName: s.game_name, title: s.title, viewerCount: s.viewer_count, language: s.language,
  tags: s.tags ?? [], startedAt: s.started_at,
});

/** GET /streams?game_id=…, paginated (Helix sorts by viewers desc, so small streamers are deep in the tail). */
export async function getStreamsByGame(env: Env, gameId: string, maxPages: number): Promise<StreamInfo[]> {
  const token = await appToken(env);
  const out: StreamInfo[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const qs = new URLSearchParams({ game_id: gameId, first: '100', type: 'live' });
    if (cursor) qs.set('after', cursor);
    const r = await helix<{ data: HelixStream[]; pagination: { cursor?: string } }>(env, token, 'GET', `/streams?${qs}`);
    out.push(...r.data.map(toStream));
    cursor = r.pagination?.cursor;
    if (!cursor || r.data.length < 100) break;
  }
  return out;
}

export async function getStreamByUser(env: Env, userId: string): Promise<StreamInfo | null> {
  const r = await helix<{ data: HelixStream[] }>(env, await appToken(env), 'GET', `/streams?user_id=${encodeURIComponent(userId)}`);
  return r.data[0] ? toStream(r.data[0]) : null;
}

export interface HelixUser { id: string; login: string; display_name: string; profile_image_url: string; }
export async function getUsers(env: Env, token: string, q: { ids?: string[]; logins?: string[] } = {}): Promise<HelixUser[]> {
  const qs = new URLSearchParams();
  q.ids?.forEach((id) => qs.append('id', id));
  q.logins?.forEach((l) => qs.append('login', l));
  const r = await helix<{ data: HelixUser[] }>(env, token, 'GET', `/users${qs.size ? `?${qs}` : ''}`);
  return r.data;
}

export async function getChannelInfo(env: Env, broadcasterId: string) {
  const r = await helix<{ data: { broadcaster_id: string; game_id: string; game_name: string; broadcaster_language: string; title: string; tags: string[] }[] }>(
    env, await appToken(env), 'GET', `/channels?broadcaster_id=${encodeURIComponent(broadcasterId)}`);
  return r.data[0] ?? null;
}

/** POST /raids — user token of the raiding broadcaster with channel:manage:raids. */
export const startRaid = (env: Env, userToken: string, fromId: string, toId: string) =>
  helix<{ data: { created_at: string; is_mature: boolean }[] }>(env, userToken, 'POST',
    `/raids?from_broadcaster_id=${encodeURIComponent(fromId)}&to_broadcaster_id=${encodeURIComponent(toId)}`);

/** POST /clips — user token with clips:edit. */
export const createClip = (env: Env, userToken: string, broadcasterId: string) =>
  helix<{ data: { id: string; edit_url: string }[] }>(env, userToken, 'POST', `/clips?broadcaster_id=${encodeURIComponent(broadcasterId)}`);

/** GET /clips?id=… (app token) — view counts for !recap's "top clip". Up to 100 ids. */
export async function getClips(env: Env, ids: string[]) {
  if (!ids.length) return [];
  const qs = new URLSearchParams();
  ids.slice(0, 100).forEach((id) => qs.append('id', id));
  const r = await helix<{ data: { id: string; url: string; view_count: number; title: string }[] }>(env, await appToken(env), 'GET', `/clips?${qs}`);
  return r.data;
}

/** POST /chat/messages — user token (user:write:chat) of the sender. */
export const sendChatMessage = (env: Env, userToken: string, broadcasterId: string, senderId: string, message: string) =>
  helix<{ data: { message_id: string; is_sent: boolean; drop_reason?: { code: string; message: string } | null }[] }>(env, userToken, 'POST', '/chat/messages', {
    broadcaster_id: broadcasterId, sender_id: senderId, message: message.slice(0, 500),
  });

/** POST /eventsub/subscriptions (webhook transport, app token). 409 = already subscribed. */
export async function subscribeEventSub(env: Env, callback: string, type: string, version: string, condition: Record<string, string>) {
  if (!env.EVENTSUB_SECRET) throw new Error('EVENTSUB_SECRET not configured');
  try {
    return await helix(env, await appToken(env), 'POST', '/eventsub/subscriptions', {
      type, version, condition, transport: { method: 'webhook', callback, secret: env.EVENTSUB_SECRET },
    });
  } catch (e) {
    if (e instanceof HelixError && e.status === 409) return null;
    throw e;
  }
}
