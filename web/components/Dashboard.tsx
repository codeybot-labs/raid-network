import { createResource, createSignal, For, Show } from 'solid-js';
import type { Match, MatchmakingResponse, Viewer } from '../../shared/types';
import { api, fmtNum } from '../lib/api';
import Avatar from './Avatar';
import RaidMap from './RaidMap';
import { toast, Toasts } from './Toasts';
import './dashboard.css';

type Me = { viewer: Viewer | null; demo: boolean; demoStreamers?: string[] };
type DuelRow = { id: string; challenger_id: string; challenger_name: string; opponent_id: string; opponent_name: string; status: string; mode: string; created_at: number; winner: string | null; score_a: number; score_b: number };

export default function Dashboard() {
  const [me] = createResource(() => api<Me>('/api/me'));
  const [mm, { refetch }] = createResource(() => me()?.viewer, () => api<MatchmakingResponse>('/api/matchmaking'));
  const [duels, duelsCtl] = createResource(() => me()?.viewer, () => api<{ duels: DuelRow[] }>('/api/duels'));
  const [raidTarget, setRaidTarget] = createSignal<Match | null>(null);
  const [duelTarget, setDuelTarget] = createSignal<Match | null>(null);
  const [mapKey, setMapKey] = createSignal(0);

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
                    const incoming = d.opponent_id === me()!.viewer!.id;
                    return (
                      <div class="duel-item">
                        <span class="vs"><b class="a">{d.challenger_name}</b> vs <b class="b">{d.opponent_name}</b></span>
                        <span class="chip">{d.mode === 'tug' ? 'Tug of War' : 'Poll'} · {d.status}</span>
                        <span class="spacer" />
                        <Show when={incoming && d.status === 'pending'}>
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
            <span class="dim mono">{mm() ? (mm()!.cacheAge >= 0 ? `cache ${Math.round(mm()!.cacheAge / 1000)}s old` : 'cache warming') : ''}</span>
          </section>
          <Show when={!mm.loading} fallback={<div class="grid"><For each={[1, 2, 3, 4, 5, 6]}>{() => <div class="skeleton" style={{ height: '230px' }} />}</For></div>}>
            <Show when={mm.error}><div class="panel empty">Couldn't load matches: {String(mm.error?.message ?? mm.error)}</div></Show>
            <Show when={mm() && mm()!.matches.length === 0}><div class="panel empty">Nobody in your size range is live in this category right now. Check back in a few minutes.</div></Show>
            <div class="grid">
              <For each={mm()?.matches}>
                {(m, i) => <MatchCard m={m} rank={i() + 1} base={mm()!.baseViewers} onRaid={() => setRaidTarget(m)} onDuel={() => setDuelTarget(m)} />}
              </For>
            </div>
          </Show>

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
      <Show when={duelTarget()}>{(t) => <DuelModal m={t()} onClose={() => setDuelTarget(null)} />}</Show>
      <Toasts />
    </>
  );
}

function MatchCard(props: { m: Match; rank: number; base: number; onRaid: () => void; onDuel: () => void }) {
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

function DuelModal(props: { m: Match; onClose: () => void }) {
  const [mode, setMode] = createSignal<'tug' | 'poll'>('tug');
  const [question, setQuestion] = createSignal('Best cozy game of all time?');
  const [opts, setOpts] = createSignal('Stardew Valley, Animal Crossing, Spiritfarer, Unpacking');
  const [dur, setDur] = createSignal(60);
  const [busy, setBusy] = createSignal(false);
  const go = async () => {
    setBusy(true);
    try {
      const r = await api<{ duel: { id: string } }>('/api/duels', {
        json: { opponentId: props.m.stream.id, mode: mode(), durationS: dur(),
          ...(mode() === 'poll' ? { question: question(), options: opts().split(',').map((s) => s.trim()).filter(Boolean) } : {}) },
      });
      location.href = `/duel/${r.duel.id}`;
    } catch (e) { toast((e as Error).message, true); setBusy(false); }
  };
  return (
    <div class="modal-back" onClick={(e) => e.target === e.currentTarget && props.onClose()}>
      <div class="modal">
        <div class="panel-head"><h2>Challenge {props.m.stream.displayName}</h2></div>
        <div class="panel-body">
          <div class="seg">
            <button class={mode() === 'tug' ? 'on' : ''} onClick={() => setMode('tug')}>Tug of War</button>
            <button class={mode() === 'poll' ? 'on' : ''} onClick={() => setMode('poll')}>Chat Poll</button>
          </div>
          <p class="muted" style={{ margin: 0 }}>
            {mode() === 'tug' ? 'Each chat spams !pull to drag the rope to their side. One pull per chatter every 1.5s.' : 'Both chats vote !1–!4 on the same question. The chat with more voters wins.'}
          </p>
          <Show when={mode() === 'poll'}>
            <label>Question<input value={question()} onInput={(e) => setQuestion(e.currentTarget.value)} maxLength={120} /></label>
            <label>Options (comma-separated, 2–4)<input value={opts()} onInput={(e) => setOpts(e.currentTarget.value)} /></label>
          </Show>
          <label>Duration: {dur()}s<input type="range" min="20" max="300" step="10" value={dur()} onInput={(e) => setDur(+e.currentTarget.value)} /></label>
        </div>
        <div class="modal-foot">
          <button class="btn ghost" onClick={props.onClose}>Cancel</button>
          <button class="btn primary" disabled={busy()} onClick={go}>{busy() ? 'Sending…' : 'Send challenge'}</button>
        </div>
      </div>
    </div>
  );
}
