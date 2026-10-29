import type { JSX } from 'solid-js';
import * as TooltipPrimitive from '@kobalte/core/tooltip';

/** solid-ui Tooltip, wrapped: <Tooltip content="...">trigger</Tooltip>. */
export const Tooltip = (props: { content: JSX.Element; children: JSX.Element; class?: string; placement?: TooltipPrimitive.TooltipRootProps['placement'] }) => (
  <TooltipPrimitive.Root openDelay={250} gutter={6} placement={props.placement ?? 'top'}>
    <TooltipPrimitive.Trigger as="span" class={props.class ?? 'inline-flex'}>{props.children}</TooltipPrimitive.Trigger>
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content class="z-50 max-w-[280px] rounded-lg bg-ink px-2.5 py-1.5 text-xs font-semibold text-white shadow-md data-[expanded]:animate-in data-[expanded]:fade-in-0 data-[expanded]:zoom-in-95">
        {props.content}
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  </TooltipPrimitive.Root>
);
