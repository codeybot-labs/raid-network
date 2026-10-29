import { createEffect, createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import type { AssistantAction, AssistantEvent } from '../../shared/types';
import { renderMarkdown } from '../lib/markdown';
import './assistant.css';

export type ChatMsg = { role: 'user' | 'assistant'; content: string; actions?: AssistantAction[]; provider?: string; model?: string | null; error?: string; pending?: boolean };

export const SUGGESTED = [
  'Who should I raid tonight?',
  'Set up a duel with someone my size',
  'How did my last stream go?',
  'Show my raid network',
];

const storeKey = (login: string) => `rn-assistant:v1:${login}`;
const load = (login: string): ChatMsg[] => {
  try { return (JSON.parse(sessionStorage.getItem(storeKey(login)) ?? '[]') as ChatMsg[]).filter((m) => !m.pending); } catch { return []; }
};

/**
 * The chat itself. `onAction` decides what a button does (open the raid/duel dialog on the dashboard,
 * or navigate there from the full page). The assistant never acts on its own.
 */
export function AssistantChat(props: { login: string; name?: string; onAction: (a: AssistantAction) => void; variant?: 'drawer' | 'page'; autofocus?: boolean }) {
  const [msgs, setMsgs] = createSignal<ChatMsg[]>(load(props.login));
  const [input, setInput] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  let scroller: HTMLDivElement | undefined;
  let box: HTMLTextAreaElement | undefined;
  let abort: AbortController | null = null;

  createEffect(() => { try { sessionStorage.setItem(storeKey(props.login), JSON.stringify(msgs().slice(-40))); } catch { /* quota */ } });
  const scroll = () => queueMicrotask(() => scroller && (scroller.scrollTop = scroller.scrollHeight));
  onMount(() => { scroll(); if (props.autofocus) box?.focus(); });
  onCleanup(() => abort?.abort());

  const patchLast = (fn: (m: ChatMsg) => ChatMsg) => setMsgs((all) => [...all.slice(0, -1), fn(all[all.length - 1])]);

  const send = async (text: string) => {
    const q = text.trim();
    if (!q || busy()) return;
    setInput('');
    const history = [...msgs().filter((m) => !m.error), { role: 'user' as const, content: q }];
    setMsgs([...msgs(), { role: 'user', content: q }, { role: 'assistant', content: '', pending: true }]);
    setBusy(true); scroll();
    abort = new AbortController();
    try {
      const res = await fetch('/api/assistant', {
        method: 'POST', credentials: 'same-origin', signal: abort.signal, headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: history.slice(-12).map(({ role, content }) => ({ role, content })) }),
      });
      if (!res.ok || !res.body) {
        const err = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(err.error ?? `Request failed (${res.status})`);
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          const ev = JSON.parse(line) as AssistantEvent;
          if (ev.type === 'meta') patchLast((m) => ({ ...m, provider: ev.provider, model: ev.model }));
          else if (ev.type === 'delta') { patchLast((m) => ({ ...m, content: m.content + ev.text })); scroll(); }
          else if (ev.type === 'actions') { patchLast((m) => ({ ...m, actions: ev.actions })); scroll(); }
          else if (ev.type === 'error') patchLast((m) => ({ ...m, error: ev.error }));
          else if (ev.type === 'done' && !ev.ok) patchLast((m) => ({ ...m, provider: 'fallback' }));
        }
      }
      patchLast((m) => ({ ...m, pending: false }));
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;
      patchLast((m) => ({ ...m, pending: false, error: (e as Error).message }));
    } finally {
      setBusy(false); abort = null; scroll();
    }
  };

  const reset = () => { abort?.abort(); setBusy(false); setMsgs([]); box?.focus(); };
  const label = (a: AssistantAction) => (a.type === 'raid' ? `⟶ Raid ${a.displayName}` : a.type === 'duel' ? `⚔ Duel ${a.displayName}` : `${a.label} →`);
  const sub = (a: AssistantAction) => (a.type === 'raid' ? `${a.viewers} viewers` : '');

  return (
    <div class={`asst ${props.variant ?? 'drawer'}`}>
      <div class="asst-scroll" ref={scroller}>
        <Show when={msgs().length === 0}>
          <div class="asst-hello">
            <div class="asst-orb">✨</div>
            <h3>Hi{props.name ? ` ${props.name}` : ''}, I'm your raid co-pilot</h3>
            <p class="muted">I know your live partners, growth stats, duel record and raid map. I suggest raids and duels as buttons; nothing happens until you tap and confirm.</p>
          </div>
        </Show>
        <For each={msgs()}>
          {(m) => (
            <div class={`asst-msg ${m.role}`}>
              <Show when={m.role === 'assistant'} fallback={<div class="bubble">{m.content}</div>}>
                <div class="asst-av">✨</div>
                <div class="asst-body">
                  <Show when={m.content} fallback={<Show when={m.pending}><div class="typing"><i /><i /><i /></div></Show>}>
                    <div class="md" innerHTML={renderMarkdown(m.content)} />
                  </Show>
                  <Show when={m.pending && m.content}><span class="caret" /></Show>
                  <Show when={m.error}><div class="asst-err">{m.error}</div></Show>
                  <Show when={m.actions?.length}>
                    <div class="asst-actions">
                      <For each={m.actions}>
                        {(a) => (
                          <button class={`btn sm ${a.type === 'raid' ? 'violet' : a.type === 'duel' ? '' : 'ghost'}`} onClick={() => props.onAction(a)}>
                            {label(a)}<Show when={sub(a)}><span class="dim"> · {sub(a)}</span></Show>
                          </button>
                        )}
                      </For>
                    </div>
                  </Show>
                  <Show when={!m.pending && m.provider}>
                    <div class="asst-meta mono">{m.provider === 'ollama' ? `Ollama · ${m.model}` : m.provider === 'fallback' ? 'AI unavailable · template answer' : 'template mode (no AI key)'}</div>
                  </Show>
                </div>
              </Show>
            </div>
          )}
        </For>
      </div>
      <div class="asst-foot">
        <div class="asst-chips">
          <For each={SUGGESTED}>{(s) => <button class="chip prompt" disabled={busy()} onClick={() => send(s)}>{s}</button>}</For>
        </div>
        <form class="asst-input" onSubmit={(e) => { e.preventDefault(); send(input()); }}>
          <textarea ref={box} rows={1} placeholder="Ask about raids, duels, your stats…" value={input()} maxLength={600}
            onInput={(e) => { setInput(e.currentTarget.value); e.currentTarget.style.height = 'auto'; e.currentTarget.style.height = `${Math.min(120, e.currentTarget.scrollHeight)}px`; }}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(input()); } }} />
          <Show when={busy()} fallback={<button class="btn primary sm" type="submit" disabled={!input().trim()}>Send</button>}>
            <button class="btn sm ghost" type="button" onClick={() => { abort?.abort(); setBusy(false); patchLast((m) => ({ ...m, pending: false })); }}>Stop</button>
          </Show>
        </form>
        <div class="asst-tools">
          <span class="dim">Suggestions only: raids & invites need your confirmation.</span>
          <Show when={msgs().length}><button class="linkish" onClick={reset}>New chat</button></Show>
        </div>
      </div>
    </div>
  );
}

/** Slide-out panel used on the dashboard. */
export function AssistantDrawer(props: { open: boolean; login: string; name?: string; onClose: () => void; onAction: (a: AssistantAction) => void }) {
  onMount(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape' && props.open) props.onClose(); };
    window.addEventListener('keydown', key);
    onCleanup(() => window.removeEventListener('keydown', key));
  });
  return (
    <>
      <div class="asst-scrim" classList={{ open: props.open }} onClick={props.onClose} />
      <aside class="asst-drawer" classList={{ open: props.open }} aria-hidden={!props.open} aria-label="Assistant">
        <header class="asst-head">
          <div><div class="eyebrow">AI co-pilot</div><h2>Assistant</h2></div>
          <span class="spacer" />
          <a class="btn sm ghost" href="/assistant/" title="Open full page">⤢</a>
          <button class="btn sm ghost" onClick={props.onClose} aria-label="Close">✕</button>
        </header>
        <Show when={props.open}>
          <AssistantChat login={props.login} name={props.name} onAction={props.onAction} variant="drawer" autofocus />
        </Show>
      </aside>
    </>
  );
}

/** Full-page /assistant/: buttons hand off to the dashboard's confirm dialogs. */
export default function AssistantPage() {
  const [me, setMe] = createSignal<{ viewer: { login: string; displayName: string } | null } | null>(null);
  onMount(async () => setMe(await fetch('/api/me', { credentials: 'same-origin' }).then((r) => r.json()).catch(() => ({ viewer: null }))));
  const act = (a: AssistantAction) => {
    if (a.type === 'link') location.href = a.href;
    else location.href = `/dashboard/?${a.type}=${encodeURIComponent(a.login)}`;
  };
  return (
    <main class="wrap asst-page">
      <Show when={me()} fallback={<div class="skeleton" style={{ height: '70vh' }} />}>
        <Show when={me()!.viewer} fallback={<div class="panel empty"><h2>Sign in to use the assistant</h2><a class="btn primary" href="/auth/login">Sign in with Twitch</a></div>}>
          {(v) => (
            <div class="panel asst-page-panel">
              <header class="asst-head">
                <div><div class="eyebrow">AI co-pilot</div><h2>Assistant</h2></div>
                <span class="spacer" />
                <a class="btn sm ghost" href="/dashboard/">← Dashboard</a>
              </header>
              <AssistantChat login={v().login} name={v().displayName} onAction={act} variant="page" autofocus />
            </div>
          )}
        </Show>
      </Show>
    </main>
  );
}
