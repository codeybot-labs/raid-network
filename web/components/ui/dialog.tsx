import type { Component, ComponentProps, JSX, ValidComponent } from 'solid-js';
import { splitProps } from 'solid-js';
import * as DialogPrimitive from '@kobalte/core/dialog';
import type { PolymorphicProps } from '@kobalte/core/polymorphic';
import X from 'lucide-solid/icons/x';
import { cn } from './utils';

// solid-ui Dialog (Kobalte), Showdown look: white card, 20px radius, blue focus ring.
export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;

type OverlayProps<T extends ValidComponent = 'div'> = DialogPrimitive.DialogOverlayProps<T> & { class?: string };
export const DialogOverlay = <T extends ValidComponent = 'div'>(props: PolymorphicProps<T, OverlayProps<T>>) => {
  const [l, o] = splitProps(props as OverlayProps, ['class']);
  return <DialogPrimitive.Overlay class={cn('fixed inset-0 z-50 bg-ink/40 backdrop-blur-[3px] data-[expanded]:animate-in data-[closed]:animate-out data-[closed]:fade-out-0 data-[expanded]:fade-in-0', l.class)} {...o} />;
};

type ContentProps<T extends ValidComponent = 'div'> = DialogPrimitive.DialogContentProps<T> & { class?: string; children?: JSX.Element };
export const DialogContent = <T extends ValidComponent = 'div'>(props: PolymorphicProps<T, ContentProps<T>>) => {
  const [l, o] = splitProps(props as ContentProps, ['class', 'children']);
  return (
    <DialogPrimitive.Portal>
      <DialogOverlay />
      <div class="fixed inset-0 z-50 grid place-items-center p-4 pointer-events-none">
        <DialogPrimitive.Content
          class={cn('pointer-events-auto relative grid w-full max-w-lg gap-4 rounded-[22px] border border-border bg-background p-6 shadow-[0_30px_80px_-24px_rgba(20,18,43,.35)] data-[expanded]:animate-in data-[closed]:animate-out data-[closed]:fade-out-0 data-[expanded]:fade-in-0 data-[closed]:zoom-out-95 data-[expanded]:zoom-in-95', l.class)}
          {...o}>
          {l.children}
          <DialogPrimitive.CloseButton class="absolute right-4 top-4 rounded-full p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <X class="size-4" /><span class="sr-only">Close</span>
          </DialogPrimitive.CloseButton>
        </DialogPrimitive.Content>
      </div>
    </DialogPrimitive.Portal>
  );
};

export const DialogHeader: Component<ComponentProps<'div'>> = (props) => {
  const [l, o] = splitProps(props, ['class']);
  return <div class={cn('flex flex-col gap-1.5 pr-8', l.class)} {...o} />;
};
export const DialogFooter: Component<ComponentProps<'div'>> = (props) => {
  const [l, o] = splitProps(props, ['class']);
  return <div class={cn('flex flex-col-reverse gap-2 sm:flex-row sm:justify-end', l.class)} {...o} />;
};
type TitleProps<T extends ValidComponent = 'h2'> = DialogPrimitive.DialogTitleProps<T> & { class?: string };
export const DialogTitle = <T extends ValidComponent = 'h2'>(props: PolymorphicProps<T, TitleProps<T>>) => {
  const [l, o] = splitProps(props as TitleProps, ['class']);
  return <DialogPrimitive.Title class={cn('font-display text-xl font-extrabold tracking-tight', l.class)} {...o} />;
};
type DescProps<T extends ValidComponent = 'p'> = DialogPrimitive.DialogDescriptionProps<T> & { class?: string };
export const DialogDescription = <T extends ValidComponent = 'p'>(props: PolymorphicProps<T, DescProps<T>>) => {
  const [l, o] = splitProps(props as DescProps, ['class']);
  return <DialogPrimitive.Description class={cn('text-sm text-muted-foreground', l.class)} {...o} />;
};
