import type { Component, ComponentProps } from 'solid-js';
import { splitProps } from 'solid-js';
import { cn } from './utils';

const base = 'flex w-full rounded-xl border border-input bg-background px-3.5 py-2 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:border-ring disabled:cursor-not-allowed disabled:opacity-50';

export const Input: Component<ComponentProps<'input'>> = (props) => {
  const [l, o] = splitProps(props, ['class']);
  return <input class={cn(base, 'h-10', l.class)} {...o} />;
};
export const Textarea: Component<ComponentProps<'textarea'>> = (props) => {
  const [l, o] = splitProps(props, ['class']);
  return <textarea class={cn(base, 'min-h-[60px]', l.class)} {...o} />;
};
export const Label: Component<ComponentProps<'label'>> = (props) => {
  const [l, o] = splitProps(props, ['class']);
  return <label class={cn('grid gap-1.5 text-[13px] font-semibold text-muted-foreground', l.class)} {...o} />;
};
