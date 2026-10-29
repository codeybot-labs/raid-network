import type { Component, ComponentProps } from 'solid-js';
import { splitProps } from 'solid-js';
import { cn } from './utils';

export const Table: Component<ComponentProps<'table'>> = (props) => {
  const [l, o] = splitProps(props, ['class']);
  return <div class="relative w-full overflow-auto"><table class={cn('w-full caption-bottom text-sm', l.class)} {...o} /></div>;
};
export const TableHeader: Component<ComponentProps<'thead'>> = (props) => {
  const [l, o] = splitProps(props, ['class']);
  return <thead class={cn('[&_tr]:border-b', l.class)} {...o} />;
};
export const TableBody: Component<ComponentProps<'tbody'>> = (props) => {
  const [l, o] = splitProps(props, ['class']);
  return <tbody class={cn('[&_tr:last-child]:border-0', l.class)} {...o} />;
};
export const TableRow: Component<ComponentProps<'tr'>> = (props) => {
  const [l, o] = splitProps(props, ['class']);
  return <tr class={cn('border-b border-border transition-colors hover:bg-muted/60', l.class)} {...o} />;
};
export const TableHead: Component<ComponentProps<'th'>> = (props) => {
  const [l, o] = splitProps(props, ['class']);
  return <th class={cn('h-10 px-3 text-left align-middle text-xs font-semibold uppercase tracking-wider text-muted-foreground', l.class)} {...o} />;
};
export const TableCell: Component<ComponentProps<'td'>> = (props) => {
  const [l, o] = splitProps(props, ['class']);
  return <td class={cn('px-3 py-2.5 align-middle', l.class)} {...o} />;
};
