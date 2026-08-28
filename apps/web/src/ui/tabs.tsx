"use client";

import * as React from "react";
import * as TabsPrimitive from "@radix-ui/react-tabs";

import { cn } from "@/src/lib/utils";

// Theme pass: an underline tab style rather than a segmented-pill switcher,
// so it never has to invoke the pill radius tier at all ("borders do the
// separating", DESIGN.md > Elevation). The active indicator is ember,
// which DESIGN.md's accent dosage list names explicitly ("the active nav
// item"): a tab is the same kind of state affordance.
function Tabs({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Root>) {
  return (
    <TabsPrimitive.Root
      data-slot="tabs"
      className={cn("flex flex-col gap-4", className)}
      {...props}
    />
  );
}

function TabsList({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.List>) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      className={cn("inline-flex w-fit items-center gap-4 border-b border-gk-border", className)}
      {...props}
    />
  );
}

function TabsTrigger({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      className={cn(
        "inline-flex items-center justify-center gap-1.5 border-b-2 border-transparent px-1 py-2.5 font-sora text-sm font-medium text-gk-muted whitespace-nowrap outline-none transition-colors",
        "hover:text-gk-text",
        "focus-visible:ring-2 focus-visible:ring-gk-accent focus-visible:rounded-gk-sm",
        "disabled:pointer-events-none disabled:opacity-50",
        "data-[state=active]:border-gk-accent data-[state=active]:text-gk-text",
        className,
      )}
      {...props}
    />
  );
}

function TabsContent({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return (
    <TabsPrimitive.Content
      data-slot="tabs-content"
      className={cn("outline-none", className)}
      {...props}
    />
  );
}

export { Tabs, TabsList, TabsTrigger, TabsContent };
