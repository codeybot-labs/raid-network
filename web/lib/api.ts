export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export async function api<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const res = await fetch(path, {
    ...init,
    method: init?.method ?? (init?.json !== undefined ? 'POST' : 'GET'),
    headers: { ...(init?.json !== undefined ? { 'content-type': 'application/json' } : {}), ...(init?.headers ?? {}) },
    body: init?.json !== undefined ? JSON.stringify(init.json) : init?.body,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, (data as { error?: string }).error ?? res.statusText);
  return data as T;
}

/** WebSocket with automatic reconnect + keepalive ping (answered by the DO without waking it). */
export function liveSocket(path: string, onMessage: (data: any) => void, onStatus?: (up: boolean) => void): () => void {
  let ws: WebSocket | null = null;
  let closed = false;
  let retry = 0;
  let ping: ReturnType<typeof setInterval> | undefined;
  const connect = () => {
    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${path}`;
    ws = new WebSocket(url);
    ws.onopen = () => {
      retry = 0;
      onStatus?.(true);
      ping = setInterval(() => ws?.readyState === 1 && ws.send('ping'), 25_000);
    };
    ws.onmessage = (e) => {
      if (e.data === 'pong') return;
      try { onMessage(JSON.parse(e.data)); } catch { /* ignore */ }
    };
    ws.onclose = () => {
      clearInterval(ping);
      onStatus?.(false);
      if (!closed) setTimeout(connect, Math.min(10_000, 500 * 2 ** retry++));
    };
  };
  connect();
  return () => { closed = true; clearInterval(ping); ws?.close(); };
}

export const fmtNum = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
