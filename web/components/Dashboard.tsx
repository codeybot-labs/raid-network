import { createEffect, createResource, createSignal, For, Show } from 'solid-js';
import type { AssistantAction, Match, MatchmakingResponse, Viewer } from '../../shared/types';
import { api, fmtNum } from '../lib/api';
import AiCohostPanel from './AiCohost';
import { AssistantDrawer } from './Assistant';
import './assistant.css';
import Avatar from './Avatar';
import RaidMap from './RaidMap';
import { toast, Toasts } from './Toasts';
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
          <span>● DEMO MODE: fake streamers and simulated chat, no Twitch calls.</span>
          <span class="dim">Viewing as</span>
          <select value={me()?.viewer?.login} onChange={(e) => (location.href = `/auth/login?as=${e.currentTarget.value}`)}>
            <For each={me()?.demoStreamers}>{(l) => <option value={l}>{l}</option>}</For>
          </select>
        </div></div>
      </Show>
      <main class="wrap dash">
        <Show when={me() && !me()!.viewer}>
          <div class="panel empty"><h2>Sign in to find raid partners</h2><p>Connect your Twitch channel to see live streamers your size.</p><a class="btn primary" href="/auth/login">Sign in with Twitch</a></div>
        </Show>
        <Show when={me()?.viewer}>
          <section class="me-row">
            <Show when={mm()} fallback={<div class="skeleton" style={{ height: '108px' }} />}>
              {(d) => (
                <div class="me-card panel">
                  <Avatar name={d().me.displayName} src={d().me.avatarUrl} size={64} />
                  <div class="me-info">
                    <div class="eyebrow">Your channel</div>
                    <h1>{d().me.displayName}</h1>
                    <div class="me-meta">
                      {d().live ? <span class="chip live">LIVE · {fmtNum(d().baseViewers)} viewers</span> : <span class="chip">Offline · usually ~{d().baseViewers}</span>}
                      <span class="chip">{d().gameName || 'No category'}</span>
                    </div>
                  </div>
                  <div class="range">
                    <div class="dim mono">MATCH RANGE</div>
                    <div class="range-num">{d().range[0]}–{d().range[1]}</div>
                    <div class="dim">viewers · 0.5×–2×</div>
                  </div>
                  <div class="range">
                    <div class="dim mono">PARTNERS LIVE</div>
                    <div class="range-num lime">{d().matches.length}</div>
                    <button class="btn sm ghost" onClick={() => { refetch(); setMapKey((k) => k + 1); }}>↻ Refresh</button>
                  </div>
                </div>
              )}
            </Show>
          </section>

          <Show when={(duels()?.duels ?? []).some((d) => ['pending', 'accepted', 'countdown', 'live'].includes(d.status))}>
            <section class="panel duels-panel">
              <div class="panel-head"><h2>Duels</h2><span class="chip lime">active</span></div>
              <div class="panel-body duel-list">
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
                        <span class="chip">{FORMAT_CHIP[d.format ?? '1v1']} · {d.mode === 'tug' ? (d.format === 'ffa' ? 'Race' : 'Tug of War') : 'Poll'} · {d.status}</span>
                        <Show when={incoming}><span class="chip lime">invite for you</span></Show>
                        <span class="spacer" />
                        <Show when={incoming && ['pending', 'accepted'].includes(d.status)}>
                          <button class="btn sm primary" onClick={() => respond(d.id, 'accept')}>Accept</button>
                          <button class="btn sm ghost" onClick={() => respond(d.id, 'decline')}>Decline</button>
                        </Show>
                        <a class="btn sm" href={`/duel/${d.id}`}>Open board →</a>
                      </div>
                    );
                  }}
                </For>
              </div>
            </section>
          </Show>

          <section class="matches-head">
            <div>
              <div class="eyebrow">Matchmaking</div>
              <h2>Live partners in {mm()?.gameName ?? '…'}</h2>
            </div>
            <button class="btn sm ghost" onClick={() => setAsstOpen(true)}>✨ Ask AI</button>
            <button class="btn sm violet" onClick={() => setDuelTarget({ m: null })} disabled={!mm()}>⚔ Group duel</button>
            <span class="dim mono">{mm() ? (mm()!.cacheAge >= 0 ? `cache ${Math.round(mm()!.cacheAge / 1000)}s old` : 'cache warming') : ''}</span>
          </section>
          <Show when={!mm.loading} fallback={<div class="grid"><For each={[1, 2, 3, 4, 5, 6]}>{() => <div class="skeleton" style={{ height: '230px' }} />}</For></div>}>
            <Show when={mm.error}><div class="panel empty">Couldn't load matches: {String(mm.error?.message ?? mm.error)}</div></Show>
            <Show when={mm() && mm()!.matches.length === 0}><div class="panel empty">Nobody in your size range is live in this category right now. Check back in a few minutes.</div></Show>
            <div class="grid">
              <For each={mm()?.matches}>
                {(m, i) => <MatchCard m={m} rank={i() + 1} base={mm()!.baseViewers} onRaid={() => setRaidTarget(m)} onDuel={() => setDuelTarget({ m })}
                  pitch={pitches()?.enabled === false ? null : pitches.loading ? undefined : pitches()?.pitches[m.stream.id]?.text ?? null} />}
              </For>
            </div>
          </Show>

          <AiCohostPanel onChange={() => setPitchOn((n) => n + 1)} />

          <section id="network" class="panel network">
            <div class="panel-head">
              <div><div class="eyebrow">Raid network</div><h2>Who raids whom</h2></div>
              <span class="dim">Arrows point from raider to raided. Bigger nodes have more viewers. Drag nodes to rearrange.</span>
            </div>
            <Show keyed when={mapKey() + 1}><RaidMap /></Show>
          </section>
        </Show>
      </main>
      <Show when={raidTarget()}>{(t) => <RaidModal m={t()} onClose={() => setRaidTarget(null)} onDone={() => { setRaidTarget(null); setMapKey((k) => k + 1); refetch(); }} />}</Show>
      <Show when={duelTarget()}>{(t) => <DuelModal m={t().m} initial={t().initial} matches={mm()?.matches ?? []} demo={!!me()?.demo} onClose={() => setDuelTarget(null)} />}</Show>
      <Show when={me()?.viewer}>
        {(v) => (
          <>
            <Show when={!asstOpen()}><button class="asst-fab" onClick={() => setAsstOpen(true)}>✨ Assistant</button></Show>
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
    <article class="match panel" style={{ 'animation-delay': `${props.rank * 30}ms` }}>
      <div class="match-top">
        <Avatar name={s().displayName} src={s().avatarUrl} size={48} />
        <div class="match-name">
          <a href={`https://twitch.tv/${s().login}`} target="_blank" rel="noreferrer"><h3>{s().displayName}</h3></a>
          <span class="chip live">{fmtNum(s().viewerCount)}</span>
        </div>
        <div class="score" title="Match score">{props.m.score}</div>
      </div>
      <p class="title">{s().title}</p>
      <div class="ratio" title={`${props.m.ratio.toFixed(2)}× your viewers`}>
        <div class="ratio-track"><span class="ratio-mid" /><span class="ratio-dot" style={{ left: `${pos()}%` }} /></div>
        <div class="ratio-labels mono dim"><span>0.5×</span><span>you</span><span>2×</span></div>
      </div>
      <Show when={props.pitch !== null}>
        <p class="pitch" classList={{ loading: props.pitch === undefined }}><b>✨</b><span>{props.pitch ?? 'Writing a collab pitch…'}</span></p>
      </Show>
      <ul class="reasons"><For each={props.m.reasons}>{(r) => <li>{r}</li>}</For></ul>
      <div class="tags"><For each={s().tags.slice(0, 4)}>{(t) => <span class="chip">{t}</span>}</For></div>
      <div class="actions">
        <button class="btn violet" onClick={props.onRaid}>⟶ Raid</button>
        <button class="btn" onClick={props.onDuel}>⚔ Duel</button>
      </div>
    </article>
  );
}

function RaidModal(props: { m: Match; onClose: () => void; onDone: () => void }) {
  const [busy, setBusy] = createSignal(false);
  const go = async () => {
    setBusy(true);
    try {
      const r = await api<{ note: string }>('/api/raids', { json: { toId: props.m.stream.id } });
      toast(r.note);
      props.onDone();
    } catch (e) { toast((e as Error).message, true); setBusy(false); }
  };
  return (
    <div class="modal-back" onClick={(e) => e.target === e.currentTarget && props.onClose()}>
      <div class="modal">
        <div class="panel-head"><h2>Raid {props.m.stream.displayName}?</h2></div>
        <div class="panel-body">
          <p class="muted">Your viewers go to <b>{props.m.stream.displayName}</b> ({props.m.stream.viewerCount} viewers, {props.m.stream.gameName}). Twitch starts a 90-second raid countdown on your stream.</p>
        </div>
        <div class="modal-foot">
          <button class="btn ghost" onClick={props.onClose}>Cancel</button>
          <button class="btn primary" disabled={busy()} onClick={go}>{busy() ? 'Starting…' : 'Start raid'}</button>
        </div>
      </div>
    </div>
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
    <div class="modal-back" onClick={(e) => e.target === e.currentTarget && props.onClose()}>
      <div class="modal duel-modal">
        <div class="panel-head"><h2>{format() === '1v1' && first ? `Challenge ${first.displayName}` : 'New duel'}</h2></div>
        <div class="panel-body">
          <div class="seg">
            <button class={format() === '1v1' ? 'on' : ''} onClick={() => pickFormat('1v1')}>1v1</button>
            <button class={format() === 'ffa' ? 'on' : ''} onClick={() => pickFormat('ffa')}>Free-for-all</button>
            <button class={format() === 'teams' ? 'on' : ''} onClick={() => pickFormat('teams')}>Teams</button>
          </div>
          <div class="seg">
            <button class={mode() === 'tug' ? 'on' : ''} onClick={() => setMode('tug')}>{format() === 'ffa' ? 'Chat Race' : 'Tug of War'}</button>
            <button class={mode() === 'poll' ? 'on' : ''} onClick={() => setMode('poll')}>Chat Poll</button>
          </div>
          <p class="muted" style={{ margin: 0 }}>{blurb()}</p>

          <div class="picks">
            <div class="eyebrow">Channels · {picks().length + 1}{format() === 'teams' ? ` (A ${count('a')} · B ${count('b')})` : ''}</div>
            <div class="pick you"><b>You</b><span class="mono dim">{format() === 'teams' ? 'Team A · host' : 'host'}</span></div>
            <For each={picks()}>
              {(p) => (
                <div class="pick">
                  <b>{p.displayName}</b>
                  <Show when={format() === 'teams'}>
                    <span class="seg mini">
                      <button class={p.team === 'a' ? 'on' : ''} onClick={() => setTeam(p.login, 'a')}>A</button>
                      <button class={p.team === 'b' ? 'on' : ''} onClick={() => setTeam(p.login, 'b')}>B</button>
                    </span>
                  </Show>
                  <button class="btn sm ghost" onClick={() => setPicks(picks().filter((x) => x.login !== p.login))}>✕</button>
                </div>
              )}
            </For>
            <Show when={picks().length < limit()}>
              <div class="pick-add">
                <select onChange={(e) => {
                  const m = props.matches.find((x) => x.stream.login === e.currentTarget.value);
                  if (m) add({ id: m.stream.id, login: m.stream.login, displayName: m.stream.displayName });
                  e.currentTarget.value = '';
                }}>
                  <option value="">+ Add a live partner…</option>
                  <For each={suggestions()}>{(m) => <option value={m.stream.login}>{m.stream.displayName} · {m.stream.viewerCount} viewers</option>}</For>
                </select>
                <input placeholder="or Twitch login" value={loginIn()} onInput={(e) => setLoginIn(e.currentTarget.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && loginIn().trim()) { add({ login: loginIn().trim().toLowerCase(), displayName: loginIn().trim() }); setLoginIn(''); } }} />
                <button class="btn sm" disabled={!loginIn().trim()} onClick={() => { add({ login: loginIn().trim().toLowerCase(), displayName: loginIn().trim() }); setLoginIn(''); }}>Add</button>
              </div>
            </Show>
            <Show when={problem()}><div class="dim" style={{ 'font-size': '12px' }}>{problem()}</div></Show>
          </div>

          <Show when={format() === 'teams'}>
            <div class="row2">
              <label>Team A name<input value={teamA()} maxLength={24} onInput={(e) => setTeamA(e.currentTarget.value)} /></label>
              <label>Team B name<input value={teamB()} maxLength={24} onInput={(e) => setTeamB(e.currentTarget.value)} /></label>
            </div>
          </Show>
          <Show when={mode() === 'poll'}>
            <label>
              <span class="q-label">Question<button type="button" class="linkish" disabled={suggesting()} onClick={suggest}>{suggesting() ? 'Thinking…' : '✨ Suggest question'}</button></span>
              <input value={question()} onInput={(e) => setQuestion(e.currentTarget.value)} maxLength={120} />
            </label>
            <label>Options (comma-separated, 2–4)<input value={opts()} onInput={(e) => setOpts(e.currentTarget.value)} /></label>
          </Show>
          <label>Duration: {dur()}s<input type="range" min="20" max="300" step="10" value={dur()} onInput={(e) => setDur(+e.currentTarget.value)} /></label>
          <Show when={format() === 'ffa' && mode() === 'tug'}>
            <label>Finish line: {target()} pulls<input type="range" min="20" max="600" step="10" value={target()} onInput={(e) => setTarget(+e.currentTarget.value)} /></label>
          </Show>
          <Show when={props.demo && format() !== '1v1'}>
            <label class="check"><input type="checkbox" checked={autoAccept()} onChange={(e) => setAutoAccept(e.currentTarget.checked)} /> Demo: invited streamers accept right away</label>
          </Show>
        </div>
        <div class="modal-foot">
          <button class="btn ghost" onClick={props.onClose}>Cancel</button>
          <button class="btn primary" disabled={busy() || !!problem()} onClick={go}>{busy() ? 'Sending…' : picks().length > 1 ? `Send ${picks().length} invites` : 'Send challenge'}</button>
        </div>
      </div>
    </div>
  );
}
