import type { ValidComponent } from 'solid-js';
import { splitProps } from 'solid-js';
import * as ToggleGroupPrimitive from '@kobalte/core/toggle-group';
import type { PolymorphicProps } from '@kobalte/core/polymorphic';
import { cn } from './utils';

type RootProps<T extends ValidComponent = 'div'> = ToggleGroupPrimitive.ToggleGroupRootProps<T> & { class?: string };
export const ToggleGroup = <T extends ValidComponent = 'div'>(props: PolymorphicProps<T, RootProps<T>>) => {
  const [l, o] = splitProps(props as RootProps, ['class']);
  return <ToggleGroupPrimitive.Root class={cn('inline-flex items-center gap-0.5 rounded-full border border-border bg-muted p-0.5', l.class)} {...o} />;
};
type ItemProps<T extends ValidComponent = 'button'> = ToggleGroupPrimitive.ToggleGroupItemProps<T> & { class?: string };
export const ToggleGroupItem = <T extends ValidComponent = 'button'>(props: PolymorphicProps<T, ItemProps<T>>) => {
  const [l, o] = splitProps(props as ItemProps, ['class']);
  return <ToggleGroupPrimitive.Item class={cn('inline-flex h-7 min-w-8 items-center justify-center rounded-full px-2.5 text-xs font-bold text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring data-[pressed]:text-white', l.class)} {...o} />;
};
