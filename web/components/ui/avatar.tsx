import { splitProps } from 'solid-js';
import * as ImagePrimitive from '@kobalte/core/image';
import { cn } from './utils';

/** solid-ui Avatar (Kobalte Image) with an initials fallback. */
export const Avatar = (props: ImagePrimitive.ImageRootProps & { class?: string; src?: string; fallback: string; style?: Record<string, string> }) => {
  const [l, o] = splitProps(props, ['class', 'src', 'fallback', 'style']);
  return (
    <ImagePrimitive.Root class={cn('avatar-tile relative', l.class)} style={l.style} {...o}>
      {l.src ? <ImagePrimitive.Img src={l.src} alt="" class="size-full object-cover" /> : null}
      <ImagePrimitive.Fallback class="grid size-full place-items-center">{l.fallback}</ImagePrimitive.Fallback>
    </ImagePrimitive.Root>
  );
};
