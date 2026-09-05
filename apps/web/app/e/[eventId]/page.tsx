import { cache } from "react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { doc, getDoc, getDocs, collection, query, orderBy } from "firebase/firestore";
import { getServerFirebase } from "../../../src/lib/firebase-server";
import {
  isValidDocId, type EventDoc, type EventAct, type TicketTierDoc, type ProfileDoc, type TaggedActStatus,
} from "@gatekeep/shared";
import { posterPublicUrl } from "../../../src/events/posterUrl";
import { EventPageClient, type EventPageLineupEntry, type EventPageTier } from "./EventPageClient";
import { getSiteUrl } from "../../../src/seo/siteUrl";
import { eventJsonLd, serializeJsonLd } from "../../../src/seo/jsonLd";

// Sub-project 6 task 9: the public event page's server half. Mirrors
// app/u/[handle]/page.tsx's own loadProfile shape exactly (cache()'d loader,
// anonymous public-rules-only reads, permission-denied/not-found both mean
// "not found" from the public's point of view, anything else is a real
// 500): see that file's comment on why permission-denied can never be
// trusted-but-verify'd into a 500 here (it's the ordinary shape of a
// draft/cancelled event, not a bug).
export const revalidate = 60;
export function generateStaticParams() {
  return [];
}

type LoadedEvent = {
  eventId: string; event: EventDoc; posterUrl: string | null;
  curatorName: string; curatorHandle: string | null;
  lineup: EventPageLineupEntry[]; tiers: EventPageTier[];
  // SP11 (spec 3.5): the tagged acts as a plain summary, derived from
  // event.lineup here so EventPageClient can mount ArtistTagBanner without
  // re-reading the event doc client-side (this page's own doc read is
  // anonymous and rules-governed; the banner's per-act membership reads are
  // a separate, signed-in-only concern that belongs client-side).
  tagged: Array<{ musicianProfileId: string; name: string; status: TaggedActStatus }>;
  // The instant this load ran, threaded down to BuyTicketsFlow's
  // useLiveNow. Computed HERE, inside a plain (non-component) function,
  // rather than as a bare `Date.now()` call in the EventPage component body
  // below: eslint-config-next's React Compiler purity rule forbids the
  // latter (it flags any impure call textually inside a function it treats
  // as a component's render, page.tsx's default export included, server
  // component or not), and this loader is the one place both callers below
  // (EventPage and, incidentally, generateMetadata) can share a single
  // canonical value anyway, cache()'d together with the rest of this load.
  now: number;
};

// Batched lineup-handle lookup, one Promise.all over the UNIQUE booking
// musicianProfileIds (n+1-avoidance, same idiom app/u/[handle]/page.tsx's
// own resolveProfileLabels uses for its Shows section). Only the handle is
// resolved here, not a fresh name: a "booking" lineup act already carries
// its own name snapshot (EventAct's own shape), captured at lineup-build
// time by events.ts, so re-resolving it would risk silently diverging from
// what the curator actually put in the lineup, not add accuracy.
async function resolveLineup(
  db: ReturnType<typeof getServerFirebase>["db"], lineup: EventAct[],
): Promise<EventPageLineupEntry[]> {
  // SP11: an ACCEPTED tagged act is public exactly like a booking act (spec
  // 3.5's "accepted acts link to the artist page exactly like booking
  // acts"); a pending or declined one gets no handle lookup and renders as
  // a plain name (resolveLineup's own return below).
  const linkableIds = [...new Set(lineup.flatMap((a) =>
    a.kind === "booking" || (a.kind === "tagged" && a.status === "accepted") ? [a.musicianProfileId] : []))];
  const handles = new Map<string, string | null>();
  await Promise.all(linkableIds.map(async (id) => {
    try {
      const snap = await getDoc(doc(db, "profiles", id));
      handles.set(id, snap.exists() ? ((snap.data() as ProfileDoc).handle ?? null) : null);
    } catch (e) {
      // Duck-typed per loadProfile's own comment: a stranger's profile that
      // went unapproved/private since the lineup was built reads as
      // permission-denied, a legitimate (if unusual) state, not a bug worth
      // logging loudly.
      const code = typeof (e as { code?: unknown }).code === "string" ? (e as { code: string }).code : undefined;
      if (code !== "permission-denied" && code !== "not-found") console.warn("resolveLineup: lookup failed", id, e);
      handles.set(id, null);
    }
  }));
  return lineup.map((act) => {
    const linkable = act.kind === "booking" || (act.kind === "tagged" && act.status === "accepted");
    return linkable
      ? { name: act.name, handle: handles.get(act.musicianProfileId) ?? null, profileId: act.musicianProfileId }
      : { name: act.name, handle: null, profileId: null };
  });
}

export const loadEvent = cache(async (eventId: string): Promise<LoadedEvent | null> => {
  // Same "reject before it ever reaches doc()" discipline as loadProfile's
  // own validateHandle guard: Firestore's doc() throws on a malformed
  // segment (e.g. one containing "/"), which would otherwise surface as an
  // uncaught 500 instead of a normal not-found, and (since throws bypass
  // the `return null` path below) never get cached by ISR either.
  if (!isValidDocId(eventId)) return null;
  try {
    const { db } = getServerFirebase();
    const eventSnap = await getDoc(doc(db, "events", eventId)); // rules deny unless published/completed (or member/admin)
    if (!eventSnap.exists()) return null;
    const event = eventSnap.data() as EventDoc;

    const [curatorSnap, tiersSnap, lineup] = await Promise.all([
      getDoc(doc(db, "profiles", event.curatorProfileId)),
      getDocs(query(collection(db, `events/${eventId}/tiers`), orderBy("sortOrder"))),
      resolveLineup(db, event.lineup),
    ]);
    // Built, not fetched (posterUrl.ts's own header): the OG image and the
    // poster block both read this string, and no Storage call runs per render.
    const posterUrl = posterPublicUrl(event.posterPath);
    const curator = curatorSnap.exists() ? (curatorSnap.data() as ProfileDoc) : null;
    const tiers: EventPageTier[] = tiersSnap.docs.map((d) => {
      const t = d.data() as TicketTierDoc;
      return {
        id: d.id, name: t.name, priceCents: t.priceCents, capacity: t.capacity, soldCount: t.soldCount,
        saleStartsAt: t.saleStartsAt, saleEndsAt: t.saleEndsAt,
      };
    });

    const tagged = event.lineup.flatMap((a) =>
      a.kind === "tagged" ? [{ musicianProfileId: a.musicianProfileId, name: a.name, status: a.status }] : []);

    return {
      eventId, event, posterUrl,
      curatorName: curator?.name ?? "Unknown", curatorHandle: curator?.handle ?? null,
      lineup, tagged, tiers, now: Date.now(),
    };
  } catch (e) {
    // permission-denied = the event isn't published/completed and this
    // reader isn't a member/admin (this page's own read is always
    // anonymous, see getServerFirebase()'s header comment): a legitimate
    // "not found" from the public's point of view, exactly as loadProfile's
    // own comment reasons through for a profile. not-found only fires if
    // the doc vanishes between reads. Anything else is a real failure.
    const code = typeof (e as { code?: unknown }).code === "string" ? (e as { code: string }).code : undefined;
    if (code === "permission-denied" || code === "not-found") return null;
    console.error("event load failed", eventId, e);
    throw e;
  }
});

export async function generateMetadata(props: PageProps<"/e/[eventId]">): Promise<Metadata> {
  const { eventId } = await props.params;
  const data = await loadEvent(eventId);
  if (!data) return { robots: { index: false } };
  const { event, posterUrl } = data;
  const description = event.description.slice(0, 160) || `${event.title} on GateKeep`;
  return {
    title: `${event.title} · GateKeep`,
    description,
    alternates: { canonical: `/e/${eventId}` },
    openGraph: {
      title: event.title, description, url: `/e/${eventId}`, type: "website",
      ...(posterUrl ? { images: [posterUrl] } : {}),
    },
  };
}

export default async function EventPage(props: PageProps<"/e/[eventId]">) {
  const { eventId } = await props.params;
  const data = await loadEvent(eventId);
  if (!data) notFound();
  const siteUrl = getSiteUrl();
  const url = siteUrl ? `${siteUrl}/e/${eventId}` : `/e/${eventId}`;
  const ld = eventJsonLd(
    data.event, eventId, url, data.tiers, data.posterUrl, data.lineup.map((l) => l.name),
  );
  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: serializeJsonLd(ld) }} />
      <EventPageClient {...data} />
    </>
  );
}
