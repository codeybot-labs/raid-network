import type { Context } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { isDemo, type AppEnv } from '../env';
import type { Viewer } from '../../shared/types';
import { randomId } from './crypto';
import { DEMO_ME, demoFindStream } from './demo';

const COOKIE = 'rn_sess';
const TTL_S = 7 * 86_400;

type C = Context<AppEnv>;

export async function createSession(c: C, viewer: Viewer): Promise<void> {
  const id = randomId(32);
  await c.env.KV.put(`sess:${id}`, JSON.stringify(viewer), { expirationTtl: TTL_S });
  setCookie(c, COOKIE, id, {
    httpOnly: true, sameSite: 'Lax', path: '/', maxAge: TTL_S,
    secure: new URL(c.req.url).protocol === 'https:',
  });
}

export async function destroySession(c: C): Promise<void> {
  const id = getCookie(c, COOKIE);
  if (id) await c.env.KV.delete(`sess:${id}`);
  deleteCookie(c, COOKIE, { path: '/' });
}

export function demoViewer(login = DEMO_ME): Viewer | null {
  const s = demoFindStream(login);
  return s ? { id: s.id, login: s.login, displayName: s.displayName, demo: true } : null;
}

/** Current user from the session cookie. In DEMO_MODE, falls back to the demo streamer. */
export async function getViewer(c: C): Promise<Viewer | null> {
  const id = getCookie(c, COOKIE);
  if (id) {
    const v = await c.env.KV.get<Viewer>(`sess:${id}`, 'json');
    if (v && v.demo === isDemo(c.env)) return v;
  }
  return isDemo(c.env) ? demoViewer() : null;
}
