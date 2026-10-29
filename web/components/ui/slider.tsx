import { splitProps } from 'solid-js';
import * as SliderPrimitive from '@kobalte/core/slider';
import { cn } from './utils';

/** solid-ui Slider (Kobalte) with a label row showing the value. */
export const Slider = (props: SliderPrimitive.SliderRootProps & { class?: string; label: string; valueLabel: string }) => {
  const [l, o] = splitProps(props, ['class', 'label', 'valueLabel']);
  return (
    <SliderPrimitive.Root class={cn('relative flex w-full touch-none select-none flex-col items-center gap-2.5', l.class)} {...o}>
      <div class="flex w-full justify-between text-[13px] font-semibold text-muted-foreground">
        <SliderPrimitive.Label>{l.label}</SliderPrimitive.Label>
        <span class="font-mono text-foreground">{l.valueLabel}</span>
      </div>
      <SliderPrimitive.Track class="relative h-2 w-full grow rounded-full bg-muted border border-border">
        <SliderPrimitive.Fill class="absolute h-full rounded-full bg-secondary" />
        <SliderPrimitive.Thumb class="-top-[5px] block size-4 rounded-full border-2 border-secondary bg-background shadow transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <SliderPrimitive.Input />
        </SliderPrimitive.Thumb>
      </SliderPrimitive.Track>
    </SliderPrimitive.Root>
  );
};
