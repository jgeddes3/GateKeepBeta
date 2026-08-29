import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { loadAllPastMusicianShows, loadProfile } from "../page";
import { PastShowsList } from "./PastShowsList";

// Sub-project 9A task 9, spec section 6.5: the new past-shows page, linked
// from the artist page's Shows box "All past shows" link. Same ISR shape as
// the parent page (page.tsx's own comment explains the revalidate window):
// this route does its own SSR Firestore reads (loadProfile, then the past-
// shows loader below), so the same repeat-hit-bounding rationale applies.
export const revalidate = 60;
export function generateStaticParams() {
  return [];
}

export async function generateMetadata(props: { params: Promise<{ handle: string }> }): Promise<Metadata> {
  const { handle } = await props.params;
  const data = await loadProfile(handle);
  if (!data || data.kind !== "musician") return { robots: { index: false } };
  return {
    title: `Past shows: ${data.profile.name} (@${data.profile.handle}) · GateKeep`,
    alternates: { canonical: `/@${data.profile.handle}/shows` },
    robots: { index: false }, // a listing page, not the canonical profile URL search should land on
  };
}

// Viewer-aware per spec 6.5: this Server Component loads only the PUBLIC
// base list (the same query pattern loadProfile/loadMusicianShows already
// runs), permission-blind by construction (no viewer identity is available
// server-side here, same as the rest of this SSR route). PastShowsList (a
// client component) is what layers the curator-readable reliability
// summary and the member-readable per-show stats on top, since only the
// client knows who's signed in.
export default async function PastShowsPage(props: { params: Promise<{ handle: string }> }) {
  const { handle } = await props.params;
  const data = await loadProfile(handle);
  if (!data || data.kind !== "musician") notFound();
  const shows = await loadAllPastMusicianShows(data.profileId);
  return <PastShowsList profileId={data.profileId} handle={data.profile.handle} name={data.profile.name} shows={shows} />;
}
