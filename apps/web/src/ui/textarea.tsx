import * as React from "react";

import { cn } from "@/src/lib/utils";

// Same theme pass as Input: 10px radius, solid gk-surface, ember focus
// ring, no shadow.
function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "flex min-h-20 w-full rounded-gk border border-gk-border bg-gk-surface px-3.5 py-2.5 font-sora text-sm text-gk-text outline-none transition-colors",
        "placeholder:text-gk-muted",
        "disabled:cursor-not-allowed disabled:opacity-50",
        "focus-visible:border-gk-accent focus-visible:ring-2 focus-visible:ring-gk-accent/40",
        "aria-invalid:border-gk-destructive aria-invalid:ring-2 aria-invalid:ring-gk-destructive/25",
        className,
      )}
      {...props}
    />
  );
}

export { Textarea };
