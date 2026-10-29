import type { Component, ComponentProps } from 'solid-js';
import { splitProps } from 'solid-js';
import { cn } from './utils';

export const Skeleton: Component<ComponentProps<'div'>> = (props) => {
  const [l, o] = splitProps(props, ['class']);
  return <div class={cn('animate-pulse rounded-[20px] bg-muted', l.class)} {...o} />;
};
