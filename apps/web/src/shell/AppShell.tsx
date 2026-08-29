"use client";
import { useState, type ComponentType, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/src/lib/utils";
import { useAuth } from "../auth/AuthProvider";
import { useMyProfiles, type ProfileSummary } from "./useMyProfiles";
import { ContextSwitcher } from "./ContextSwitcher";
import { Footer } from "./Footer";
import {
  Sheet, SheetClose, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger,
} from "../ui/sheet";
import { IconBookings, IconEarnings, IconGigs, IconHouse, IconMenu, type IconProps } from "../ui/icons";

// Routes that get the signed-in shell (slim top bar + footer). An allowlist
// of prefixes rather than a blocklist: everything under these is the
// authenticated app (spec section 3's "one shell for all signed-in pages").
// The landing page (app/page.tsx, its own variant lands in Task 4) and
// /sign-in (Task 5 restyles it; it stands alone today) are deliberately left
// out; see the task 3 report for the full mount-point rationale. /gigs and
// /u/[handle] are public browse/profile pages with their own future-task
// anatomies (spec section 6.3/6.4) and are also left bare for now.
const SHELL_PREFIXES = ["/dashboard", "/admin", "/join"];

function isShellRoute(pathname: string): boolean {
  return SHELL_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

type NavContext =
  | { kind: "generic" }
  | { kind: "musician"; profileId: string }
  | { kind: "curator"; profileId: string };

type NavItem = { label: string; href: string; icon: ComponentType<IconProps> };

function firstPathSegment(pathname: string, prefix: string): string | null {
  if (!pathname.startsWith(prefix)) return null;
  return pathname.slice(prefix.length).split("/")[0] || null;
}

// Derives the active identity from the current route first (so a musician's
// or curator's own pages show that profile's nav), then falls back to the
// account's one unambiguous profile of a given type when the route itself
// isn't profile-scoped (e.g. /dashboard, /dashboard/earnings). An account
// with two-plus profiles of the same type has no single unambiguous fallback
// and gets the generic nav there: its profiles are still one click away in
// the switcher, which always lists every one of them individually.
function resolveContext(pathname: string, profiles: ProfileSummary[]): NavContext {
  const portfolioId = firstPathSegment(pathname, "/dashboard/portfolio/");
  if (portfolioId && profiles.some((p) => p.profileId === portfolioId && p.type === "musician")) {
    return { kind: "musician", profileId: portfolioId };
  }
  const curatorId = firstPathSegment(pathname, "/dashboard/curator/");
  if (curatorId && profiles.some((p) => p.profileId === curatorId && p.type === "curator")) {
    return { kind: "curator", profileId: curatorId };
  }
  const musicians = profiles.filter((p) => p.type === "musician");
  if (musicians.length === 1) return { kind: "musician", profileId: musicians[0].profileId };
  const curators = profiles.filter((p) => p.type === "curator");
  if (curators.length === 1) return { kind: "curator", profileId: curators[0].profileId };
  return { kind: "generic" };
}

// Every href below is a route that exists today (no new destinations): the
// browse-gigs page, the profile's own editor page (where its BookingInbox
// section already lives), and the earnings page. "Messages" isn't included
// anywhere: there's no messaging surface on web (or mobile, where its own
// Messages tab is still a "coming in a later phase" placeholder), so no
// context has a real destination for it.
function navItemsFor(context: NavContext): NavItem[] {
  const dashboard: NavItem = { label: "Dashboard", href: "/dashboard", icon: IconHouse };
  if (context.kind === "musician") {
    return [
      dashboard,
      { label: "Gigs", href: "/gigs", icon: IconGigs },
      { label: "Bookings", href: `/dashboard/portfolio/${context.profileId}`, icon: IconBookings },
      { label: "Earnings", href: "/dashboard/earnings", icon: IconEarnings },
    ];
  }
  if (context.kind === "curator") {
    return [
      dashboard,
      { label: "Gigs", href: `/dashboard/curator/${context.profileId}/gigs`, icon: IconGigs },
      { label: "Bookings", href: `/dashboard/curator/${context.profileId}`, icon: IconBookings },
    ];
  }
  return [dashboard, { label: "Gigs", href: "/gigs", icon: IconGigs }];
}

// Which single nav item, if any, is "active" for the current route. A
// curator's Bookings href (/dashboard/curator/{id}) is a literal path
// prefix of its own Gigs href (/dashboard/curator/{id}/gigs) and every
// other sub-route under that profile (gigs/new, gigs/[gigId], musicians,
// series/[id]): a naive "does href prefix-match pathname" per item made
// BOTH Bookings and Gigs render active at once on the curator's gigs list.
// Fixed by picking exactly one winner across the whole nav array: the
// longest (most specific) href that matches, exact match or true path-
// segment prefix (`${href}/`, so `/dashboard/curator/abc` never matches
// `/dashboard/curator/abcdef` by bare string prefix). Longest-match also
// makes the old "/dashboard is a prefix of everything" special case
// unnecessary: Dashboard's short href only wins when nothing more specific
// in the array also matches.
function activeHref(pathname: string, items: NavItem[]): string | null {
  let winner: string | null = null;
  for (const item of items) {
    const matches = pathname === item.href || pathname.startsWith(`${item.href}/`);
    if (matches && (!winner || item.href.length > winner.length)) winner = item.href;
  }
  return winner;
}

function activeLabel(context: NavContext, profiles: ProfileSummary[], email: string | null | undefined): string {
  if (context.kind !== "generic") {
    const profile = profiles.find((p) => p.profileId === context.profileId);
    if (profile) return `${profile.name} (${profile.type})`;
  }
  return email ?? "Account";
}

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { user } = useAuth();
  const profiles = useMyProfiles(user?.uid ?? null);
  const [mobileOpen, setMobileOpen] = useState(false);

  if (!isShellRoute(pathname)) return <>{children}</>;

  const context = resolveContext(pathname, profiles);
  const navItems = navItemsFor(context);
  const label = activeLabel(context, profiles, user?.email);
  const active = activeHref(pathname, navItems);

  return (
    <>
      {/* bg-gk-bg-0 (a flat token, not a second gradient: see the
          harsh-gradient rule in DESIGN.md) keeps this legible while sticky:
          without an opaque background, page content scrolling underneath a
          transparent sticky bar shows through it. Dark theme's gk-bg-0 is
          the gradient's own top stop, so the bar reads as part of the page;
          light theme's gk-bg-0 equals the flat page color exactly. */}
      <header className="sticky top-0 z-40 border-b border-gk-border bg-gk-bg-0">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between gap-4 px-4 sm:px-6">
          <div className="flex min-w-0 items-center gap-8">
            {/* text-gk-focus, not text-gk-accent: DESIGN.md's own
                accessibility note measures bare ember text at ~2.6-2.8:1 on
                a light-theme surface (this header's bg-gk-bg-0 in light
                theme), under AA at every size, with no chip-treatment
                exception carved out for a wordmark the way it carves one
                out for "active nav item" or "price". --gk-focus already
                resolves to ember itself in dark theme (pixel-identical to
                the mock) and to the same-hue, AA-safe #BF5038 in light
                theme, DESIGN.md's own fix for this exact bare-ember-text
                problem elsewhere, reused here rather than inventing a new
                token for what is the same underlying color decision.
                text-xl (20px), not text-lg (18px): --gk-focus vs --gk-page
                measures 4.45:1, short of the 4.5:1 normal-text AA minimum
                by a hair, but comfortably clears the 3:1 large-text minimum
                (18.66px+ bold). font-extrabold (800) already qualifies as
                bold; bumping the size is the cheaper fix over re-deriving
                the color again. Documented in DESIGN.md. */}
            <Link href="/dashboard" className="shrink-0 font-syne text-xl font-extrabold text-gk-focus">
              GateKeep
            </Link>
            <nav aria-label="Primary" className="hidden items-center gap-1 md:flex">
              {navItems.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className={cn(
                    "rounded-full px-3 py-1 font-sora text-sm font-medium transition-colors",
                    // Bare ember text fails WCAG AA on a light-theme surface
                    // (~2.6-2.8:1 per DESIGN.md's accessibility note), which
                    // names "active nav item" as one of its own examples and
                    // prescribes exactly this fix: a filled ember chip with
                    // --gk-on-accent text, not colored text on its own. The
                    // pill radius matches DESIGN.md's tier table, which
                    // reserves 999px for "primary CTAs and chips".
                    item.href === active
                      ? "bg-gk-accent font-semibold text-gk-on-accent"
                      : "text-gk-muted hover:text-gk-text",
                  )}
                >
                  {item.label}
                </Link>
              ))}
            </nav>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <ContextSwitcher activeLabel={label} profiles={profiles} />
            <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
              <SheetTrigger asChild>
                <button
                  type="button"
                  aria-label="Open menu"
                  className="inline-flex h-10 w-10 items-center justify-center rounded-gk-sm text-gk-text outline-none hover:bg-gk-border/30 focus-visible:ring-2 focus-visible:ring-gk-focus md:hidden"
                >
                  <IconMenu size={20} aria-hidden="true" />
                </button>
              </SheetTrigger>
              <SheetContent side="left" className="w-3/4 sm:max-w-xs">
                <SheetHeader>
                  {/* Same text-gk-focus + text-xl/font-extrabold reasoning
                      as the header brand mark above: SheetTitle's own
                      defaults are text-lg/font-semibold, which (like the
                      header's original text-lg) sit a hair under the
                      large-text AA threshold, so both are overridden here
                      too rather than relying on the component default. */}
                  <SheetTitle className="text-xl font-extrabold text-gk-focus">GateKeep</SheetTitle>
                  <SheetDescription className="sr-only">Site navigation</SheetDescription>
                </SheetHeader>
                <nav aria-label="Primary" className="flex flex-col gap-1 px-4 pb-4">
                  {navItems.map((item) => {
                    const Icon = item.icon;
                    return (
                      <SheetClose asChild key={item.href}>
                        <Link
                          href={item.href}
                          className={cn(
                            "flex items-center gap-3 rounded-gk-sm px-3 py-2.5 font-sora text-sm font-medium",
                            // Same filled-chip fix as the desktop nav above,
                            // not the 14% soft tint: that opacity is reserved
                            // for the success/warning/destructive status-tint
                            // family (DESIGN.md "Status tints"), and a tint
                            // this light would still leave bare ember text
                            // under AA on a light surface.
                            item.href === active
                              ? "bg-gk-accent text-gk-on-accent"
                              : "text-gk-muted hover:bg-gk-border/30 hover:text-gk-text",
                          )}
                        >
                          <Icon size={18} aria-hidden="true" />
                          {item.label}
                        </Link>
                      </SheetClose>
                    );
                  })}
                </nav>
              </SheetContent>
            </Sheet>
          </div>
        </div>
      </header>
      <div>{children}</div>
      <Footer />
    </>
  );
}
