import type { Env } from '../env';
import { decryptString, encryptString } from './crypto';
import { refreshUserToken, type TokenResponse } from './helix';

function key(env: Env): string {
  if (!env.TOKEN_ENC_KEY) throw new Error('TOKEN_ENC_KEY secret is not configured');
  return env.TOKEN_ENC_KEY;
}

export async function saveTokens(env: Env, userId: string, t: TokenResponse): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO tokens (user_id, access_token_enc, refresh_token_enc, scopes, expires_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)
     ON CONFLICT(user_id) DO UPDATE SET access_token_enc=?2, refresh_token_enc=?3, scopes=?4, expires_at=?5, updated_at=?6`,
  ).bind(
    userId,
    await encryptString(key(env), t.access_token),
    await encryptString(key(env), t.refresh_token ?? ''),
    (t.scope ?? []).join(' '),
    now + t.expires_in * 1000,
    now,
  ).run();
}

/** Returns a valid user access token, refreshing it if it expires within 5 minutes. */
export async function userToken(env: Env, userId: string): Promise<string> {
  const row = await env.DB.prepare('SELECT * FROM tokens WHERE user_id = ?').bind(userId)
    .first<{ access_token_enc: string; refresh_token_enc: string; expires_at: number }>();
  if (!row) throw new Error('No Twitch token for this user; sign in again');
  if (row.expires_at > Date.now() + 5 * 60_000) return decryptString(key(env), row.access_token_enc);
  const refreshed = await refreshUserToken(env, await decryptString(key(env), row.refresh_token_enc));
  await saveTokens(env, userId, refreshed);
  return refreshed.access_token;
}
