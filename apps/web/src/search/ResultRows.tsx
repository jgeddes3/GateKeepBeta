import type { ComponentType } from "react";
import Link from "next/link";
import { SEARCH_EMPTY_MESSAGE, distanceLabel, type ActSize, type SearchResult } from "@gatekeep/shared";
import { formatCents } from "../events/eventDisplay";
import { formatChipLabel } from "../portfolio/PortfolioForms";
import { DateBlockRow } from "../components/DateBlockRow";
import { Button } from "../ui/button";
import { Skeleton } from "../ui/skeleton";
import { IconSearch, IconWarning } from "../ui/icons";
import type { UseSearchState } from "./useSearch";

const ACT_SIZE_LABEL: Record<ActSize, string> = { solo: "Solo", duo: "Duo", band: "Band" };

function joinDetail(parts: (string | null)[]): string | undefined {
  const filtered = parts.filter((p): p is string => !!p);
  return filtered.length > 0 ? filtered.join(" · ") : undefined;
}

function distancePart(r: SearchResult): string | null {
  return r.distanceMeters != null ? distanceLabel(r.distanceMeters) : null;
}

export function ShowRow({ r }: { r: SearchResult }) {
  const price = r.hasFreeTier ? "Free" : r.priceFromCents != null ? `from ${formatCents(r.priceFromCents)}` : null;
  return (
    <DateBlockRow
      dateMs={r.startsAt!}
      title={r.title}
      subtitle={[r.subtitle, r.neighborhood].filter(Boolean).join(" · ")}
      href={`/e/${r.id}`}
      detail={joinDetail([price, distancePart(r)])}
    />
  );
}

export function GigRow({ r }: { r: SearchResult }) {
  const budget = r.budgetMinCents != null && r.budgetMaxCents != null
    ? `${formatCents(r.budgetMinCents)} to ${formatCents(r.budgetMaxCents)}`
    : null;
  return (
    <DateBlockRow
      dateMs={r.startsAt!}
      title={r.title}
      subtitle={[r.subtitle, r.neighborhood].filter(Boolean).join(" · ")}
      href={`/gigs/${r.id}`}
      detail={joinDetail([budget, distancePart(r)])}
    />
  );
}

// The venue row: no date block (a venue isn't a scheduled thing), so this
// builds its own DateBlockRow-shaped link rather than reusing that
// component. Curator search reuses SearchResult's own "artist" kind too,
// but renders CuratorArtistRow instead of this one (controller ruling 2):
// that row needs a per-card private/curatorBooking read and an "Offer a
// gig" action this plain row has no business doing.
export function ProfileRow({ r }: { r: SearchResult }) {
  const subtitle = r.kind === "venue" ? (r.city ?? "") : r.genres.map(formatChipLabel).join(", ");
  const meta = joinDetail([
    r.hasAudio ? "Has audio" : null,
    r.actSize ? ACT_SIZE_LABEL[r.actSize] : null,
    r.followerCount > 0 ? `${r.followerCount} follower${r.followerCount === 1 ? "" : "s"}` : null,
    distancePart(r),
  ]);
  return (
    <Link
      href={`/u/${r.handle}`}
      className="flex w-full items-center gap-3 rounded-gk-sm px-2 py-2 text-left outline-none transition-colors hover:bg-gk-border/25 focus-visible:ring-2 focus-visible:ring-gk-focus"
    >
      <div className="min-w-0 flex-1">
        <p className="truncate font-syne text-sm font-semibold text-gk-text">{r.title}</p>
        {subtitle && <p className="truncate font-sora text-xs text-gk-muted">{subtitle}</p>}
        {meta && <p className="truncate font-sora text-xs text-gk-muted">{meta}</p>}
      </div>
    </Link>
  );
}

function ResultRowSkeleton() {
  return (
    <div className="flex items-center gap-3 px-2 py-2">
      <Skeleton className="h-[46px] w-[46px] shrink-0 rounded-gk-sm" />
      <div className="grid min-w-0 flex-1 gap-1.5">
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-3 w-1/2" />
      </div>
    </div>
  );
}

// One shared list shell for every face: a loading skeleton (only on the
// FIRST page, so paging in more results never flashes the list back to a
// skeleton), an error line (budgetHit's SEARCH_LIMIT_MESSAGE flows through
// state.error the same as any other search failure, no separate branch
// needed here), the empty state, the rows themselves via the caller's own
// row component, and a "Show more" button while state.hasMore.
export function ResultList({ state, row: Row }: { state: UseSearchState; row: ComponentType<{ r: SearchResult }> }) {
  return (
    <div className="grid gap-4">
      {state.error && (
        <p
          role="alert"
          className="flex items-start gap-2 rounded-gk border border-gk-warning/40 bg-gk-warning/14 px-3.5 py-2.5 font-sora text-sm text-gk-warning"
        >
          <IconWarning size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
          {state.error}
        </p>
      )}

      {state.loading && state.items.length === 0 && (
        <div role="status" aria-label="Loading results" className="grid gap-1">
          {[0, 1, 2].map((i) => <ResultRowSkeleton key={i} />)}
        </div>
      )}

      {!state.loading && state.items.length === 0 && !state.error && (
        <div className="rounded-gk border border-gk-border bg-gk-surface px-6 py-10 text-center">
          <span className="mx-auto flex size-10 items-center justify-center rounded-full bg-gk-border/50 text-gk-muted">
            <IconSearch size={20} aria-hidden="true" />
          </span>
          <p className="mt-3 font-syne text-base font-semibold text-gk-text">{SEARCH_EMPTY_MESSAGE}</p>
        </div>
      )}

      {state.items.length > 0 && (
        <div>
          {state.items.map((r) => <Row key={r.id} r={r} />)}
        </div>
      )}

      {state.hasMore && (
        <Button type="button" variant="secondary" disabled={state.loading} onClick={state.loadMore} className="justify-self-center">
          Show more
        </Button>
      )}
    </div>
  );
}
