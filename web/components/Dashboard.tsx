import { createEffect, createResource, createSignal, For, Show } from 'solid-js';
import ArrowRight from 'lucide-solid/icons/arrow-right';
import RefreshCw from 'lucide-solid/icons/refresh-cw';
import Sparkles from 'lucide-solid/icons/sparkles';
import Swords from 'lucide-solid/icons/swords';
import X from 'lucide-solid/icons/x';
import type { AssistantAction, Match, MatchmakingResponse, Viewer } from '../../shared/types';
import { api, fmtNum } from '../lib/api';
import AiCohostPanel from './AiCohost';
import { AssistantDrawer } from './Assistant';
import './assistant.css';
import Avatar from './Avatar';
import ObsLink from './ObsLink';
import RaidMap from './RaidMap';
import { toast, Toasts } from './Toasts';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card';
import { Checkbox } from './ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog';
import { Input, Label } from './ui/input';
import { Select } from './ui/select';
import { Skeleton } from './ui/skeleton';
import { Slider } from './ui/slider';
import { Tabs, TabsList, TabsTrigger } from './ui/tabs';
import { ToggleGroup, ToggleGroupItem } from './ui/toggle-group';
import { Tooltip } from './ui/tooltip';
import './dashboard.css';
type Me = { viewer: Viewer | null; demo: boolean; demoStreamers?: string[] };
type DuelRowChannel = { id: string; login: string; displayName: string; side: string; invite: string };
type DuelRow = { id: string; challenger_id: string; challenger_name: string; opponent_id: string; opponent_name: string; status: string; mode: string; format: '1v1' | 'ffa' | 'teams';
  created_at: number; winner: string | null; score_a: number; score_b: number; channels: DuelRowChannel[]; my_invite: string | null };
const FORMAT_CHIP = { '1v1': '1v1', ffa: 'Free-for-all', teams: 'Teams' } as const;


export default function Dashboard() {
  const [me] = createResource(() => api<Me>('/api/me'));
  const [mm, { refetch }] = createResource(() => me()?.viewer, () => api<MatchmakingResponse>('/api/matchmaking'));
  const [duels, duelsCtl] = createResource(() => me()?.viewer, () => api<{ duels: DuelRow[] }>('/api/duels'));
  const [raidTarget, setRaidTarget] = createSignal<Match | null>(null);
  const [duelTarget, setDuelTarget] = createSignal<{ m: Match | null; initial?: DuelPick } | null>(null);
  const [mapKey, setMapKey] = createSignal(0);
  const [asstOpen, setAsstOpen] = createSignal(false);
  const [pitchOn, setPitchOn] = createSignal(0);
  type Pitches = { enabled: boolean; pitches: Record<string, { text: string; ai: boolean }> };
  const [pitches] = createResource(() => (mm() ? `${mm()!.matches.map((m) => m.stream.id).join(',')}|${pitchOn()}` : false),
    () => api<Pitches>('/api/ai/pitches').catch(() => ({ enabled: false, pitches: {} }) as Pitches));

  // Assistant buttons (drawer, or ?raid= / ?duel= from the /assistant page) open the normal confirm dialogs.
  const openRaid = (login: string) => {
    const m = mm()?.matches.find((x) => x.stream.login === login);
    if (m) setRaidTarget(m); else toast(`${login} isn't in your live partner list right now`, true);
  };
  const openDuel = (p: DuelPick) => {
    const m = mm()?.matches.find((x) => x.stream.login === p.login) ?? null;
    setDuelTarget(m ? { m } : { m: null, initial: p });
  };
  const onAction = (a: AssistantAction) => {
    if (a.type === 'raid') openRaid(a.login);
    else if (a.type === 'duel') openDuel({ id: a.id, login: a.login, displayName: a.displayName });
    else if (a.href.startsWith('/dashboard/#')) { setAsstOpen(false); document.querySelector(a.href.slice(11))?.scrollIntoView({ behavior: 'smooth' }); }
    else location.href = a.href;
  };
  let handledParams = false;
  createEffect(() => {
    if (handledParams || !mm()) return;
    handledParams = true;
    const q = new URLSearchParams(location.search);
    const raid = q.get('raid'); const duel = q.get('duel');
    if (q.get('assistant') === '1') setAsstOpen(true);
    if (raid) openRaid(raid.toLowerCase());
    else if (duel) openDuel({ login: duel.toLowerCase(), displayName: duel });
    if (raid || duel || q.has('assistant')) history.replaceState(null, '', location.pathname + location.hash);
  });

  const respond = async (id: string, action: 'accept' | 'decline') => {
    try { await api(`/api/duels/${id}/${action}`, { json: {} }); duelsCtl.refetch(); toast(action === 'accept' ? 'Duel accepted' : 'Duel declined'); }
    catch (e) { toast((e as Error).message, true); }
  };

  return (
    <>
      <Show when={me()?.demo}>
        <div class="demo-banner"><div class="wrap">
          <Badge variant="blue">DEMO MODE</Badge>
          <span>Fake streamers and simulated chat, no Twitch calls.</span>
          <span class="spacer" />
          <span class="muted">Viewing as</span>
          <Select class="w-56" triggerClass="h-8 rounded-full" aria-label="Demo streamer" value={me()?.viewer?.login}
            options={(me()?.demoStreamers ?? []).map((l) => ({ value: l, label: l }))}
            onChange={(v) => (location.href = `/auth/login?as=${v}`)} />
        </div></div>
      </Show>
      <main class="wrap dash">
        <Show when={me() && !me()!.viewer}>
          <Card class="empty"><h2>Sign in to find raid partners</h2><p class="muted">Connect your Twitch channel to see live streamers your size.</p><Button as="a" href="/auth/login">Sign in with Twitch</Button></Card>
        </Show>
        <Show when={me()?.viewer}>
          <section class="me-row">
            <Show when={mm()} fallback={<Skeleton class="h-[108px]" />}>
              {(d) => (
                <Card class="me-card">
                  <Avatar name={d().me.displayName} src={d().me.avatarUrl} size={64} />
                  <div class="me-info">
                    <div class="eyebrow">Your channel</div>
                    <h1>{d().me.displayName}</h1>
                    <div class="me-meta">
                      {d().live ? <Badge variant="live">LIVE · {fmtNum(d().baseViewers)} viewers</Badge> : <Badge variant="muted">Offline · usually ~{d().baseViewers}</Badge>}
                      <Badge variant="outline">{d().gameName || 'No category'}</Badge>
                    </div>
                  </div>
                  <div class="range">
                    <div class="range-l">Match range</div>
                    <div class="range-num">{d().range[0]}–{d().range[1]}</div>
                    <div class="muted text-xs">viewers · 0.5×–2×</div>
                  </div>
                  <div class="range">
                    <div class="range-l">Partners live</div>
                    <div class="range-num text-red">{d().matches.length}</div>
                    <Button size="sm" variant="ghost" onClick={() => { refetch(); setMapKey((k) => k + 1); }}><RefreshCw /> Refresh</Button>
                  </div>
                </Card>
              )}
            </Show>
          </section>

          <Show when={(duels()?.duels ?? []).some((d) => ['pending', 'accepted', 'countdown', 'live'].includes(d.status))}>
            <Card class="duels-panel">
              <CardHeader class="flex-row items-center justify-between border-b border-border pb-4"><CardTitle>Duels</CardTitle><Badge variant="red">active</Badge></CardHeader>
              <CardContent class="duel-list pt-4">
                <For each={duels()!.duels.filter((d) => ['pending', 'accepted', 'countdown', 'live'].includes(d.status))}>
                  {(d) => {
                    const incoming = d.my_invite === 'pending';
                    const live = (c: DuelRowChannel) => c.invite !== 'declined' && c.invite !== 'dropped';
                    const chans = () => (d.channels?.length ? d.channels : [
                      { id: d.challenger_id, login: '', displayName: d.challenger_name, side: 'a', invite: 'host' },
                      { id: d.opponent_id, login: '', displayName: d.opponent_name, side: 'b', invite: d.status === 'pending' ? 'pending' : 'accepted' }]).filter(live);
                    const names = (side?: string) => chans().filter((c) => !side || c.side === side);
                    return (
                      <div class="duel-item">
                        <Show when={d.format === 'teams'} fallback={
                          <span class="vs"><For each={names()}>{(c, i) => <>{i() ? ' vs ' : ''}<b class={c.side} classList={{ pend: c.invite === 'pending' }}>{c.displayName}</b></>}</For></span>}>
                          <span class="vs">
                            <For each={names('a')}>{(c, i) => <>{i() ? ' + ' : ''}<b class="a" classList={{ pend: c.invite === 'pending' }}>{c.displayName}</b></>}</For>
                            {' vs '}
                            <For each={names('b')}>{(c, i) => <>{i() ? ' + ' : ''}<b class="b" classList={{ pend: c.invite === 'pending' }}>{c.displayName}</b></>}</For>
                          </span>
                        </Show>
                        <Badge variant="muted">{FORMAT_CHIP[d.format ?? '1v1']} · {d.mode === 'tug' ? (d.format === 'ffa' ? 'Race' : 'Tug of War') : 'Poll'} · {d.status}</Badge>
                        <Show when={incoming}><Badge variant="red">invite for you</Badge></Show>
                        <span class="spacer" />
                        <Show when={incoming && ['pending', 'accepted'].includes(d.status)}>
                          <Button size="sm" onClick={() => respond(d.id, 'accept')}>Accept</Button>
                          <Button size="sm" variant="ghost" onClick={() => respond(d.id, 'decline')}>Decline</Button>
                        </Show>
                        <Button as="a" size="sm" variant="outline" href={`/duel/${d.id}`}>Open board <ArrowRight /></Button>
                      </div>
                    );
                  }}
                </For>
              </CardContent>
            </Card>
          </Show>

          <section class="matches-head">
            <div>
              <div class="eyebrow">Matchmaking</div>
              <h2>Live partners in <span class="text-blue">{mm()?.gameName ?? '…'}</span></h2>
            </div>
            <span class="spacer" />
            <span class="muted mono text-xs">{mm() ? (mm()!.cacheAge >= 0 ? `cache ${Math.round(mm()!.cacheAge / 1000)}s old` : 'cache warming') : ''}</span>
            <Button size="sm" variant="ghost" onClick={() => setAsstOpen(true)}><Sparkles /> Ask AI</Button>
            <Button size="sm" variant="secondary" onClick={() => setDuelTarget({ m: null })} disabled={!mm()}><Swords /> Group duel</Button>
          </section>
          <Show when={!mm.loading} fallback={<div class="match-grid"><For each={[1, 2, 3, 4, 5, 6]}>{() => <Skeleton class="h-[300px]" />}</For></div>}>
            <Show when={mm.error}><Card class="empty">Couldn't load matches: {String(mm.error?.message ?? mm.error)}</Card></Show>
            <Show when={mm() && mm()!.matches.length === 0}><Card class="empty"><h3>No live partners match yet</h3><p class="muted">We look for streamers in this category with a similar audience. Try again later, or browse the raid network for creators to connect with between streams.</p><Button variant="outline" onClick={() => document.querySelector('#network')?.scrollIntoView({ behavior: 'smooth' })}>Explore the raid network <ArrowRight /></Button></Card></Show>
            <div class="match-grid">
              <For each={mm()?.matches}>
                {(m, i) => <MatchCard m={m} rank={i() + 1} base={mm()!.baseViewers} onRaid={() => setRaidTarget(m)} onDuel={() => setDuelTarget({ m })}
                  pitch={pitches()?.enabled === false ? null : pitches.loading ? undefined : pitches()?.pitches[m.stream.id]?.text ?? null} />}
              </For>
            </div>
          </Show>

          <section id="obs"><ObsLink login={me()!.viewer!.login} mine title="Your OBS overlay link" note="Add once as a 1920×1080 browser source. Duel boards, raid welcomes, clips and !recap all show up here. Changing the size updates open overlays live." /></section>

          <AiCohostPanel onChange={() => setPitchOn((n) => n + 1)} />

          <Card id="network" class="network">
            <CardHeader class="flex-row items-end justify-between gap-4 border-b border-border">
              <div><div class="eyebrow">Raid network</div><CardTitle class="mt-1.5 text-xl">Who raids whom</CardTitle></div>
              <CardDescription class="max-w-[420px] text-right">Arrows point from raider to raided. Bigger nodes have more viewers. Drag nodes to rearrange.</CardDescription>
            </CardHeader>
            <Show keyed when={mapKey() + 1}><RaidMap /></Show>
          </Card>
        </Show>
      </main>
      <Show when={raidTarget()}>{(t) => <RaidModal m={t()} onClose={() => setRaidTarget(null)} onDone={() => { setRaidTarget(null); setMapKey((k) => k + 1); refetch(); }} />}</Show>
      <Show when={duelTarget()}>{(t) => <DuelModal m={t().m} initial={t().initial} matches={mm()?.matches ?? []} demo={!!me()?.demo} onClose={() => setDuelTarget(null)} />}</Show>
      <Show when={me()?.viewer}>
        {(v) => (
          <>
            <Show when={!asstOpen()}><button class="asst-fab" onClick={() => setAsstOpen(true)}><Sparkles class="size-4" /> Assistant</button></Show>
            <AssistantDrawer open={asstOpen()} login={v().login} name={v().displayName} onClose={() => setAsstOpen(false)} onAction={onAction} />
          </>
        )}
      </Show>
      <Toasts />
    </>
  );
}

type DuelPick = { id?: string; login: string; displayName: string };

/** pitch: string = show it, undefined = loading, null = off/none. */
function MatchCard(props: { m: Match; rank: number; base: number; onRaid: () => void; onDuel: () => void; pitch?: string | null }) {
  const s = () => props.m.stream;
  // Position on a log scale from 0.5x (0%) to 2x (100%).
  const pos = () => Math.max(0, Math.min(100, ((Math.log2(props.m.ratio) + 1) / 2) * 100));
  return (
    <Card class="match" style={{ 'animation-delay': `${props.rank * 30}ms` }}>
      <div class="match-top">
        <Avatar name={s().displayName} src={s().avatarUrl} size={48} />
        <div class="match-name">
          <a href={`https://twitch.tv/${s().login}`} target="_blank" rel="noreferrer"><h3>{s().displayName}</h3></a>
          <Badge variant="live">{fmtNum(s().viewerCount)} viewers</Badge>
        </div>
        <Tooltip content="Higher scores mean a closer audience size, shared tags or language, and useful raid history. It is a guide, not a guarantee of fit.">
          <div class="score">{props.m.score}</div>
        </Tooltip>
      </div>
      <p class="title">{s().title}</p>
      <Tooltip class="block" content={`${props.m.ratio.toFixed(2)}× your viewers`}>
        <div class="ratio w-full">
          <div class="ratio-track"><span class="ratio-mid" /><span class="ratio-dot" style={{ left: `${pos()}%` }} /></div>
          <div class="ratio-labels mono"><span>0.5×</span><span>you</span><span>2×</span></div>
        </div>
      </Tooltip>
      <Show when={props.pitch !== null}>
        <p class="pitch" classList={{ loading: props.pitch === undefined }}><Sparkles class="size-4 shrink-0 text-blue" /><span>{props.pitch ?? 'Writing a collab pitch…'}</span></p>
      </Show>
      <ul class="reasons"><For each={props.m.reasons}>{(r) => <li>{r}</li></For></ul>
      <div class="tags"><For each={s().tags.slice(0, 4)}>{(t) => <Badge variant="muted">{t}</Badge>}</For></div>
      <div class="actions">
        <Button onClick={props.onRaid}><ArrowRight /> Raid</Button>
        <Button variant="outline" onClick={props.onDuel}><Swords /> Duel</Button>
      </div>
    </Card>
  );
}

function RaidModal(props: { m: Match; onClose: () => void; onDone: () => void }) {
  const [busy, setBusy] = createSignal(false);
  const go = async () => {
    setBusy(true);
    try {
      const r = await api<{ note: string; demo: boolean }>('/api/raids', { json: { toId: props.m.stream.id } });
      toast(r.demo ? r.note : 'Raid countdown started. Twitch will confirm when the handoff completes.');
      props.onDone();
    } catch (e) { toast((e as Error).message, true); setBusy(false); }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && props.onClose()}>
      <DialogContent>
        <DialogHeader>
          <div class="eyebrow">Raid</div>
          <DialogTitle>Raid {props.m.stream.displayName}?</DialogTitle>
          <DialogDescription>Your viewers go to <b class="text-foreground">{props.m.stream.displayName}</b> ({props.m.stream.viewerCount} viewers, {props.m.stream.gameName}). Twitch starts a 90-second raid countdown on your stream.</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={props.onClose}>Cancel</Button>
          <Button disabled={busy()} onClick={go}>{busy() ? 'Starting…' : 'Start raid'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

type Pick = { id?: string; login: string; displayName: string; team: 'a' | 'b' };
type Format = '1v1' | 'ffa' | 'teams';
const MAX_TEAM = 4;

/** Create a duel: 1v1, a 3-4 channel free-for-all, or Team A vs Team B (up to 4 each). */
function DuelModal(props: { m: Match | null; initial?: DuelPick; matches: Match[]; demo: boolean; onClose: () => void }) {
  const first: DuelPick | undefined = props.m?.stream ?? props.initial;
  const [format, setFormat] = createSignal<Format>('1v1');
  const [mode, setMode] = createSignal<'tug' | 'poll'>('tug');
  const [question, setQuestion] = createSignal('Best cozy game of all time?');
  const [opts, setOpts] = createSignal('Stardew Valley, Animal Crossing, Spiritfarer, Unpacking');
  const [dur, setDur] = createSignal(60);
  const [target, setTarget] = createSignal(120);
  const [teamA, setTeamA] = createSignal('Team A');
  const [teamB, setTeamB] = createSignal('Team B');
  const [picks, setPicks] = createSignal<Pick[]>(first ? [{ id: first.id, login: first.login, displayName: first.displayName, team: 'b' }] : []);
  const [loginIn, setLoginIn] = createSignal('');
  const [autoAccept, setAutoAccept] = createSignal(true);
  const [busy, setBusy] = createSignal(false);
  const [suggesting, setSuggesting] = createSignal(false);
  const suggest = async () => {
    setSuggesting(true);
    try {
      const r = await api<{ question: string; options: string[] }>('/api/ai/poll-question', { json: { seed: String(Date.now()) } });
      setQuestion(r.question); setOpts(r.options.join(', '));
    } catch (e) { toast((e as Error).message, true); } finally { setSuggesting(false); }
  };

  const limit = () => (format() === '1v1' ? 1 : format() === 'ffa' ? 3 : MAX_TEAM * 2 - 1);
  const count = (t: 'a' | 'b') => picks().filter((p) => p.team === t).length + (t === 'a' ? 1 : 0);
  const problem = () => {
    const n = picks().length;
    if (format() === '1v1') return n === 1 ? '' : n ? 'A 1v1 has exactly one opponent. Pick Free-for-all or Teams for more.' : 'Pick an opponent.';
    if (format() === 'ffa') return n >= 2 && n <= 3 ? '' : 'A free-for-all needs 2–3 other channels (3–4 lanes with you).';
    if (count('b') < 1) return 'Team B needs at least one channel.';
    if (count('a') > MAX_TEAM || count('b') > MAX_TEAM) return `Teams are at most ${MAX_TEAM} channels each.`;
    return '';
  };
  const add = (p: Omit<Pick, 'team'>) => {
    if (picks().some((x) => x.login === p.login)) return;
    if (picks().length >= limit()) { toast(`That format allows ${limit()} invite${limit() > 1 ? 's' : ''}`, true); return; }
    // Teams: fill Team B first, then balance.
    const team: 'a' | 'b' = format() === 'teams' && count('b') > count('a') ? 'a' : 'b';
    setPicks([...picks(), { ...p, team }]);
  };
  const setTeam = (login: string, team: 'a' | 'b') => setPicks(picks().map((p) => (p.login === login ? { ...p, team } : p)));
  const pickFormat = (f: Format) => {
    setFormat(f);
    if (f === '1v1') setPicks(picks().slice(0, 1).map((p) => ({ ...p, team: 'b' })));
    if (f === 'ffa') setPicks(picks().slice(0, 3));
    if (f === 'teams') setPicks(picks().map((p, i) => ({ ...p, team: i % 2 === 0 ? 'b' : 'a' })));
  };
  const suggestions = () => props.matches.filter((m) => !picks().some((p) => p.login === m.stream.login)).slice(0, 12);

  const go = async () => {
    if (problem()) { toast(problem(), true); return; }
    setBusy(true);
    try {
      const r = await api<{ duel: { id: string } }>('/api/duels', {
        json: {
          format: format(), mode: mode(), durationS: dur(),
          invites: picks().map((p) => ({ ...(p.id ? { id: p.id } : { login: p.login }), ...(format() === 'teams' ? { team: p.team } : {}) })),
          ...(format() === 'ffa' && mode() === 'tug' ? { raceTarget: target() } : {}),
          ...(format() === 'teams' ? { teamNames: [teamA(), teamB()] } : {}),
          ...(mode() === 'poll' ? { question: question(), options: opts().split(',').map((s) => s.trim()).filter(Boolean) } : {}),
          ...(props.demo && format() !== '1v1' && autoAccept() ? { autoAccept: true } : {}),
        },
      });
      location.href = `/duel/${r.duel.id}`;
    } catch (e) { toast((e as Error).message, true); setBusy(false); }
  };
  const blurb = () => {
    if (mode() === 'poll') return format() === 'teams'
      ? 'Every chat votes !1–!4 on the same question. Voters add up per team; the team with more voters wins.'
      : `All ${format() === '1v1' ? 'both' : ''} chats vote !1–!4 on the same question. The chat with the most voters wins.`.replace('All both', 'Both');
    if (format() === 'ffa') return 'Chat Race: each chat spams !pull to push its own lane. First to the finish line, or furthest when time runs out, wins.';
    if (format() === 'teams') return 'Team Tug of War: !pull in any chat on your team drags the rope toward your team. One pull per chatter every 1.5s.';
    return 'Each chat spams !pull to drag the rope to their side. One pull per chatter every 1.5s.';
  };

  return (
    <Dialog open onOpenChange={(o) => !o && props.onClose()}>
      <DialogContent class="duel-modal max-w-[600px] gap-0 p-0">
        <DialogHeader class="border-b border-border px-6 py-5">
          <div class="eyebrow">Duel</div>
          <DialogTitle>{format() === '1v1' && first ? `Challenge ${first.displayName}` : 'New duel'}</DialogTitle>
        </DialogHeader>
        <div class="duel-body">
          <div class="flex flex-wrap gap-2">
            <Tabs value={format()} onChange={(v) => pickFormat(v as Format)}>
              <TabsList><TabsTrigger value="1v1">1v1</TabsTrigger><TabsTrigger value="ffa">Free-for-all</TabsTrigger><TabsTrigger value="teams">Teams</TabsTrigger></TabsList>
            </Tabs>
            <Tabs value={mode()} onChange={(v) => setMode(v as 'tug' | 'poll')}>
              <TabsList><TabsTrigger value="tug">{format() === 'ffa' ? 'Chat Race' : 'Tug of War'}</TabsTrigger><TabsTrigger value="poll">Chat Poll</TabsTrigger></TabsList>
            </Tabs>
          </div>
          <p class="muted m-0 text-sm">{blurb()}</p>

          <div class="picks">
            <div class="eyebrow blue">Channels · {picks().length + 1}{format() === 'teams' ? ` (A ${count('a')} · B ${count('b')})` : ''}</div>
            <div class="pick you"><b>You</b><Badge variant={format() === 'teams' ? 'red' : 'muted'}>{format() === 'teams' ? 'Team A · host' : 'host'}</Badge></div>
            <For each={picks()}>
              {(p) => (
                <div class="pick">
                  <b>{p.displayName}</b>
                  <Show when={format() === 'teams'}>
                    <ToggleGroup value={p.team} onChange={(v) => v && setTeam(p.login, v as 'a' | 'b')} aria-label={`Team for ${p.displayName}`}>
                      <ToggleGroupItem value="a" class="data-[pressed]:bg-red">A</ToggleGroupItem>
                      <ToggleGroupItem value="b" class="data-[pressed]:bg-blue">B</ToggleGroupItem>
                    </ToggleGroup>
                  </Show>
                  <Button size="icon" variant="ghost" class="size-7" aria-label={`Remove ${p.displayName}`} onClick={() => setPicks(picks().filter((x) => x.login !== p.login))}><X /></Button>
                </div>
              )}
            </For>
            <Show when={picks().length < limit()}>
              <div class="pick-add">
                <Select class="flex-[1_1_240px]" placeholder="+ Add a live partner…" resetOnPick aria-label="Add a live partner"
                  options={suggestions().map((m) => ({ value: m.stream.login, label: m.stream.displayName, hint: `${m.stream.viewerCount} viewers` }))}
                  onChange={(v) => { const m = props.matches.find((x) => x.stream.login === v); if (m) add({ id: m.stream.id, login: m.stream.login, displayName: m.stream.displayName }); }} />
                <Input class="flex-[1_1_140px] w-auto" placeholder="or Twitch login" value={loginIn()} onInput={(e) => setLoginIn(e.currentTarget.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && loginIn().trim()) { add({ login: loginIn().trim().toLowerCase(), displayName: loginIn().trim() }); setLoginIn(''); } }} />
                <Button variant="soft" disabled={!loginIn().trim()} onClick={() => { add({ login: loginIn().trim().toLowerCase(), displayName: loginIn().trim() }); setLoginIn(''); }}>Add</Button>
              </div>
            </Show>
            <Show when={problem()}><div class="text-xs font-semibold text-red">{problem()}</div></Show>
          </div>

          <Show when={format() === 'teams'}>
            <div class="row2">
              <Label>Team A name<Input value={teamA()} maxLength={24} onInput={(e) => setTeamA(e.currentTarget.value)} /></Label>
              <Label>Team B name<Input value={teamB()} maxLength={24} onInput={(e) => setTeamB(e.currentTarget.value)} /></Label>
            </div>
          </Show>
          <Show when={mode() === 'poll'}>
            <Label>
              <span class="q-label">Question<Button variant="link" size="sm" class="h-auto" disabled={suggesting()} onClick={suggest}><Sparkles /> {suggesting() ? 'Thinking…' : 'Suggest question'}</Button></span>
              <Input value={question()} onInput={(e) => setQuestion(e.currentTarget.value)} maxLength={120} />
            </Label>
            <Label>Options (comma-separated, 2–4)<Input value={opts()} onInput={(e) => setOpts(e.currentTarget.value)} /></Label>
          </Show>
          <Slider label="Duration" valueLabel={`${dur()}s`} minValue={20} maxValue={300} step={10} value={[dur()]} onChange={(v) => setDur(v[0])} />
          <Show when={format() === 'ffa' && mode() === 'tug'}>
            <Slider label="Finish line" valueLabel={`${target()} pulls`} minValue={20} maxValue={600} step={10} value={[target()]} onChange={(v) => setTarget(v[0])} />
          </Show>
          <Show when={props.demo && format() !== '1v1'}>
            <Checkbox checked={autoAccept()} onChange={setAutoAccept} label="Demo: invited streamers accept right away" />
          </Show>
        </div>
        <DialogFooter class="border-t border-border px-6 py-4">
          <Button variant="ghost" onClick={props.onClose}>Cancel</Button>
          <Button disabled={busy() || !!problem()} onClick={go}>{busy() ? 'Sending…' : picks().length > 1 ? `Send ${picks().length} invites` : 'Send challenge'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
