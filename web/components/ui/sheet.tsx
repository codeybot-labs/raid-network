import type { Component, ComponentProps, JSX, ValidComponent } from 'solid-js';
import { splitProps } from 'solid-js';
import * as SheetPrimitive from '@kobalte/core/dialog';
import type { PolymorphicProps } from '@kobalte/core/polymorphic';
import { cn } from './utils';

// solid-ui Sheet: a Kobalte dialog that slides in from the right.
export const Sheet = SheetPrimitive.Root;
export const SheetTrigger = SheetPrimitive.Trigger;
export const SheetClose = SheetPrimitive.CloseButton;

type ContentProps<T extends ValidComponent = 'div'> = SheetPrimitive.DialogContentProps<T> & { class?: string; children?: JSX.Element };
export const SheetContent = <T extends ValidComponent = 'div'>(props: PolymorphicProps<T, ContentProps<T>>) => {
  const [l, o] = splitProps(props as ContentProps, ['class', 'children']);
  return (
    <SheetPrimitive.Portal>
      <SheetPrimitive.Overlay class="fixed inset-0 z-40 bg-ink/30 backdrop-blur-[2px] data-[expanded]:animate-in data-[closed]:animate-out data-[closed]:fade-out-0 data-[expanded]:fade-in-0" />
      <SheetPrimitive.Content
        class={cn('fixed inset-y-0 right-0 z-50 flex h-full w-full max-w-[460px] flex-col border-l border-border bg-background shadow-[-30px_0_80px_-30px_rgba(20,18,43,.35)] transition ease-in-out data-[expanded]:animate-in data-[closed]:animate-out data-[closed]:duration-200 data-[expanded]:duration-300 data-[closed]:slide-out-to-right data-[expanded]:slide-in-from-right', l.class)}
        {...o}>
        {l.children}
      </SheetPrimitive.Content>
    </SheetPrimitive.Portal>
  );
};
export const SheetHeader: Component<ComponentProps<'div'>> = (props) => {
  const [l, o] = splitProps(props, ['class']);
  return <div class={cn('flex items-center gap-2 border-b border-border px-5 py-4', l.class)} {...o} />;
};
type TitleProps<T extends ValidComponent = 'h2'> = SheetPrimitive.DialogTitleProps<T> & { class?: string };
export const SheetTitle = <T extends ValidComponent = 'h2'>(props: PolymorphicProps<T, TitleProps<T>>) => {
  const [l, o] = splitProps(props as TitleProps, ['class']);
  return <SheetPrimitive.Title class={cn('font-display text-lg font-extrabold', l.class)} {...o} />;
};
