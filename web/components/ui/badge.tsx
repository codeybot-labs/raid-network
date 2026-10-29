import type { Component, ComponentProps } from 'solid-js';
import { splitProps } from 'solid-js';
import type { VariantProps } from 'class-variance-authority';
import { cn } from './utils';

export { badgeVariants } from './variants';
import { badgeVariants } from './variants';

export const Badge: Component<ComponentProps<'span'> & VariantProps<typeof badgeVariants>> = (props) => {
  const [l, o] = splitProps(props, ['class', 'variant', 'children']);
  return (
    <span class={cn(badgeVariants({ variant: l.variant }), l.class)} {...o}>
      {l.variant === 'live' ? <span class="live-dot" /> : null}
      {l.children}
    </span>
  );
};
