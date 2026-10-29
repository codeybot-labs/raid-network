import type { JSX } from 'solid-js';
import { splitProps } from 'solid-js';
import * as CheckboxPrimitive from '@kobalte/core/checkbox';
import Check from 'lucide-solid/icons/check';
import { cn } from './utils';

export const Checkbox = (props: CheckboxPrimitive.CheckboxRootProps & { class?: string; label?: JSX.Element }) => {
  const [l, o] = splitProps(props, ['class', 'label']);
  return (
    <CheckboxPrimitive.Root class={cn('items-top group relative flex items-center gap-2', l.class)} {...o}>
      <CheckboxPrimitive.Input class="peer" />
      <CheckboxPrimitive.Control class="size-4 shrink-0 rounded-[5px] border-2 border-secondary ring-offset-background peer-focus-visible:ring-2 peer-focus-visible:ring-ring data-[checked]:bg-secondary data-[checked]:text-secondary-foreground">
        <CheckboxPrimitive.Indicator class="flex items-center justify-center text-current"><Check class="size-3" stroke-width={3} /></CheckboxPrimitive.Indicator>
      </CheckboxPrimitive.Control>
      {l.label ? <CheckboxPrimitive.Label class="text-sm font-semibold text-muted-foreground">{l.label}</CheckboxPrimitive.Label> : null}
    </CheckboxPrimitive.Root>
  );
};
