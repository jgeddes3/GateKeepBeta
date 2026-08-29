"use client";
import { use, useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { doc, onSnapshot, collection, query, where } from "firebase/firestore";
import { getFirebase } from "../../../../../src/lib/firebase";
import { useAuth } from "../../../../../src/auth/AuthProvider";
import {
  GIG_STATUS_LABEL, SERIES_STATUS_LABEL, BUDGET_STRUCTURE_LABEL, WEEKDAY_LABELS, formatGigDateTime, formatCents,
} from "../../../../../src/gigs/GigForms";
import { formatChipLabel } from "../../../../../src/portfolio/PortfolioForms";
import type { ProfileDoc, GigDoc, GigSeriesDoc, SeriesStatus } from "@gatekeep/shared";
import { Button } from "../../../../../src/ui/button";
import { Badge } from "../../../../../src/ui/badge";
import { Skeleton } from "../../../../../src/ui/skeleton";
import { IconGigs } from "../../../../../src/ui/icons";

type GigRow = GigDoc & { id: string };
type SeriesRow = GigSeriesDoc & { id: string };
type BadgeVariant = "secondary" | "outline" | "success" | "warning" | "destructive";

// taken_down is a MODERATION action (admin-issued, Task 12): it must not
// read as just another flavor of the curator's own routine cancellation, so
// it gets its own "warning" tint distinct from cancelled's "destructive"
// red, even though this task's UI has no takedown action of its own (a gig
// can still arrive here already taken_down). Real state only, never
// decorative (DESIGN.md "Badges").
const GIG_STATUS_BADGE: Record<GigDoc["status"], BadgeVariant> = {
  draft: "secondary", open: "success", filled: "outline", closed: "secondary", cancelled: "destructive", taken_down: "warning",
};
const SERIES_STATUS_BADGE: Record<SeriesStatus, BadgeVariant> = { active: "success", paused: "warning", ended: "secondary" };

function GigListItem({ profileId, gig }: { profileId: string; gig: GigRow }) {
  return (
    <li className="rounded-gk border border-gk-border bg-gk-surface px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <Link href={`/dashboard/curator/${profileId}/gigs/${gig.id}`} className="font-syne text-sm font-semibold text-gk-text hover:text-gk-focus">
          {gig.title || "Untitled gig"}
        </Link>
        <Badge variant={GIG_STATUS_BADGE[gig.status]}>{GIG_STATUS_LABEL[gig.status]}</Badge>
      </div>
      <p className="mt-1 font-sora text-sm text-gk-muted">
        {formatGigDateTime(gig.startsAt)}
        {" · "}{formatCents(gig.budget.minCents)}–{formatCents(gig.budget.maxCents)} {BUDGET_STRUCTURE_LABEL[gig.budget.structure]}
        {gig.seriesId && (
          <>
            {" · "}
            <Link href={`/dashboard/curator/${profileId}/series/${gig.seriesId}`} className="underline underline-offset-4 hover:text-gk-text">
              series
            </Link>
            {gig.detachedFromTemplate ? " (detached)" : ""}
          </>
        )}
      </p>
    </li>
  );
}

// Sorted ascending (soonest first) for open/drafts, since "what's coming up"
// is the useful question there, and descending (most recent first) for the
// past group, where "what just happened" matters more.
const byStartsAtAsc = (a: GigRow, b: GigRow) => a.startsAt - b.startsAt;
const byStartsAtDesc = (a: GigRow, b: GigRow) => b.startsAt - a.startsAt;

function ListSection({ title, count, emptyLabel, children }: { title: string; count: number; emptyLabel: string; children: ReactNode }) {
  return (
    <section className="grid gap-3">
      <h2 className="font-syne text-lg font-semibold text-gk-text">{title} ({count})</h2>
      {count === 0
        ? <p className="font-sora text-sm text-gk-muted">{emptyLabel}</p>
        : <ul className="grid gap-2">{children}</ul>}
    </section>
  );
}

export default function GigsList(props: { params: Promise<{ profileId: string }> }) {
  const { profileId } = use(props.params);
  const { user, loading } = useAuth();
  const router = useRouter();
  const [profile, setProfile] = useState<ProfileDoc | null | "loading">("loading");
  const [gigs, setGigs] = useState<GigRow[]>([]);
  const [series, setSeries] = useState<SeriesRow[]>([]);

  useEffect(() => { if (!loading && !user) router.replace("/sign-in"); }, [user, loading, router]);
  useEffect(() => {
    if (!user) return;
    const { db } = getFirebase();
    return onSnapshot(doc(db, "profiles", profileId),
      (s) => setProfile(s.exists() ? (s.data() as ProfileDoc) : null),
      () => setProfile(null));
  }, [user, profileId]);
  // where(curatorProfileId=='X') with NO status filter: rules-provable for
  // a member via the member disjunct alone (see firestore.rules' comment on
  // gigs' read rule + tests-rules/rules.test.ts's "curator dashboard" test),
  // regardless of each doc's actual status, and needs no composite index
  // (single equality field). Every status comes back in one listener; the
  // open/drafts/past grouping below is purely client-side.
  useEffect(() => {
    if (!user) return;
    const { db } = getFirebase();
    return onSnapshot(
      query(collection(db, "gigs"), where("curatorProfileId", "==", profileId)),
      (s) => setGigs(s.docs.map((d) => ({ id: d.id, ...(d.data() as GigDoc) }))));
  }, [user, profileId]);
  // Same shape for gigSeries: its read rule (isMember(curatorProfileId) ||
  // isAdmin(), no public disjunct) is provable the identical way.
  useEffect(() => {
    if (!user) return;
    const { db } = getFirebase();
    return onSnapshot(
      query(collection(db, "gigSeries"), where("curatorProfileId", "==", profileId)),
      (s) => setSeries(s.docs.map((d) => ({ id: d.id, ...(d.data() as GigSeriesDoc) }))));
  }, [user, profileId]);

  if (loading || !user || profile === "loading") {
    return (
      <main className="mx-auto w-full max-w-2xl flex-1 px-4 py-10 sm:px-6 sm:py-14" role="status" aria-label="Loading">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="mt-4 h-9 w-56" />
        <div className="mt-8 grid gap-2">
          {[0, 1, 2].map((i) => <Skeleton key={i} className="h-16 w-full" />)}
        </div>
      </main>
    );
  }
  if (!profile || profile.type !== "curator") {
    return (
      <main className="mx-auto w-full max-w-xl flex-1 px-4 py-16 text-center sm:px-6">
        <p className="font-syne text-lg font-semibold text-gk-text">No curator profile here</p>
        <Button asChild className="mt-4">
          <Link href="/dashboard">Back to dashboard</Link>
        </Button>
      </main>
    );
  }

  const open = gigs.filter((g) => g.status === "open").sort(byStartsAtAsc);
  const drafts = gigs.filter((g) => g.status === "draft").sort(byStartsAtAsc);
  const past = gigs.filter((g) => g.status === "closed" || g.status === "cancelled" || g.status === "taken_down").sort(byStartsAtDesc);

  return (
    <main className="mx-auto w-full max-w-2xl flex-1 px-4 py-10 sm:px-6 sm:py-14">
      <Link href={`/dashboard/curator/${profileId}`} className="font-sora text-sm text-gk-muted hover:text-gk-text">
        &larr; {profile.name}
      </Link>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-syne text-3xl font-extrabold text-gk-text sm:text-4xl">Gigs &amp; series</h1>
        {profile.status === "approved" && (
          <Button asChild>
            <Link href={`/dashboard/curator/${profileId}/gigs/new`}>
              <IconGigs size={16} aria-hidden="true" />
              Post a new gig
            </Link>
          </Button>
        )}
      </div>
      {profile.status !== "approved" && (
        <p className="mt-2 font-sora text-sm text-gk-muted">Your curator profile must be approved before you can post gigs.</p>
      )}

      <div className="mt-8 grid gap-8">
        <ListSection title="Open" count={open.length} emptyLabel="No open gigs.">
          {open.map((g) => <GigListItem key={g.id} profileId={profileId} gig={g} />)}
        </ListSection>

        <ListSection title="Drafts" count={drafts.length} emptyLabel="No drafts.">
          {drafts.map((g) => <GigListItem key={g.id} profileId={profileId} gig={g} />)}
        </ListSection>

        <ListSection title="Past & closed" count={past.length} emptyLabel="Nothing here yet.">
          {past.map((g) => <GigListItem key={g.id} profileId={profileId} gig={g} />)}
        </ListSection>

        <section className="grid gap-3 border-t border-gk-border pt-8">
          <h2 className="font-syne text-lg font-semibold text-gk-text">Series ({series.length})</h2>
          {series.length === 0 ? (
            <p className="font-sora text-sm text-gk-muted">No recurring series yet.</p>
          ) : (
            <ul className="grid gap-2">
              {series.map((s) => (
                <li key={s.id} className="rounded-gk border border-gk-border bg-gk-surface px-4 py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link href={`/dashboard/curator/${profileId}/series/${s.id}`} className="font-syne text-sm font-semibold text-gk-text hover:text-gk-focus">
                      {s.template.title || "Untitled series"}
                    </Link>
                    <Badge variant={SERIES_STATUS_BADGE[s.status]}>{SERIES_STATUS_LABEL[s.status]}</Badge>
                  </div>
                  <p className="mt-1 font-sora text-sm text-gk-muted">
                    {WEEKDAY_LABELS[s.recurrence.weekday]}s, {String(s.recurrence.hour).padStart(2, "0")}:
                    {String(s.recurrence.minute).padStart(2, "0")}, {formatChipLabel(s.recurrence.cadence)}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </main>
  );
}
