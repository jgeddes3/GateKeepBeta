"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { getDocs } from "firebase/firestore";
import { GENRES, type MusicianSubtype, type ProfileDoc } from "@gatekeep/shared";
import { getFirebase } from "../lib/firebase";
import { artistsQuery, type ArtistRow } from "./discoverQueries";
import { usePosterUrl } from "../events/posterUrl";
import { formatChipLabel } from "../portfolio/PortfolioForms";
import { Badge } from "../ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { Skeleton } from "../ui/skeleton";
import { IconUser, IconWarning } from "../ui/icons";
import { FollowButton } from "./FollowButton";

const ACT_SIZE_LABEL: Record<MusicianSubtype, string> = { solo: "Solo", band: "Band" };
const ALL_GENRES = "__all";

// usePosterUrl is named for its original poster call site (posterUrl.ts's
// own header comment) but its body is a generic "storage path -> download
// URL" resolver with nothing poster-specific in it; reused here unchanged
// for a musician's avatar the same way TicketsClient.tsx already reuses it
// for a ticket card's event poster.
function ArtistRowItem({ artist }: { artist: ArtistRow }) {
  const avatarUrl = usePosterUrl(artist.portfolio?.avatarPhotoPath ?? null);
  const genres = (artist.portfolio?.genres ?? []).slice(0, 3);
  return (
    <div className="flex items-center gap-3 rounded-gk-sm px-2 py-2">
      <Link
        href={`/@${artist.handle}`}
        className="flex min-w-0 flex-1 items-center gap-3 rounded-gk-sm outline-none transition-colors hover:bg-gk-border/25 focus-visible:ring-2 focus-visible:ring-gk-focus"
      >
        <span className="flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-full border border-gk-border bg-gk-surface text-gk-muted">
          {avatarUrl
            ? <img src={avatarUrl} alt="" className="h-full w-full object-cover" />
            : <IconUser size={20} aria-hidden="true" />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate font-syne text-sm font-semibold text-gk-text">{artist.name}</span>
          <span className="mt-1 flex flex-wrap items-center gap-1.5">
            <Badge variant="secondary">{ACT_SIZE_LABEL[artist.subtype as MusicianSubtype]}</Badge>
            {genres.map((g) => <Badge key={g} variant="secondary">{formatChipLabel(g)}</Badge>)}
          </span>
        </span>
      </Link>
      <FollowButton targetId={artist.id} targetType="musician" />
    </div>
  );
}

function ArtistRowSkeleton() {
  return (
    <div className="flex items-center gap-3 px-2 py-2">
      <Skeleton className="h-11 w-11 shrink-0 rounded-full" />
      <div className="grid min-w-0 flex-1 gap-1.5">
        <Skeleton className="h-4 w-1/2" />
        <Skeleton className="h-3 w-1/3" />
      </div>
    </div>
  );
}

// The Artists tab: approved musician profiles, filtered by genre.
export function ArtistsList() {
  const [rows, setRows] = useState<ArtistRow[] | "loading">("loading");
  const [error, setError] = useState<string | null>(null);
  const [genre, setGenre] = useState<string | null>(null);

  // No synchronous "loading"/error reset at the top of the effect (see
  // ShowsList.tsx's identical comment, and GigBrowse.tsx's original): every
  // state transition happens inside getDocs' own callbacks instead, so a
  // genre change keeps showing the previous list until the new one resolves.
  useEffect(() => {
    let cancelled = false;
    const { db } = getFirebase();
    getDocs(artistsQuery(db, { genre }))
      .then((snap) => {
        if (cancelled) return;
        setRows(snap.docs.map((d) => ({ id: d.id, ...(d.data() as ProfileDoc) })));
        setError(null);
      })
      .catch((e) => {
        if (cancelled) return;
        setRows([]);
        setError(e instanceof Error ? e.message : "Could not load artists.");
      });
    return () => { cancelled = true; };
  }, [genre]);

  return (
    <div className="grid gap-4">
      <Select value={genre ?? ALL_GENRES} onValueChange={(v) => setGenre(v === ALL_GENRES ? null : v)}>
        <SelectTrigger size="sm" aria-label="Genre" className="w-fit">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL_GENRES}>All genres</SelectItem>
          {GENRES.map((g) => <SelectItem key={g} value={g}>{formatChipLabel(g)}</SelectItem>)}
        </SelectContent>
      </Select>

      {error && (
        <p
          role="alert"
          className="flex items-start gap-2 rounded-gk border border-gk-warning/40 bg-gk-warning/14 px-3.5 py-2.5 font-sora text-sm text-gk-warning"
        >
          <IconWarning size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
          Could not load artists: {error}
        </p>
      )}

      {rows === "loading" && (
        <div role="status" aria-label="Loading artists" className="grid gap-1">
          {[0, 1, 2].map((i) => <ArtistRowSkeleton key={i} />)}
        </div>
      )}

      {rows !== "loading" && rows.length === 0 && !error && (
        <div className="rounded-gk border border-gk-border bg-gk-surface px-6 py-10 text-center">
          <span className="mx-auto flex size-10 items-center justify-center rounded-full bg-gk-border/50 text-gk-muted">
            <IconUser size={20} aria-hidden="true" />
          </span>
          <p className="mt-3 font-syne text-base font-semibold text-gk-text">No artists match this genre</p>
          <p className="mx-auto mt-1 max-w-sm font-sora text-sm text-gk-muted">
            Clear the genre filter to see every approved act on GateKeep.
          </p>
        </div>
      )}

      {rows !== "loading" && rows.length > 0 && (
        <div>
          {rows.map((artist) => <ArtistRowItem key={artist.id} artist={artist} />)}
        </div>
      )}
    </div>
  );
}
