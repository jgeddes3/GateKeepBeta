import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/src/lib/utils";

// Theme pass (sub-project 9A, task 2): shadcn's button.tsx re-themed to the
// gk-* tokens. Radius per DESIGN.md: the "default" variant is the primary
// action, so it is the ONLY variant that gets the 999px pill (rounded-full).
// Every other variant uses the 10px card/input tier so a button sits flush
// against an adjacent input in a form row. The "icon" size is a compact
// square control, so it drops to the 6px small-control tier instead.
const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap font-sora text-sm font-medium outline-none transition-colors disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 focus-visible:ring-2 focus-visible:ring-gk-accent",
  {
    variants: {
      variant: {
        default: "rounded-full bg-gk-accent text-gk-on-accent hover:bg-gk-accent/90",
        destructive: "rounded-gk bg-gk-destructive text-gk-on-destructive hover:bg-gk-destructive/90",
        outline: "rounded-gk border border-gk-border bg-transparent text-gk-text hover:bg-gk-border/40",
        secondary: "rounded-gk border border-gk-border bg-transparent text-gk-text hover:bg-gk-border/40",
        ghost: "rounded-gk bg-transparent text-gk-text hover:bg-gk-border/30",
        link: "rounded-none text-gk-text underline-offset-4 hover:underline",
      },
      size: {
        default: "h-10 px-5 has-[>svg]:px-4",
        sm: "h-9 gap-1.5 px-4 text-sm has-[>svg]:px-3",
        lg: "h-11 px-6 has-[>svg]:px-5",
        icon: "size-10 rounded-gk-sm",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
  }) {
  const Comp = asChild ? Slot : "button";

  return (
    <Comp
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Button, buttonVariants };
