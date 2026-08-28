"use client";

import * as React from "react";
import * as SwitchPrimitive from "@radix-ui/react-switch";

import { cn } from "@/src/lib/utils";

// Theme pass: DESIGN.md's radius rule reserves the 999px pill for primary
// CTAs and chips ONLY, so this is a rounded-rect toggle (the 6px
// small-control tier) rather than the conventional pill switch. The thumb
// swaps color with state rather than staying one flat fill, reusing the
// same accent/on-accent pairing the primary button and default badge
// already use (verified 6.36:1 in DESIGN.md), so the checked thumb reads
// clearly against the ember track in both themes; the unchecked thumb
// uses gk-text against a gk-surface track for the same reason (gk-border
// alone is deliberately too low-contrast to carry this on its own).
function Switch({ className, ...props }: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        "peer inline-flex h-6 w-10 shrink-0 items-center rounded-gk-sm border outline-none transition-colors",
        "border-gk-border bg-gk-surface",
        "data-[state=checked]:border-gk-accent data-[state=checked]:bg-gk-accent",
        "focus-visible:ring-2 focus-visible:ring-gk-accent",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className={cn(
          "pointer-events-none block size-4 translate-x-1 rounded-[4px] bg-gk-text transition-transform",
          "data-[state=checked]:translate-x-[19px] data-[state=checked]:bg-gk-on-accent",
        )}
      />
    </SwitchPrimitive.Root>
  );
}

export { Switch };
