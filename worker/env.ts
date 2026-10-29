import type { OverlayDO } from './durable/overlay';
import type { DuelDO } from './durable/duel';
import type { Viewer } from '../shared/types';

export interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  KV: KVNamespace;
  OVERLAY: DurableObjectNamespace<OverlayDO>;
  DUEL: DurableObjectNamespace<DuelDO>;

  DEMO_MODE?: string;
  APP_URL?: string;
  TRACKED_GAME_IDS?: string;
  MAX_STREAM_PAGES?: string;

  // Secrets (wrangler secret put / .dev.vars). Never committed.
  TWITCH_CLIENT_ID?: string;
  TWITCH_CLIENT_SECRET?: string;
  EVENTSUB_SECRET?: string;
  TOKEN_ENC_KEY?: string;
  BOT_USER_ID?: string;
}

export const isDemo = (env: Env): boolean => env.DEMO_MODE === 'true';

export function appUrl(env: Env, req?: Request): string {
  if (env.APP_URL) return env.APP_URL.replace(/\/$/, '');
  return req ? new URL(req.url).origin : 'http://localhost:8787';
}

/** Durable Object stubs. OverlayDO is keyed by lowercase channel login, DuelDO by duel id. */
export const overlayStub = (env: Env, login: string) =>
  env.OVERLAY.get(env.OVERLAY.idFromName(login.toLowerCase()));
export const duelStub = (env: Env, duelId: string) => env.DUEL.get(env.DUEL.idFromName(duelId));

export type AppEnv = { Bindings: Env; Variables: { viewer: Viewer | null } };
