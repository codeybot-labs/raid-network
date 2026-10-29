import type { JSX, ValidComponent } from 'solid-js';
import { splitProps } from 'solid-js';
import * as ButtonPrimitive from '@kobalte/core/button';
import type { PolymorphicProps } from '@kobalte/core/polymorphic';
import type { VariantProps } from 'class-variance-authority';
import { cn } from './utils';

export { buttonVariants } from './variants';
import { buttonVariants } from './variants';

type ButtonProps<T extends ValidComponent = 'button'> = ButtonPrimitive.ButtonRootProps<T> &
  VariantProps<typeof buttonVariants> & { class?: string | undefined; children?: JSX.Element };

export const Button = <T extends ValidComponent = 'button'>(props: PolymorphicProps<T, ButtonProps<T>>) => {
  const [local, others] = splitProps(props as ButtonProps, ['variant', 'size', 'class']);
  return <ButtonPrimitive.Root class={cn(buttonVariants({ variant: local.variant, size: local.size }), local.class)} {...others} />;
};
