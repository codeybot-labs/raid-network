import { Toaster as Sonner } from 'solid-sonner';

/** shadcn "Sonner" toaster, themed with the Showdown tokens. */
export const Toaster = () => (
  <Sonner
    position="bottom-right"
    toastOptions={{
      classes: {
        toast: 'group !rounded-2xl !border !border-border !bg-background !text-foreground !shadow-[0_18px_50px_-18px_rgba(20,18,43,.4)] !font-sans !font-semibold',
        error: '!border-l-4 !border-l-[var(--red)]',
        success: '!border-l-4 !border-l-[var(--blue)]',
        description: '!text-muted-foreground',
      },
    }}
  />
);
