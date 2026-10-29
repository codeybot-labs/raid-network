import type { JSX } from 'solid-js';
import * as SelectPrimitive from '@kobalte/core/select';
import Check from 'lucide-solid/icons/check';
import ChevronDown from 'lucide-solid/icons/chevron-down';
import { cn } from './utils';

export type SelectOption = { value: string; label: string; hint?: string };

/** solid-ui Select (Kobalte), wrapped for simple value/label options. */
export function Select(props: {
  options: SelectOption[]; value?: string; placeholder?: string; onChange: (v: string) => void;
  class?: string; triggerClass?: string; 'aria-label'?: string; resetOnPick?: boolean;
}) {
  const selected = () => props.options.find((o) => o.value === props.value) ?? null;
  return (
    <SelectPrimitive.Root<SelectOption>
      class={props.class}
      options={props.options}
      optionValue="value"
      optionTextValue="label"
      value={props.resetOnPick ? null : selected()}
      onChange={(o) => o && props.onChange(o.value)}
      placeholder={props.placeholder}
      itemComponent={(p) => (
        <SelectPrimitive.Item item={p.item} class="relative mt-0 flex w-full cursor-default select-none items-center justify-between gap-3 rounded-lg py-2 pl-2.5 pr-8 text-sm outline-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground data-[disabled]:opacity-50">
          <SelectPrimitive.ItemLabel class="font-semibold">{p.item.rawValue.label}</SelectPrimitive.ItemLabel>
          {p.item.rawValue.hint ? <span class="font-mono text-xs text-muted-foreground">{p.item.rawValue.hint}</span> : null}
          <SelectPrimitive.ItemIndicator class="absolute right-2 flex size-4 items-center justify-center"><Check class="size-4" /></SelectPrimitive.ItemIndicator>
        </SelectPrimitive.Item>
      )}
      aria-label={props['aria-label']}
    >
      <SelectPrimitive.Trigger class={cn('flex h-10 w-full items-center justify-between gap-2 rounded-xl border border-input bg-background px-3.5 text-sm font-semibold focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-50 data-[placeholder-shown]:text-muted-foreground', props.triggerClass)}>
        <SelectPrimitive.Value<SelectOption> class="truncate">{(s) => s.selectedOption()?.label as JSX.Element}</SelectPrimitive.Value>
        <SelectPrimitive.Icon><ChevronDown class="size-4 opacity-60" /></SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content class="relative z-[60] min-w-[8rem] overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-lg data-[expanded]:animate-in data-[expanded]:fade-in-0 data-[expanded]:zoom-in-95">
          <SelectPrimitive.Listbox class="m-0 max-h-72 overflow-y-auto p-1" />
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}
