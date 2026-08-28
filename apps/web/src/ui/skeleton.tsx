import type { ComponentProps } from "react";

import { cn } from "@/src/lib/utils";

// Theme pass: no gk token exists for a dedicated "muted surface" fill, so
// this reuses --gk-border (already the lowest-contrast token in the
// system) as the placeholder tint. animate-pulse is Tailwind's built-in
// opacity pulse; globals.css turns it off under prefers-reduced-motion
// (the skeleton's shape stays visible either way, only the pulse stops).
function Skeleton({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      className={cn("animate-pulse rounded-gk bg-gk-border", className)}
      {...props}
    />
  );
}

export { Skeleton };
