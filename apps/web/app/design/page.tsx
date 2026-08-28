import type { Metadata } from "next";
import type { ReactNode } from "react";

import { ThemeToggle } from "../../src/shell/ThemeToggle";
import { Button } from "../../src/ui/button";
import { Input } from "../../src/ui/input";
import { Textarea } from "../../src/ui/textarea";
import { Badge } from "../../src/ui/badge";
import { Switch } from "../../src/ui/switch";
import { Skeleton } from "../../src/ui/skeleton";
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from "../../src/ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "../../src/ui/tabs";
import { Tooltip, TooltipTrigger, TooltipContent } from "../../src/ui/tooltip";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../src/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../../src/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogClose,
} from "../../src/ui/dialog";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "../../src/ui/sheet";
import { IconWeightSample } from "./IconWeightSample";

// Dev-only reference page: not linked from any nav. Renders the gk-* token
// set and the src/ui component library so a reviewer can toggle the
// ThemeToggle above and check both themes without devtools. All copy on
// this page is either a literal token name/value from DESIGN.md or is
// explicitly labeled "Sample" (R-38): nothing here is a real product
// number.
export const metadata: Metadata = {
  title: "Design reference (dev)",
  robots: { index: false, follow: false },
};

const COLOR_TOKENS: Array<{ token: string; role: string; dark: string; light: string }> = [
  { token: "--gk-bg-0", role: "Page gradient start / flat bg (light)", dark: "#0E0B13", light: "#FAF7F2" },
  { token: "--gk-bg-1", role: "Page gradient midpoint / flat bg (light)", dark: "#150F20", light: "#FAF7F2" },
  { token: "--gk-bg-2", role: "Page gradient end / flat bg (light)", dark: "#1D1229", light: "#FAF7F2" },
  { token: "--gk-surface", role: "Card and panel background", dark: "#1A1424", light: "#FFFFFF" },
  { token: "--gk-border", role: "Card, input, divider border", dark: "#2C2438", light: "#E4DDD2" },
  { token: "--gk-text", role: "Primary text", dark: "#F5F1F8", light: "#1C1524" },
  { token: "--gk-muted", role: "Secondary text", dark: "rgba(245,241,248,.62)", light: "rgba(28,21,36,.62)" },
  { token: "--gk-accent", role: "Ember. Primary action, money, brand", dark: "#FF6B4A", light: "#FF6B4A" },
  { token: "--gk-on-accent", role: "Foreground on solid accent fill", dark: "#2A0F0A", light: "#2A0F0A" },
  { token: "--gk-success", role: "Success status tint", dark: "#7BC48A", light: "#2E7D43" },
  { token: "--gk-warning", role: "Warning status tint", dark: "#E8B15C", light: "#9A6A1B" },
  { token: "--gk-destructive", role: "Destructive tint / button fill", dark: "#E5484D", light: "#C62A30" },
  { token: "--gk-on-destructive", role: "Foreground on solid destructive fill", dark: "#FFFFFF", light: "#FFFFFF" },
];

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div>
        <h2 className="font-syne text-xl font-semibold text-gk-text">{title}</h2>
        {description ? <p className="mt-1 font-sora text-sm text-gk-muted">{description}</p> : null}
      </div>
      {children}
    </section>
  );
}

function Swatch({ token, role, dark, light }: (typeof COLOR_TOKENS)[number]) {
  return (
    <div className="flex items-center gap-3 rounded-gk border border-gk-border bg-gk-surface p-3">
      <span
        aria-hidden="true"
        className="size-10 shrink-0 rounded-gk-sm border border-gk-border"
        style={{ background: `var(${token})` }}
      />
      <div className="min-w-0">
        <p className="font-sora text-sm font-medium text-gk-text">{token}</p>
        <p className="truncate font-sora text-xs text-gk-muted">{role}</p>
        <p className="font-sora text-xs text-gk-muted">
          Dark {dark} &middot; Light {light}
        </p>
      </div>
    </div>
  );
}

export default function DesignReferencePage() {
  return (
    <main
      className="mx-auto flex max-w-4xl flex-col gap-14 px-6 py-12"
      style={{ background: "var(--gk-page)" }}
    >
      <header className="flex flex-wrap items-start justify-between gap-4 border-b border-gk-border pb-8">
        <div>
          <p className="font-sora text-xs font-medium text-gk-muted">Internal / dev reference, not linked from the app nav</p>
          <h1 className="font-syne text-3xl font-bold text-gk-text">GateKeep design reference</h1>
          <p className="mt-2 max-w-xl font-sora text-sm text-gk-muted">
            The gk-* token set and the themed src/ui component library from DESIGN.md. Use the
            toggle to check both themes.
          </p>
        </div>
        <ThemeToggle />
      </header>

      <Section
        title="Color tokens"
        description="Live swatches read the current theme's CSS variable. --gk-page and --gk-scrim are gradients, so they are applied with an inline style rather than a bg-gk-* class (see DESIGN.md's color-token note)."
      >
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {COLOR_TOKENS.map((entry) => (
            <Swatch key={entry.token} {...entry} />
          ))}
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="flex items-center gap-3 rounded-gk border border-gk-border bg-gk-surface p-3">
            <span
              aria-hidden="true"
              className="size-10 shrink-0 rounded-gk-sm border border-gk-border"
              style={{ background: "var(--gk-page)" }}
            />
            <div>
              <p className="font-sora text-sm font-medium text-gk-text">--gk-page</p>
              <p className="font-sora text-xs text-gk-muted">
                Page-level background. Gradient in dark, flat in light.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3 rounded-gk border border-gk-border bg-gk-surface p-3">
            <span
              aria-hidden="true"
              className="size-10 shrink-0 rounded-gk-sm border border-gk-border"
              style={{ background: "var(--gk-scrim)" }}
            />
            <div>
              <p className="font-sora text-sm font-medium text-gk-text">--gk-scrim</p>
              <p className="font-sora text-xs text-gk-muted">
                Bottom-up night scrim over photography. Same gradient in both themes.
              </p>
            </div>
          </div>
        </div>
      </Section>

      <Section title="Type scale">
        <div className="flex flex-col gap-4 rounded-gk border border-gk-border bg-gk-surface p-6">
          <p className="font-syne text-4xl font-bold text-gk-text">Syne display, 4xl bold</p>
          <p className="font-syne text-2xl font-bold text-gk-text">Syne heading, 2xl bold</p>
          <p className="font-syne text-lg font-semibold text-gk-text">Syne subheading, lg semibold</p>
          <p className="font-sora text-base text-gk-text">Sora body, base regular. Sample paragraph text for reading length and line height.</p>
          <p className="font-sora text-sm text-gk-muted">Sora meta/muted, sm regular. Sample helper or timestamp text.</p>
          <p className="font-sora text-xs font-medium text-gk-muted">Sora label, xs medium</p>
        </div>
      </Section>

      <Section title="Buttons" description="All variants, all sizes, and a disabled state for each variant.">
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="default">Primary pill</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="outline">Outline</Button>
          <Button variant="destructive">Destructive</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="link">Link</Button>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="default" disabled>
            Primary pill
          </Button>
          <Button variant="secondary" disabled>
            Secondary
          </Button>
          <Button variant="outline" disabled>
            Outline
          </Button>
          <Button variant="destructive" disabled>
            Destructive
          </Button>
          <Button variant="ghost" disabled>
            Ghost
          </Button>
          <Button variant="link" disabled>
            Link
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button size="sm">Small</Button>
          <Button size="default">Default</Button>
          <Button size="lg">Large</Button>
          <Button size="icon" aria-label="Sample icon button">
            <span aria-hidden="true">+</span>
          </Button>
        </div>
      </Section>

      <Section title="Inputs" description="Sample values only, not real form data.">
        <div className="grid max-w-md grid-cols-1 gap-3">
          <Input placeholder="Sample text input" />
          <Input placeholder="Sample disabled input" disabled />
          <Input placeholder="Sample invalid input" aria-invalid="true" defaultValue="not-an-email" />
          <Textarea placeholder="Sample textarea for a longer message" />
          <Select>
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Sample select" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="rock">Rock (sample)</SelectItem>
              <SelectItem value="jazz">Jazz (sample)</SelectItem>
              <SelectItem value="acoustic">Acoustic (sample)</SelectItem>
            </SelectContent>
          </Select>
          <div className="flex items-center gap-3">
            <Switch id="design-sample-switch" defaultChecked />
            <label htmlFor="design-sample-switch" className="font-sora text-sm text-gk-text">
              Sample switch (on)
            </label>
          </div>
          <div className="flex items-center gap-3">
            <Switch id="design-sample-switch-off" />
            <label htmlFor="design-sample-switch-off" className="font-sora text-sm text-gk-text">
              Sample switch (off)
            </label>
          </div>
        </div>
      </Section>

      <Section title="Badges" description="Always 6px radius, always carrying real state.">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="default">Open for applications</Badge>
          <Badge variant="secondary">Weekly</Badge>
          <Badge variant="outline">Draft</Badge>
          <Badge variant="destructive">Cancelled</Badge>
          <Badge variant="success">Confirmed</Badge>
          <Badge variant="warning">Pending</Badge>
        </div>
      </Section>

      <Section title="Skeletons" description="Content-shaped loading placeholders, not spinners.">
        <div className="flex max-w-md flex-col gap-4 rounded-gk border border-gk-border bg-gk-surface p-4">
          <div className="flex items-center gap-3">
            <Skeleton className="size-10 rounded-full" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-3 w-2/3" />
              <Skeleton className="h-3 w-1/3" />
            </div>
          </div>
          <Skeleton className="h-32 w-full" />
        </div>
      </Section>

      <Section title="Card">
        <Card className="max-w-md">
          <CardHeader>
            <CardTitle>Sample gig title</CardTitle>
            <CardDescription>Sample venue, sample neighborhood</CardDescription>
          </CardHeader>
          <CardContent>
            <p className="font-sora text-sm text-gk-text">Sample card body copy for layout reference only.</p>
          </CardContent>
          <CardFooter>
            <Button size="sm">Sample action</Button>
          </CardFooter>
        </Card>
      </Section>

      <Section title="Tabs">
        <Tabs defaultValue="one" className="max-w-md">
          <TabsList>
            <TabsTrigger value="one">Sample tab one</TabsTrigger>
            <TabsTrigger value="two">Sample tab two</TabsTrigger>
            <TabsTrigger value="three">Sample tab three</TabsTrigger>
          </TabsList>
          <TabsContent value="one" className="font-sora text-sm text-gk-text">
            Sample content for tab one.
          </TabsContent>
          <TabsContent value="two" className="font-sora text-sm text-gk-text">
            Sample content for tab two.
          </TabsContent>
          <TabsContent value="three" className="font-sora text-sm text-gk-text">
            Sample content for tab three.
          </TabsContent>
        </Tabs>
      </Section>

      <Section title="Overlays" description="Tooltip, dropdown menu, dialog, and sheet: the four surfaces DESIGN.md allows a shadow on.">
        <div className="flex flex-wrap items-center gap-3">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="outline">Hover for tooltip</Button>
            </TooltipTrigger>
            <TooltipContent>Sample tooltip content</TooltipContent>
          </Tooltip>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline">Open dropdown</Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuLabel>Sample actions</DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem>Sample edit</DropdownMenuItem>
              <DropdownMenuItem variant="destructive">Sample delete</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <Dialog>
            <DialogTrigger asChild>
              <Button variant="default">Open dialog</Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Sample dialog title</DialogTitle>
                <DialogDescription>Sample dialog description for layout reference only.</DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <DialogClose asChild>
                  <Button variant="secondary">Cancel</Button>
                </DialogClose>
                <Button variant="default">Confirm</Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>

          <Sheet>
            <SheetTrigger asChild>
              <Button variant="outline">Open sheet</Button>
            </SheetTrigger>
            <SheetContent>
              <SheetHeader>
                <SheetTitle>Sample sheet title</SheetTitle>
                <SheetDescription>Sample sheet description for layout reference only.</SheetDescription>
              </SheetHeader>
              <SheetFooter>
                <Button variant="default">Sample action</Button>
              </SheetFooter>
            </SheetContent>
          </Sheet>
        </div>
      </Section>

      <IconWeightSample />
    </main>
  );
}
