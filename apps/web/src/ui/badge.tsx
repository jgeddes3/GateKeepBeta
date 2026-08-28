import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/src/lib/utils";

// Theme pass: DESIGN.md's status tints ("Status tints", "Accessibility
// note on the accent"). Badges are always the 6px small-control radius
// and always carry real state, never decoration.
//
// "default" is the one accent-carrying variant, so it uses the SOLID fill
// (bg-gk-accent + gk-on-accent text) rather than the soft 14%-tint pattern
// the status colors use: DESIGN.md measures bare ember text at only
// 2.6-2.8:1 on a light surface (fails AA), and prescribes the filled-chip
// treatment as the safe pattern instead. success/warning/destructive were
// re-derived per theme specifically so the soft-tint-plus-saturated-text
// pairing clears AA, so those three keep that pattern.
const badgeVariants = cva(
  "inline-flex w-fit shrink-0 items-center gap-1 rounded-gk-sm px-2 py-0.5 font-sora text-xs font-medium whitespace-nowrap [&_svg]:pointer-events-none [&_svg]:size-3",
  {
    variants: {
      variant: {
        default: "bg-gk-accent text-gk-on-accent",
        secondary: "bg-gk-border/60 text-gk-text",
        outline: "border border-gk-border text-gk-text",
        destructive: "bg-gk-destructive/14 text-gk-destructive",
        success: "bg-gk-success/14 text-gk-success",
        warning: "bg-gk-warning/14 text-gk-warning",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

function Badge({
  className,
  variant,
  asChild = false,
  ...props
}: React.ComponentProps<"span"> &
  VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : "span";

  return (
    <Comp
      data-slot="badge"
      className={cn(badgeVariants({ variant, className }))}
      {...props}
    />
  );
}

export { Badge, badgeVariants };
