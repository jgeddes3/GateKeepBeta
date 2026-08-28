import * as React from "react";

import { cn } from "@/src/lib/utils";

// Theme pass: 10px radius (the card/input tier), solid gk-surface, ember
// focus ring. No shadow: DESIGN.md reserves shadow for overlays, and a
// form input sitting flat on the page is not one.
function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "flex h-10 w-full min-w-0 rounded-gk border border-gk-border bg-gk-surface px-3.5 py-2 font-sora text-sm text-gk-text outline-none transition-colors",
        "placeholder:text-gk-muted",
        "selection:bg-gk-accent selection:text-gk-on-accent",
        "file:h-7 file:border-0 file:bg-transparent file:font-sora file:text-sm file:font-medium file:text-gk-text",
        "disabled:cursor-not-allowed disabled:opacity-50",
        "focus-visible:border-gk-accent focus-visible:ring-2 focus-visible:ring-gk-accent/40",
        "aria-invalid:border-gk-destructive aria-invalid:ring-2 aria-invalid:ring-gk-destructive/25",
        className,
      )}
      {...props}
    />
  );
}

export { Input };
