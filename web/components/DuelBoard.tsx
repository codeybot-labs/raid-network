import { createSignal, For, onCleanup, Show } from 'solid-js';
import type { DuelState } from '../../shared/types';
import Avatar from './Avatar';
import './duel.css';

/** The shared duel board, rendered identically on the duel page and in both channels' OBS overlays. */
export default function DuelBoard(props: { state: DuelState; offset: number; variant?: 'full' | 'overlay' }) {
  const [now, setNow] = createSignal(Date.now());
  const t = setInterval(() => setNow(Date.now()), 200);
  onCleanup(() => clearInterval(t));
  const s = () => props.state;
  const serverNow = () => now() + props.offset;
  const remaining = () => Math.max(0, Math.ceil(((s().endsAt ?? 0) - serverNow()) / 1000));
  const countdown = () => Math.max(0, Math.ceil(((s().countdownEndsAt ?? 0) - serverNow()) / 1000));
  const fmt = (sec: number) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
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
        <div class="clock">
          <Show when={s().status === 'live'}><div class="clock-time mono">{fmt(remaining())}</div><div class="clock-label">{s().mode === 'tug' ? 'TUG OF WAR' : 'CHAT POLL'}</div></Show>
          <Show when={s().status === 'countdown'}><div class="clock-count">{countdown() || 'GO'}</div></Show>
          <Show when={s().status === 'finished'}><div class="clock-label">FINAL</div></Show>
          <Show when={['pending', 'accepted', 'declined', 'cancelled'].includes(s().status)}><div class="clock-label">{s().status.toUpperCase()}</div></Show>
          <div class="vs">VS</div>
        </div>
        <div class="side side-b">
          <div class="side-score">{s().b.score}</div>
          <div style={{ 'text-align': 'right' }}><div class="side-name">{s().b.displayName}</div><div class="side-sub mono">{s().b.voters} chatters</div></div>
          <Avatar name={s().b.displayName} src={s().b.avatarUrl} size={props.variant === 'overlay' ? 40 : 52} />
        </div>
      </div>

      <Show when={s().question}><div class="question">{s().question}</div></Show>

      <Show when={s().mode === 'tug'}>
        <div class="tug">
          <div class="tug-zone a" /><div class="tug-zone b" />
          <div class="tug-rope" />
          <div class="tug-knot" style={{ left: `${50 + rope() * 44}%` }}><span>✦</span></div>
          <div class="tug-center" />
        </div>
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

      <Show when={props.variant !== 'overlay' || s().status === 'live'}>
        <div class="feed">
          <For each={s().feed.slice(0, props.variant === 'overlay' ? 5 : 10)}>
            {(f) => <span class={`feed-item ${f.side}`}><b>{f.login}</b> {f.text}</span>}
          </For>
        </div>
      </Show>
    </div>
  );
}
