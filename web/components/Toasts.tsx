import { createSignal, For } from 'solid-js';

const [toasts, setToasts] = createSignal<{ id: number; text: string; err?: boolean }[]>([]);
let n = 0;
export function toast(text: string, err = false) {
  const id = ++n;
  setToasts((t) => [...t, { id, text, err }]);
  setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4200);
}
export function Toasts() {
  return <div class="toast-stack"><For each={toasts()}>{(t) => <div class={`toast ${t.err ? 'err' : ''}`}>{t.text}</div>}</For></div>;
}
