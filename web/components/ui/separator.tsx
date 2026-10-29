import type { Component, ComponentProps } from 'solid-js';
import { splitProps } from 'solid-js';
import * as SeparatorPrimitive from '@kobalte/core/separator';
import { cn } from './utils';

export const Separator: Component<ComponentProps<'hr'> & { orientation?: 'horizontal' | 'vertical' }> = (props) => {
  const [l, o] = splitProps(props, ['class', 'orientation']);
  return <SeparatorPrimitive.Root orientation={l.orientation ?? 'horizontal'}
    class={cn('shrink-0 border-none bg-border', (l.orientation ?? 'horizontal') === 'vertical' ? 'h-full w-px' : 'h-px w-full', l.class)} {...(o as object)} />;
};
