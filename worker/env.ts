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
  /** Public HTTPS base URL Twitch posts EventSub webhooks to (e.g. a local tunnel). Defaults to APP_URL. */
  EVENTSUB_CALLBACK?: string;
  /** "true" enables /api/dev/* helpers for local live testing. Never set in production. */
  DEV_TOOLS?: string;
  TRACKED_GAME_IDS?: string;
  MAX_STREAM_PAGES?: string;

  // Secrets (wrangler secret put / .dev.vars). Never committed.
  TWITCH_CLIENT_ID?: string;
  TWITCH_CLIENT_SECRET?: string;
  EVENTSUB_SECRET?: string;
  TOKEN_ENC_KEY?: string;
  BOT_USER_ID?: string;

  // AI co-host (Ollama Cloud). Without OLLAMA_API_KEY (or in DEMO_MODE) a deterministic template provider is used.
  OLLAMA_API_KEY?: string;
  /** Default https://ollama.com (Ollama Cloud). */
  OLLAMA_HOST?: string;
  /** Cloud model name from https://ollama.com/api/tags. Default gemma4:31b. */
  OLLAMA_MODEL?: string;
  /** "true" lets DEMO_MODE use Ollama too when a key is set (e.g. for recording the demo video). */
  AI_IN_DEMO?: string;
  /** Default daily cap on AI chat messages per channel (streamers can lower it on the dashboard). */
  AI_DAILY_CAP?: string;
  /** Assistant requests per streamer per UTC day. */
  AI_ASSISTANT_DAILY?: string;
}

export const isDemo = (env: Env): boolean => env.DEMO_MODE === 'true';

export function appUrl(env: Env, req?: Request): string {
  if (env.APP_URL) return env.APP_URL.replace(/\/$/, '');
  return req ? new URL(req.url).origin : 'http://localhost:8787';
}

/** Webhook URL registered with Twitch EventSub. OAuth keeps using APP_URL (e.g. localhost). */
export function eventsubCallbackUrl(env: Env): string {
  const base = (env.EVENTSUB_CALLBACK || appUrl(env)).replace(/\/$/, '');
  return base.endsWith('/webhooks/eventsub') ? base : `${base}/webhooks/eventsub`;
}

/** Durable Object stubs. OverlayDO is keyed by lowercase channel login, DuelDO by duel id. */
export const overlayStub = (env: Env, login: string) =>
  env.OVERLAY.get(env.OVERLAY.idFromName(login.toLowerCase()));
export const duelStub = (env: Env, duelId: string) => env.DUEL.get(env.DUEL.idFromName(duelId));

export type AppEnv = { Bindings: Env; Variables: { viewer: Viewer | null } };
