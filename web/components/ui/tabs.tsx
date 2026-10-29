import type { ValidComponent } from 'solid-js';
import { splitProps } from 'solid-js';
import * as TabsPrimitive from '@kobalte/core/tabs';
import type { PolymorphicProps } from '@kobalte/core/polymorphic';
import { cn } from './utils';

// solid-ui Tabs. The list doubles as the segmented control for duel format/mode and the raid map scope.
export const Tabs = TabsPrimitive.Root;

type ListProps<T extends ValidComponent = 'div'> = TabsPrimitive.TabsListProps<T> & { class?: string };
export const TabsList = <T extends ValidComponent = 'div'>(props: PolymorphicProps<T, ListProps<T>>) => {
  const [l, o] = splitProps(props as ListProps, ['class']);
  return <TabsPrimitive.List class={cn('relative inline-flex h-10 items-center justify-center rounded-full bg-muted p-1 text-muted-foreground border border-border', l.class)} {...o} />;
};
type TriggerProps<T extends ValidComponent = 'button'> = TabsPrimitive.TabsTriggerProps<T> & { class?: string };
export const TabsTrigger = <T extends ValidComponent = 'button'>(props: PolymorphicProps<T, TriggerProps<T>>) => {
  const [l, o] = splitProps(props as TriggerProps, ['class']);
  return <TabsPrimitive.Trigger class={cn('relative z-10 inline-flex h-8 items-center justify-center whitespace-nowrap rounded-full px-4 text-[13px] font-bold transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 data-[selected]:bg-secondary data-[selected]:text-secondary-foreground data-[selected]:shadow-sm', l.class)} {...o} />;
};
type IndicatorProps<T extends ValidComponent = 'div'> = TabsPrimitive.TabsIndicatorProps<T> & { class?: string };
export const TabsIndicator = <T extends ValidComponent = 'div'>(props: PolymorphicProps<T, IndicatorProps<T>>) => {
  const [l, o] = splitProps(props as IndicatorProps, ['class']);
  return <TabsPrimitive.Indicator class={cn('absolute inset-y-1 z-0 rounded-full bg-secondary shadow-sm transition-all duration-200', l.class)} {...o} />;
};
type ContentProps<T extends ValidComponent = 'div'> = TabsPrimitive.TabsContentProps<T> & { class?: string };
export const TabsContent = <T extends ValidComponent = 'div'>(props: PolymorphicProps<T, ContentProps<T>>) => {
  const [l, o] = splitProps(props as ContentProps, ['class']);
  return <TabsPrimitive.Content class={cn('focus-visible:outline-none', l.class)} {...o} />;
};
