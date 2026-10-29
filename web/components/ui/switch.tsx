import type { JSX, ValidComponent } from 'solid-js';
import { splitProps } from 'solid-js';
import * as SwitchPrimitive from '@kobalte/core/switch';
import type { PolymorphicProps } from '@kobalte/core/polymorphic';
import { cn } from './utils';

export const Switch = SwitchPrimitive.Root;
export const SwitchDescription = SwitchPrimitive.Description;

type ControlProps<T extends ValidComponent = 'input'> = SwitchPrimitive.SwitchControlProps<T> & { class?: string; children?: JSX.Element };
export const SwitchControl = <T extends ValidComponent = 'input'>(props: PolymorphicProps<T, ControlProps<T>>) => {
  const [l, o] = splitProps(props as ControlProps, ['class', 'children']);
  return (
    <>
      <SwitchPrimitive.Input class="peer sr-only" />
      <SwitchPrimitive.Control
        class={cn('inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent bg-input transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-focus-visible:ring-offset-2 data-[checked]:bg-primary data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50', l.class)}
        {...o}>
        {l.children}
      </SwitchPrimitive.Control>
    </>
  );
};
type ThumbProps<T extends ValidComponent = 'div'> = SwitchPrimitive.SwitchThumbProps<T> & { class?: string };
export const SwitchThumb = <T extends ValidComponent = 'div'>(props: PolymorphicProps<T, ThumbProps<T>>) => {
  const [l, o] = splitProps(props as ThumbProps, ['class']);
  return <SwitchPrimitive.Thumb class={cn('pointer-events-none block size-4 translate-x-0 rounded-full bg-background shadow transition-transform data-[checked]:translate-x-4', l.class)} {...o} />;
};
type LabelProps<T extends ValidComponent = 'label'> = SwitchPrimitive.SwitchLabelProps<T> & { class?: string };
export const SwitchLabel = <T extends ValidComponent = 'label'>(props: PolymorphicProps<T, LabelProps<T>>) => {
  const [l, o] = splitProps(props as LabelProps, ['class']);
  return <SwitchPrimitive.Label class={cn('text-sm font-bold leading-none', l.class)} {...o} />;
};
