import { createSignal, For, onCleanup, Show, type Accessor } from 'solid-js';
import type { DuelChannel, DuelSideState, DuelState, Side } from '../../shared/types';
import Avatar from './Avatar';
import './duel.css';

type Variant = 'full' | 'overlay';
type Clock = { remaining: Accessor<number>; countdown: Accessor<number> };

const fmt = (sec: number) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
const INVITE_LABEL: Record<string, string> = { pending: 'invited', declined: 'declined', dropped: 'no-show', accepted: 'ready', host: 'host' };

/**
 * The shared duel board, rendered identically on the duel page and in every participating channel's
 * OBS overlay. 1v1 keeps the original two-sided layout; free-for-all gets race lanes; teams get a
 * Team A vs Team B board with per-channel contributions and top chatters.
 */
export default function DuelBoard(props: { state: DuelState; offset: number; variant?: Variant }) {
  const [now, setNow] = createSignal(Date.now());
  const t = setInterval(() => setNow(Date.now()), 200);
  onCleanup(() => clearInterval(t));
  const s = () => props.state;
  const serverNow = () => now() + props.offset;
  const clock: Clock = {
    remaining: () => Math.max(0, Math.ceil(((s().endsAt ?? 0) - serverNow()) / 1000)),
    countdown: () => Math.max(0, Math.ceil(((s().countdownEndsAt ?? 0) - serverNow()) / 1000)),
  };
  const format = () => s().format ?? '1v1';
  return (
    <>
      <Show when={format() === '1v1'}><OneVsOne state={s()} clock={clock} variant={props.variant} /></Show>
      <Show when={format() === 'ffa'}><FreeForAll state={s()} clock={clock} variant={props.variant} /></Show>
      <Show when={format() === 'teams'}><Teams state={s()} clock={clock} variant={props.variant} /></Show>
    </>
  );
}

function ClockBox(props: { s: DuelState; clock: Clock; label: string; vs?: string }) {
  return (
    <div class="clock">
      <Show when={props.s.status === 'live'}><div class="clock-time mono">{fmt(props.clock.remaining())}</div><div class="clock-label">{props.label}</div></Show>
      <Show when={props.s.status === 'countdown'}><div class="clock-count">{props.clock.countdown() || 'GO'}</div></Show>
      <Show when={props.s.status === 'finished'}><div class="clock-label">FINAL</div></Show>
      <Show when={['pending', 'accepted', 'declined', 'cancelled'].includes(props.s.status)}><div class="clock-label">{props.s.status.toUpperCase()}</div></Show>
      <Show when={props.vs}><div class="vs">{props.vs}</div></Show>
    </div>
  );
}

function Feed(props: { s: DuelState; variant?: Variant; showChannel?: boolean }) {
  return (
    <Show when={props.variant !== 'overlay' || props.s.status === 'live'}>
      <div class="feed">
        <For each={props.s.feed.slice(0, props.variant === 'overlay' ? 5 : 10)}>
          {(f) => <span class={`feed-item ${f.side}`}><b>{f.login}</b> {f.text}<Show when={props.showChannel && f.channel}><i class="mono"> @{f.channel}</i></Show></span>}
        </For>
      </div>
    </Show>
  );
}

// ---------------- 1v1 (unchanged layout) ----------------
function OneVsOne(props: { state: DuelState; clock: Clock; variant?: Variant }) {
  const s = () => props.state;
  // Rope position: -1 (all A) .. 1 (all B), damped so early pulls don't slam it to the edge.
  const rope = () => { const a = s().a.score, b = s().b.score; return Math.max(-1, Math.min(1, (b - a) / (a + b + 12))); };
  const total = (i: number) => s().a.poll[i] + s().b.poll[i];
  const maxTotal = () => Math.max(1, ...s().options.map((_, i) => total(i)));

  return (
    <div class={`board ${props.variant ?? 'full'} status-${s().status}`}>
      <div class="board-head">
        <div class="side side-a">
          <Avatar name={s().a.displayName} src={s().a.avatarUrl} size={props.variant === 'overlay' ? 40 : 52} />
          <div><div class="side-name">{s().a.displayName}</div><div class="side-sub mono">{s().a.voters} chatters</div></div>
          <div class="side-score">{s().a.score}</div>
        </div>
        <ClockBox s={s()} clock={props.clock} label={s().mode === 'tug' ? 'TUG OF WAR' : 'CHAT POLL'} vs="VS" />
        <div class="side side-b">
          <div class="side-score">{s().b.score}</div>
          <div style={{ 'text-align': 'right' }}><div class="side-name">{s().b.displayName}</div><div class="side-sub mono">{s().b.voters} chatters</div></div>
          <Avatar name={s().b.displayName} src={s().b.avatarUrl} size={props.variant === 'overlay' ? 40 : 52} />
        </div>
      </div>

      <Show when={s().question}><div class="question">{s().question}</div></Show>

      <Show when={s().mode === 'tug'}>
        <Rope pos={rope()} />
        <div class="howto mono"><span class="a">type !pull in {s().a.displayName}'s chat</span><span class="b">type !pull in {s().b.displayName}'s chat</span></div>
      </Show>

      <Show when={s().mode === 'poll'}>
        <div class="poll">
          <For each={s().options}>
            {(opt, i) => (
              <div class="poll-row">
                <div class="poll-label"><span class="mono key">!{i() + 1}</span> {opt}<span class="mono dim">{total(i())}</span></div>
                <div class="poll-bar">
                  <span class="pa" style={{ width: `${(s().a.poll[i()] / maxTotal()) * 100}%` }} />
                  <span class="pb" style={{ width: `${(s().b.poll[i()] / maxTotal()) * 100}%` }} />
                </div>
              </div>
            )}
          </For>
        </div>
      </Show>

      <Show when={s().status === 'finished'}>
        <div class={`winner w-${s().winner}`}>
          {s().winner === 'tie' ? "IT'S A TIE" : `${(s().winner === 'a' ? s().a : s().b).displayName}'s chat wins!`}
        </div>
      </Show>

      <Feed s={s()} variant={props.variant} />
    </div>
  );
}

function Rope(props: { pos: number }) {
  return (
    <div class="tug">
      <div class="tug-zone a" /><div class="tug-zone b" />
      <div class="tug-rope" />
      <div class="tug-knot" style={{ left: `${50 + props.pos * 44}%` }}><span>✦</span></div>
      <div class="tug-center" />
    </div>
  );
}

/** Stacked per-side poll bars (ffa lanes or teams). */
function PollStack(props: { s: DuelState; sides: { key: Side; poll: number[] }[] }) {
  const total = (i: number) => props.sides.reduce((t, x) => t + (x.poll[i] ?? 0), 0);
  const maxTotal = () => Math.max(1, ...props.s.options.map((_, i) => total(i)));
  return (
    <div class="poll">
      <For each={props.s.options}>
        {(opt, i) => (
          <div class="poll-row">
            <div class="poll-label"><span class="mono key">!{i() + 1}</span> {opt}<span class="mono dim">{total(i())}</span></div>
            <div class="poll-bar">
              <For each={props.sides}>{(x) => <span class={`p-${x.key}`} style={{ width: `${((x.poll[i()] ?? 0) / maxTotal()) * 100}%` }} />}</For>
            </div>
          </div>
        )}
      </For>
    </div>
  );
}

// ---------------- Free-for-all: one lane per channel ----------------
function FreeForAll(props: { state: DuelState; clock: Clock; variant?: Variant }) {
  const s = () => props.state;
  const ov = () => props.variant === 'overlay';
  const lanes = () => s().channels.filter((c) => c.invite !== 'declined' && c.invite !== 'dropped');
  const active = (c: DuelChannel) => c.invite === 'host' || c.invite === 'accepted';
  const target = () => (s().mode === 'tug' && s().raceTarget ? s().raceTarget : Math.max(1, ...lanes().map((c) => c.score)));
  // Rank by score; the leader gets the crown.
  const rank = (c: DuelChannel) => 1 + lanes().filter((x) => active(x) && x.score > c.score).length;
  const leader = () => { const best = Math.max(0, ...lanes().map((c) => c.score)); return best > 0 ? lanes().filter((c) => c.score === best) : []; };
  const winnerName = () => s().sides.find((x) => x.key === s().winner)?.name;
  return (
    <div class={`board ffa ${props.variant ?? 'full'} status-${s().status}`}>
      <div class="ffa-head">
        <div>
          <div class="mode-tag mono">FREE-FOR-ALL · {lanes().length} CHATS</div>
          <Show when={s().question}><div class="question left">{s().question}</div></Show>
        </div>
        <ClockBox s={s()} clock={props.clock} label={s().mode === 'tug' ? 'CHAT RACE' : 'CHAT POLL'} />
      </div>

      <div class="lanes">
        <For each={lanes()}>
          {(c) => (
            <div class={`lane lane-${c.side} ${active(c) ? '' : 'waiting'} ${leader().length === 1 && leader()[0].id === c.id ? 'leading' : ''}`}>
              <div class="lane-rank mono">{active(c) && s().status !== 'pending' ? `#${rank(c)}` : ''}</div>
              <Avatar name={c.displayName} src={c.avatarUrl} size={ov() ? 34 : 40} />
              <div class="lane-who">
                <div class="lane-name">{c.displayName}<Show when={leader().length === 1 && leader()[0].id === c.id}> <span class="crown">♛</span></Show></div>
                <div class="side-sub mono">{active(c) ? `${c.voters} chatters` : INVITE_LABEL[c.invite]}</div>
              </div>
              <div class="track">
                <div class="track-fill" style={{ width: `${Math.min(100, (c.score / target()) * 100)}%` }}><span class="runner" /></div>
                <Show when={s().mode === 'tug' && s().raceTarget}><div class="finish" title="finish line" /></Show>
              </div>
              <div class="lane-score">{c.score}</div>
            </div>
          )}
        </For>
      </div>
      <Show when={s().mode === 'tug'}>
        <div class="howto mono center">type <b>!pull</b> in your streamer's chat{s().raceTarget ? ` · first to ${s().raceTarget} wins` : ''}</div>
      </Show>
      <Show when={s().mode === 'poll'}>
        <PollStack s={s()} sides={s().sides} />
        <div class="howto mono center">vote !1–!{s().options.length} in your streamer's chat · most voters wins</div>
      </Show>

      <Show when={s().status === 'finished'}>
        <div class={`winner w-${s().winner}`}>{s().winner === 'tie' ? "IT'S A TIE" : `${winnerName()}'s chat wins${s().mode === 'tug' ? ' the race' : ''}!`}</div>
      </Show>
      <Feed s={s()} variant={props.variant} />
    </div>
  );
}

// ---------------- Teams: Team A vs Team B ----------------
function Teams(props: { state: DuelState; clock: Clock; variant?: Variant }) {
  const s = () => props.state;
  const ov = () => props.variant === 'overlay';
  const side = (k: Side): DuelSideState => s().sides.find((x) => x.key === k) ?? { key: k, name: k === 'a' ? 'Team A' : 'Team B', score: 0, voters: 0, poll: [], channelIds: [] };
  const roster = (k: Side) => s().channels.filter((c) => c.side === k && c.invite !== 'declined' && c.invite !== 'dropped');
  const rope = () => { const a = side('a').score, b = side('b').score; return Math.max(-1, Math.min(1, (b - a) / (a + b + 12))); };
  const winnerName = () => side(s().winner as Side)?.name;

  const Roster = (p: { k: Side }) => {
    const team = () => side(p.k);
    const top = () => { const r = roster(p.k).filter((c) => c.score > 0); return r.length ? r.reduce((m, c) => (c.score > m.score ? c : m)) : null; };
    return (
      <div class={`roster roster-${p.k}`}>
        <For each={roster(p.k)}>
          {(c, i) => (
            <div class={`member shade-${i()} ${c.invite === 'pending' ? 'waiting' : ''} ${top()?.id === c.id ? 'mvp' : ''}`}>
              <Avatar name={c.displayName} src={c.avatarUrl} size={ov() ? 24 : 28} />
              <span class="member-name">{c.displayName}<Show when={top()?.id === c.id}> <span class="crown">♛</span></Show></span>
              <Show when={c.invite === 'pending'} fallback={<span class="member-score mono">{c.score}<i>{team().score ? ` · ${Math.round((c.score / team().score) * 100)}%` : ''}</i></span>}>
                <span class="member-score mono dim">invited</span>
              </Show>
              <span class="member-bar" style={{ width: `${team().score ? (c.score / team().score) * 100 : 0}%` }} />
            </div>
          )}
        </For>
      </div>
    );
  };

  const Top = (p: { k: Side }) => (
    <div class={`top top-${p.k}`}>
      <For each={(s().top ?? []).filter((x) => x.side === p.k)}>
        {(x, i) => <span class="top-item"><b class="mono">{i() + 1}</b> {x.login}<Show when={s().mode === 'tug'}><i class="mono"> {x.count}</i></Show></span>}
      </For>
    </div>
  );

  return (
    <div class={`board teams ${props.variant ?? 'full'} status-${s().status}`}>
      <div class="board-head">
        <div class="side side-a">
          <div class="team-badge a">A</div>
          <div><div class="side-name">{side('a').name}</div><div class="side-sub mono">{roster('a').length} ch · {side('a').voters} chatters</div></div>
          <div class="side-score">{side('a').score}</div>
        </div>
        <ClockBox s={s()} clock={props.clock} label={s().mode === 'tug' ? 'TEAM TUG' : 'TEAM POLL'} vs={`${roster('a').length}v${roster('b').length}`} />
        <div class="side side-b">
          <div class="side-score">{side('b').score}</div>
          <div style={{ 'text-align': 'right' }}><div class="side-name">{side('b').name}</div><div class="side-sub mono">{roster('b').length} ch · {side('b').voters} chatters</div></div>
          <div class="team-badge b">B</div>
        </div>
      </div>

      <div class="rosters"><Roster k="a" /><Roster k="b" /></div>

      <Show when={s().question}><div class="question">{s().question}</div></Show>

      <Show when={s().mode === 'tug'}>
        <Rope pos={rope()} />
        <div class="howto mono"><span class="a">!pull in any {side('a').name} chat</span><span class="b">!pull in any {side('b').name} chat</span></div>
      </Show>
      <Show when={s().mode === 'poll'}><PollStack s={s()} sides={[side('a'), side('b')]} /></Show>

      <Show when={['live', 'finished'].includes(s().status) && (s().top ?? []).length}>
        <div class="tops"><Top k="a" /><span class="tops-label mono">{s().mode === 'tug' ? 'TOP PULLERS' : 'FIRST VOTERS'}</span><Top k="b" /></div>
      </Show>

      <Show when={s().status === 'finished'}>
        <div class={`winner w-${s().winner}`}>{s().winner === 'tie' ? "IT'S A TIE" : `${winnerName()} wins!`}</div>
      </Show>
      <Feed s={s()} variant={props.variant} showChannel />
    </div>
  );
}
