import { createMemo, createResource, createSignal, For, Show } from 'solid-js';
import type { GrowthReport, GrowthResponse, StreamSummary, TimelinePoint } from '../../shared/types';
import { api, fmtNum } from '../lib/api';
import Avatar from './Avatar';
import { toast, Toasts } from './Toasts';
import ExternalLink from 'lucide-solid/icons/external-link';
import Play from 'lucide-solid/icons/play';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { Skeleton } from './ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table';
import './growth.css';

const fmtDur = (ms: number) => {
  const m = Math.max(0, Math.round(ms / 60_000));
  return m >= 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m` : `${m}m`;
};
const fmtDay = (t: number) => new Date(t).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
const fmtTime = (t: number) => new Date(t).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

export default function Growth() {
  const [sel, setSel] = createSignal<string | undefined>(new URLSearchParams(location.search).get('stream') ?? undefined);
  const [data, { refetch }] = createResource(() => sel() ?? '', (id) => api<GrowthResponse>(`/api/growth${id ? `?stream=${encodeURIComponent(id)}` : ''}`));
  const [busy, setBusy] = createSignal(false);

  const demoAction = async (path: string, body: unknown, msg: string) => {
    setBusy(true);
    try { await api(path, { json: body }); toast(msg); setSel(undefined); await refetch(); }
    catch (e) { toast((e as Error).message, true); }
    finally { setBusy(false); }
  };

  return (
    <>
      <main class="wrap growth">
        <Show when={data.error}><Card class="empty"><h2>Sign in to see your growth</h2><p>{String(data.error?.message ?? '')}</p><Button as="a" href="/auth/login">Sign in with Twitch</Button></Card></Show>
        <Show when={data()} fallback={<Show when={!data.error}><Skeleton class="h-[420px]" /></Show>}>
          {(d) => (
            <>
              <header class="g-head">
                <div>
                  <div class="eyebrow">Post-stream growth · {d().channel.displayName}</div>
                  <Show when={d().report} fallback={<h1>No streams yet</h1>}>
                    {(r) => (
                      <>
                        <h1>{r().stream.title || 'Untitled stream'}</h1>
                        <div class="g-meta">
                          {r().live ? <Badge variant="live">LIVE NOW</Badge> : <Badge variant="muted">Ended {fmtTime(r().stream.endedAt!)}</Badge>}
                          <Badge variant="outline">{fmtDay(r().stream.startedAt)} · {fmtTime(r().stream.startedAt)}</Badge>
                          <Show when={r().stream.gameName}><Badge variant="outline">{r().stream.gameName}</Badge></Show>
                        </div>
                      </>
                    )}
                  </Show>
                </div>
                <Show when={d().demo}>
                  <div class="g-demo">
                    <Badge variant="blue">DEMO</Badge>
                    <Show when={d().report?.live} fallback={
                      <Button size="sm" disabled={busy()} onClick={() => demoAction('/api/demo/stream', { channel: d().channel.login, action: 'online' }, 'Stream started (stream.online)')}>Go live</Button>}>
                      <Button size="sm" variant="secondary" disabled={busy()} onClick={() => demoAction('/api/demo/hype', { channel: d().channel.login }, 'Hype burst sent')}>Hype burst</Button>
                      <Button size="sm" variant="outline" disabled={busy()} onClick={() => demoAction('/api/demo/chat', { channel: d().channel.login, messages: [{ user: 'curious_viewer', text: '!recap' }] }, '!recap sent')}>!recap</Button>
                      <Button size="sm" variant="destructive" disabled={busy()} onClick={() => demoAction('/api/demo/stream', { channel: d().channel.login, action: 'offline' }, 'Stream ended (stream.offline)')}>End stream</Button>
                    </Show>
                  </div>
                </Show>
              </header>

              <StreamStrip streams={d().streams} selected={d().report?.stream.id} onPick={(id) => setSel(id)} />

              <Show when={d().report}>{(r) => <Report r={r()} />}</Show>
            </>
          )}
        </Show>
      </main>
      <Toasts />
    </>
  );
}

/** Recent streams as a stacked bar chart (new vs returning chatters); click to open one. */
function StreamStrip(p: { streams: StreamSummary[]; selected?: string; onPick: (id: string) => void }) {
  const list = () => [...p.streams].reverse();
  const max = () => Math.max(1, ...p.streams.map((s) => s.chatters));
  return (
    <Card class="strip">
      <div class="strip-head">
        <h2>Community growth</h2>
        <div class="legend"><span class="sw new" /> new chatters <span class="sw ret" /> returning</div>
      </div>
      <div class="strip-bars">
        <For each={list()}>{(s) => {
          const ret = () => Math.max(0, s.chatters - s.newChatters);
          return (
            <button class={`strip-col ${p.selected === s.id ? 'on' : ''}`} onClick={() => p.onPick(s.id)} title={s.title ?? ''}>
              <div class="strip-num mono">+{s.newChatters}</div>
              <div class="strip-stack">
                <div class="seg-new" style={{ height: `${(s.newChatters / max()) * 100}%` }} />
                <div class="seg-ret" style={{ height: `${(ret() / max()) * 100}%` }} />
              </div>
              <div class="strip-day">{s.endedAt ? fmtDay(s.startedAt) : 'Live now'}</div>
              <div class="strip-sub dim">{s.chatters} chatters · {s.raidsIn} raids</div>
            </button>
          );
        }}</For>
      </div>
    </Card>
  );
}

function Report(p: { r: GrowthReport }) {
  const r = () => p.r;
  const raidViewers = () => r().raidsIn.reduce((s, x) => s + x.viewers, 0);
  const wins = () => r().duels.filter((d) => d.result === 'win').length;
  const losses = () => r().duels.filter((d) => d.result === 'loss').length;
  return (
    <>
      <section class="tiles">
        <Tile label="Stream length" value={fmtDur(r().durationMs)} />
        <Tile label="Peak viewers" value={fmtNum(r().stream.peakViewers)} />
        <Tile label="Chat messages" value={fmtNum(r().stream.messages)} />
        <Tile label="New chatters" value={`+${r().stream.newChatters}`} accent="new" sub={`${r().returningChatters} returning`} />
        <Tile label="Raids in" value={String(r().raidsIn.length)} sub={`+${raidViewers()} viewers`} accent="a" />
        <Tile label="Raids out" value={String(r().raidsOut.length)} />
        <Tile label="Auto-clips" value={String(r().clips.length)} accent="b" />
        <Tile label="Duels" value={r().duels.length ? `${wins()}W-${losses()}L` : '—'} />
      </section>

      <Card>
        <CardHeader class="flex-row items-center justify-between gap-4 border-b border-border"><CardTitle>Chat activity</CardTitle>
          <div class="legend"><span class="sw ret" /> messages/min <span class="sw new line" /> viewers <span class="dot a" /> raid <span class="dot b" /> clip <span class="dot w" /> duel</div>
        </CardHeader>
        <CardContent class="pt-5"><Timeline r={r()} /></CardContent>
      </Card>

      <section class="g-grid">
        <Card>
          <CardHeader class="flex-row items-center justify-between border-b border-border"><CardTitle>Raids</CardTitle><Badge variant="muted">{r().raidsIn.length} in · {r().raidsOut.length} out</Badge></CardHeader>
          <CardContent class="list pt-4">
            <Show when={r().raidsIn.length + r().raidsOut.length} fallback={<div class="dim">No raids this stream.</div>}>
              <For each={r().raidsIn}>{(x) => (
                <div class="row"><Avatar name={x.from.displayName} size={34} /><div class="grow"><b>{x.from.displayName}</b> {x.confirmed ? 'raided you' : 'started a raid to you'}<div class="dim small">{fmtTime(x.at)} · {x.confirmed ? 'Confirmed by Twitch' : 'Awaiting Twitch confirmation'}</div></div><Badge variant={x.confirmed ? 'success' : 'muted'}>+{x.viewers}</Badge></div>
              )}</For>
              <For each={r().raidsOut}>{(x) => (
                <div class="row"><Avatar name={x.to.displayName} size={34} /><div class="grow">You started a raid to <b>{x.to.displayName}</b><div class="dim small">{fmtTime(x.at)} · {x.confirmed ? 'Confirmed by Twitch' : 'Countdown started · awaiting Twitch confirmation'}</div></div><Badge variant={x.confirmed ? 'success' : 'muted'}>→ {x.viewers}</Badge></div>
              )}</For>
            </Show>
          </CardContent>
        </Card>

        <Card>
          <CardHeader class="flex-row items-center justify-between border-b border-border"><CardTitle>Hype clips</CardTitle><Badge variant="muted">{r().clips.length}</Badge></CardHeader>
          <CardContent class="list pt-4">
            <Show when={r().clips.length} fallback={<div class="dim">No hype moments detected yet.</div>}>
              <For each={r().clips}>{(c, i) => (
                <div class="row">
                  <div class={`clip-thumb ${i() === 0 ? 'top' : ''}`}><Play class="size-4" /></div>
                  <div class="grow"><b>“{c.quote || 'chat went wild'}”</b><div class="dim small">{fmtTime(c.createdAt)} · {c.score.toFixed(1)}× chat velocity{c.demo ? ' · demo clip' : ''}</div></div>
                  <Button as="a" size="sm" variant="ghost" href={c.url} target="_blank" rel="noopener"><ExternalLink /> Open</Button>
                </div>
              )}</For>
            </Show>
          </CardContent>
        </Card>

        <Card>
          <CardHeader class="flex-row items-center justify-between border-b border-border"><CardTitle>Duel results</CardTitle><Badge variant="muted">{wins()}W · {losses()}L</Badge></CardHeader>
          <CardContent class="list pt-4">
            <Show when={r().duels.length} fallback={<div class="dim">No duels this stream. Challenge someone from the dashboard.</div>}>
              <For each={r().duels}>{(x) => (
                <div class="row">
                  <span class={`result ${x.result}`}>{x.result === 'win' ? 'W' : x.result === 'loss' ? 'L' : 'T'}</span>
                  <div class="grow">vs <b>{x.opponent.displayName}</b><div class="dim small">{x.mode === 'tug' ? 'Tug of War' : 'Chat Poll'} · {fmtTime(x.at)}</div></div>
                  <span class="mono score">{x.myScore}–{x.theirScore}</span>
                </div>
              )}</For>
            </Show>
          </CardContent>
        </Card>

        <Card>
          <CardHeader class="flex-row items-center justify-between border-b border-border"><CardTitle>New faces</CardTitle><Badge variant="success">+{r().stream.newChatters}</Badge></CardHeader>
          <CardContent class="pt-4">
            <p class="dim small mt-0 mb-2.5">First time chatting in your channel. Say hi next stream.</p>
            <div class="names">
              <For each={r().newChatterList} fallback={<span class="dim">No new chatters yet.</span>}>{(c) => <Badge variant="success">{c.login} <span class="dim">{c.messages}</span></Badge>}</For>
            </div>
            <h3 class="sub-h">Most active</h3>
            <div class="names">
              <For each={r().topChatters}>{(c) => <Badge variant={c.isNew ? 'success' : 'muted'}>{c.login} <span class="dim">{c.messages}</span></Badge>}</For>
            </div>
          </CardContent>
        </Card>

        <Card class="wide">
          <CardHeader class="flex-row items-center justify-between border-b border-border"><CardTitle>Raid Network in your chat</CardTitle><Badge variant="muted">welcomes &amp; !recap</Badge></CardHeader>
          <CardContent class="pt-2">
            <Show when={r().botMessages.length} fallback={<div class="dim pt-3">Nothing sent this stream.</div>}>
              <Table>
                <TableHeader><TableRow><TableHead class="w-28">Kind</TableHead><TableHead>Message</TableHead><TableHead class="w-40 text-right">Status · time</TableHead></TableRow></TableHeader>
                <TableBody>
                  <For each={r().botMessages}>{(m) => (
                    <TableRow class="bot">
                      <TableCell><Badge variant={m.kind === 'welcome' ? 'red' : m.kind === 'recap' ? 'blue' : 'muted'} class="kind">{m.kind}</Badge></TableCell>
                      <TableCell>{m.text}</TableCell>
                      <TableCell class="dim small mono text-right">{m.status} · {fmtTime(m.at)}</TableCell>
                    </TableRow>
                  )}</For>
                </TableBody>
              </Table>
            </Show>
          </CardContent>
        </Card>
      </section>
    </>
  );
}

function Tile(p: { label: string; value: string; sub?: string; accent?: 'new' | 'a' | 'b' }) {
  return (
    <Card class={`tile ${p.accent ?? ''}`}>
      <div class="dim mono tile-label">{p.label}</div>
      <div class="tile-value">{p.value}</div>
      <Show when={p.sub}><div class="dim small">{p.sub}</div></Show>
    </Card>
  );
}

/** Messages/min bars + viewers line, with raid, clip and duel markers. Plain SVG, no chart library. */
function Timeline(p: { r: GrowthReport }) {
  const W = 1000, H = 220, PAD = 28;
  const pts = createMemo<TimelinePoint[]>(() => {
    // Downsample to ≤ 180 bars so long streams stay readable.
    const tl = p.r.timeline;
    const step = Math.max(1, Math.ceil(tl.length / 180));
    const out: TimelinePoint[] = [];
    for (let i = 0; i < tl.length; i += step) {
      const chunk = tl.slice(i, i + step);
      out.push({ t: chunk[0].t, msgs: Math.round(chunk.reduce((s, x) => s + x.msgs, 0) / chunk.length), chatters: 0, viewers: Math.max(...chunk.map((x) => x.viewers)) });
    }
    return out;
  });
  const t0 = () => p.r.stream.startedAt;
  const t1 = () => t0() + Math.max(60_000, p.r.durationMs);
  const x = (t: number) => PAD + ((t - t0()) / (t1() - t0())) * (W - PAD * 2);
  const maxM = () => Math.max(5, ...pts().map((q) => q.msgs));
  const maxV = () => Math.max(5, ...pts().map((q) => q.viewers));
  const y = (v: number, max: number) => H - PAD - (v / max) * (H - PAD * 2);
  const bw = () => Math.max(1.5, ((W - PAD * 2) / Math.max(1, pts().length)) * 0.7);
  const line = () => pts().filter((q) => q.viewers > 0).map((q, i) => `${i ? 'L' : 'M'}${x(q.t).toFixed(1)},${y(q.viewers, maxV()).toFixed(1)}`).join(' ');
  const ticks = () => {
    const n = 6;
    return Array.from({ length: n + 1 }, (_, i) => t0() + ((t1() - t0()) * i) / n);
  };
  return (
    <Show when={pts().length} fallback={<div class="dim">No chat recorded yet.</div>}>
      <svg class="timeline" viewBox={`0 0 ${W} ${H + 18}`} preserveAspectRatio="none" role="img" aria-label="Chat messages per minute and viewers over the stream">
        <defs>
          <linearGradient id="bar" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#1c4fd8" /><stop offset="1" stop-color="#1c4fd8" stop-opacity=".3" /></linearGradient>
        </defs>
        <For each={[0.25, 0.5, 0.75, 1]}>{(f) => <line x1={PAD} x2={W - PAD} y1={y(maxM() * f, maxM())} y2={y(maxM() * f, maxM())} class="grid" />}</For>
        <For each={pts()}>{(q) => <rect x={x(q.t) - bw() / 2} y={y(q.msgs, maxM())} width={bw()} height={Math.max(0, H - PAD - y(q.msgs, maxM()))} rx="1" fill="url(#bar)" />}</For>
        <path d={line()} class="vline" />
        <For each={p.r.raidsIn}>{(m) => <g class="mark a"><line x1={x(m.at)} x2={x(m.at)} y1={PAD - 6} y2={H - PAD} /><circle cx={x(m.at)} cy={PAD - 8} r="6" /></g>}</For>
        <For each={p.r.clips}>{(m) => <g class="mark b"><line x1={x(m.createdAt)} x2={x(m.createdAt)} y1={PAD - 6} y2={H - PAD} /><circle cx={x(m.createdAt)} cy={PAD - 8} r="6" /></g>}</For>
        <For each={p.r.duels}>{(m) => <g class="mark w"><line x1={x(m.at)} x2={x(m.at)} y1={PAD - 6} y2={H - PAD} /><circle cx={x(m.at)} cy={PAD - 8} r="6" /></g>}</For>
        <For each={ticks()}>{(t) => <text x={x(t)} y={H + 10} class="tick">{fmtTime(t)}</text>}</For>
        <text x={PAD} y={y(maxM(), maxM()) - 4} class="axis">{maxM()} msg/min</text>
        <text x={W - PAD} y={y(maxV(), maxV()) - 4} class="axis new" text-anchor="end">{maxV()} viewers</text>
      </svg>
    </Show>
  );
}
