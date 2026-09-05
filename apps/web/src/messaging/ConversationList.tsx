"use client";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { ErrorBox } from "../ui/ErrorBox";
import { Skeleton } from "../ui/skeleton";
import { cn } from "../lib/utils";
import { useConversations, useOtherProfiles, unreadFor } from "./useConversations";

// Task 6 (spec 3.1). A <button type="button"> per row, not a link: the page
// owns selection through the ?c= query string (app/dashboard/messages/
// page.tsx), and a button lets a keyboard user move between rows without a
// navigation. Rows live inside a <ul> so the list reads as one, per
// antislop-ui's list-semantics rule.
export function ConversationList({ profileId, selectedId, onSelect }: {
  profileId: string | null;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const { rows, retry } = useConversations(profileId);
  const others = useOtherProfiles(rows, profileId);

  if (rows === "loading") {
    return (
      <ul className="grid gap-2" role="status" aria-label="Loading conversations">
        {[0, 1, 2].map((i) => <li key={i}><Skeleton className="h-[4.5rem] w-full" /></li>)}
      </ul>
    );
  }

  if (rows === "error") {
    return (
      <div className="grid gap-2">
        <ErrorBox message="Couldn't load your conversations." />
        <Button type="button" variant="secondary" onClick={retry} className="w-fit">Retry</Button>
      </div>
    );
  }

  if (rows.length === 0) {
    return <p className="font-sora text-sm text-gk-muted">No conversations yet. Message a venue or an artist from their page.</p>;
  }

  return (
    <ul className="grid gap-1">
      {rows.map((row) => {
        // Resolved info falls back to the mirror row's own denormalized
        // name/type while the one-shot getDoc in useOtherProfiles is still
        // in flight, rather than a blank row for a moment: both fields
        // already sit on ConversationRefDoc (written by the messaging
        // callables), useOtherProfiles just re-reads the live profile doc
        // (and its handle, which the mirror doesn't carry) once resolved.
        const other = others.get(row.otherProfileId);
        const name = other?.name ?? row.otherProfileName;
        const type = other?.type ?? row.otherProfileType;
        const unread = unreadFor(row);
        const selected = row.id === selectedId;
        return (
          <li key={row.id}>
            <button
              type="button"
              onClick={() => onSelect(row.id)}
              aria-current={selected ? "true" : undefined}
              className={cn(
                "flex w-full flex-col gap-0.5 rounded-gk px-3.5 py-2.5 text-left transition-colors",
                // bg-gk-border/25, never an ember border (DESIGN.md: ember
                // never on borders), matches the same neutral-wash selected/
                // hover treatment BookingInbox's SolidRow already uses.
                selected ? "bg-gk-border/25" : "hover:bg-gk-border/15",
              )}
            >
              <div className="flex items-center justify-between gap-3">
                <span className="truncate font-syne text-sm font-semibold text-gk-text">{name}</span>
                {unread > 0 && (
                  <span className="flex shrink-0 items-center gap-1">
                    <Badge>{unread}</Badge>
                    {/* The count is never conveyed by the badge's color/shape
                        alone (the same rule Task 19 applies to the
                        notification dot). */}
                    <span className="sr-only">{unread} unread</span>
                  </span>
                )}
              </div>
              <span className="font-sora text-xs text-gk-muted">{type === "curator" ? "Curator" : "Musician"}</span>
              {row.lastMessage?.text && (
                <span className="truncate font-sora text-sm text-gk-muted">{row.lastMessage.text}</span>
              )}
              <span className="text-xs text-gk-muted">{new Date(row.lastMessageAt).toLocaleString()}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
