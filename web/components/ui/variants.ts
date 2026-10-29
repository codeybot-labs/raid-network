import { cva } from 'class-variance-authority';

// solid-ui Button, restyled with the Streamer Showdown pill + hard offset-shadow hover.
export const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-full font-bold transition-[transform,box-shadow,background-color,color] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground hover:-translate-x-0.5 hover:-translate-y-0.5 hover:shadow-pop-blue',
        secondary: 'bg-secondary text-secondary-foreground hover:-translate-x-0.5 hover:-translate-y-0.5 hover:shadow-pop-red',
        outline: 'bg-background text-foreground shadow-[inset_0_0_0_2px_var(--blue)] hover:bg-secondary hover:text-secondary-foreground hover:-translate-x-0.5 hover:-translate-y-0.5 hover:shadow-[4px_4px_0_var(--red)]',
        ghost: 'text-foreground hover:bg-accent hover:text-accent-foreground',
        soft: 'bg-muted text-foreground border border-border hover:bg-accent hover:text-accent-foreground',
        destructive: 'bg-background text-destructive shadow-[inset_0_0_0_2px_var(--destructive)] hover:bg-destructive hover:text-destructive-foreground',
        link: 'text-secondary underline-offset-4 hover:underline rounded-none px-0',
      },
      size: {
        default: 'h-10 px-5 text-sm',
        sm: 'h-8 px-3.5 text-[13px]',
        lg: 'h-12 px-7 text-base',
        icon: 'size-9 p-0',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
);

export const badgeVariants = cva(
  'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-semibold whitespace-nowrap transition-colors',
  {
    variants: {
      variant: {
        default: 'border-transparent bg-primary text-primary-foreground',
        secondary: 'border-transparent bg-secondary text-secondary-foreground',
        outline: 'border-border bg-background text-foreground',
        muted: 'border-transparent bg-muted text-muted-foreground',
        red: 'border-red/25 bg-red-soft text-red',
        blue: 'border-blue/25 bg-blue-soft text-blue-deep',
        gold: 'border-gold/30 bg-gold-soft text-[#8a5d00]',
        success: 'border-success/25 bg-success-soft text-success',
        live: 'border-red/30 bg-red-soft text-red',
      },
    },
    defaultVariants: { variant: 'outline' },
  },
);

