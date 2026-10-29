import { toast as sonner } from 'solid-sonner';
import { Toaster } from './ui/sonner';

/** Thin wrapper so islands keep calling toast(text, err); rendered by shadcn's Sonner. */
export function toast(text: string, err = false) {
  if (err) sonner.error(text); else sonner.success(text);
}
export function Toasts() {
  return <Toaster />;
}
