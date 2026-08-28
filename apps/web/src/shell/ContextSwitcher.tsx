"use client";
import Link from "next/link";
import { useAuth } from "../auth/AuthProvider";
import { profileHref, profileStatusLabel, type ProfileSummary } from "./useMyProfiles";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { ThemeToggle } from "./ThemeToggle";
import { IconCaretDown, IconUser } from "../ui/icons";

// The account/context switcher, right side of AppShell. This is a restyle of
// the existing "Your profiles" list (app/dashboard/page.tsx's ProfilesList) as
// global chrome, not a new switcher: same profiles query (useMyProfiles), same
// destinations (profileHref), same "+ Join" entry point the empty state already
// points to. It reads no new state and writes none of its own; sign-out calls
// the same signOutUser() every page already had.
export function ContextSwitcher({ activeLabel, profiles }: { activeLabel: string; profiles: ProfileSummary[] }) {
  const { user, signOutUser } = useAuth();

  if (!user) {
    return (
      <Link
        href="/sign-in"
        className="inline-flex h-10 items-center rounded-gk border border-gk-border bg-gk-surface px-3 font-sora text-sm font-medium text-gk-text hover:bg-gk-border/20"
      >
        Sign in
      </Link>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="inline-flex h-10 items-center gap-1.5 rounded-gk border border-gk-border bg-gk-surface px-3 font-sora text-sm font-medium text-gk-text outline-none hover:bg-gk-border/20 focus-visible:ring-2 focus-visible:ring-gk-focus"
        >
          <IconUser size={16} className="text-gk-muted" aria-hidden="true" />
          <span className="hidden max-w-[9rem] truncate sm:inline">{activeLabel}</span>
          <IconCaretDown size={14} className="text-gk-muted" aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel className="truncate">{user.email}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {profiles.length === 0 && (
          <DropdownMenuItem asChild>
            <Link href="/dashboard">Dashboard</Link>
          </DropdownMenuItem>
        )}
        {profiles.map((p) => {
          const statusLabel = profileStatusLabel(p);
          return (
            <DropdownMenuItem asChild key={p.profileId}>
              <Link href={profileHref(p)}>
                {p.name} <span className="text-gk-muted">({p.type}{statusLabel ? `, ${statusLabel}` : ""})</span>
              </Link>
            </DropdownMenuItem>
          );
        })}
        <DropdownMenuItem asChild>
          <Link href="/join">+ Join as musician or curator</Link>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <ThemeToggle />
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void signOutUser()}>Sign out</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
