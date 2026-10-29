import type { Component, ComponentProps } from 'solid-js';
import { splitProps } from 'solid-js';
import { cn } from './utils';

export const Card: Component<ComponentProps<'div'>> = (props) => {
  const [l, o] = splitProps(props, ['class']);
  return <div class={cn('rounded-[20px] border border-border bg-card text-card-foreground shadow-[0_1px_2px_rgba(20,18,43,.04)]', l.class)} {...o} />;
};
export const CardHeader: Component<ComponentProps<'div'>> = (props) => {
  const [l, o] = splitProps(props, ['class']);
  return <div class={cn('flex flex-col gap-1.5 p-5', l.class)} {...o} />;
};
export const CardTitle: Component<ComponentProps<'h3'>> = (props) => {
  const [l, o] = splitProps(props, ['class']);
  return <h3 class={cn('font-display text-base font-extrabold leading-none tracking-tight', l.class)} {...o} />;
};
export const CardDescription: Component<ComponentProps<'p'>> = (props) => {
  const [l, o] = splitProps(props, ['class']);
  return <p class={cn('text-sm text-muted-foreground', l.class)} {...o} />;
};
export const CardContent: Component<ComponentProps<'div'>> = (props) => {
  const [l, o] = splitProps(props, ['class']);
  return <div class={cn('p-5 pt-0', l.class)} {...o} />;
};
export const CardFooter: Component<ComponentProps<'div'>> = (props) => {
  const [l, o] = splitProps(props, ['class']);
  return <div class={cn('flex items-center p-5 pt-0', l.class)} {...o} />;
};
