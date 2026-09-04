import {
  signUpTestUser, makeAdminUser, seedCuratorGateContent, callFn, makeMoneyReady,
} from "./helpers";
import * as adminApp from "firebase-admin/app";
import { getFirestore as adminFirestore } from "firebase-admin/firestore";
import { StubGeocoder } from "../src/geocode.js";
import { type ProfileDraftInput, type SearchIndexDoc } from "@gatekeep/shared";
import type { User } from "firebase/auth";

process.env.FIRESTORE_EMULATOR_HOST = "localhost:8080";
const admin = adminApp.getApps()[0] ?? adminApp.initializeApp({ projectId: "gatekeep-dev-jg" });
export const adb = adminFirestore(admin);
export const stub = new StubGeocoder();

const SEED_ADDRESS = "123 Main St, Austin, TX"; // matches helpers.ts's seedCuratorGateContent

export async function makeApprovedCuratorProfile(
  emailPrefix: string, subtype: "venue" | "planner" | "individual_host" = "venue",
) {
  const owner = await signUpTestUser(`${emailPrefix}-${Date.now()}@test.com`);
  const { profileId } = await callFn<ProfileDraftInput, { profileId: string }>(
    "createProfileDraft",
    { type: "curator", subtype, name: "The Green Room", handle: `${emailPrefix}_${Date.now()}_${Math.floor(Math.random() * 1e6)}` },
    owner.user);
  await seedCuratorGateContent(adb, profileId);
  await callFn("submitProfileForReview", { profileId }, owner.user);
  const admin = await makeAdminUser(`${emailPrefix}a`);
  await callFn("reviewProfile", { profileId, decision: "approved" }, admin.user);
  return { owner, profileId };
}

export async function makeApprovedMusicianProfile(emailPrefix: string) {
  const owner = await signUpTestUser(`${emailPrefix}-${Date.now()}@test.com`);
  const { profileId } = await callFn<ProfileDraftInput, { profileId: string }>(
    "createProfileDraft",
    { type: "musician", subtype: "solo", name: "The Act", handle: `${emailPrefix}_${Date.now()}_${Math.floor(Math.random() * 1e6)}` },
    owner.user);
  await adb.doc(`profiles/${profileId}`).update({
    "portfolio.bio": "A great live act.",
    "portfolio.genres": ["rock"],
    "portfolio.avatarPhotoPath": "public/photos/seed/avatar-seed.jpg",
  });
  await adb.doc(`profiles/${profileId}/tracks/seed-track`).set({
    title: "Demo", status: "approved", uploaderUid: owner.uid,
    startSec: 0, durationSec: 20, storagePath: "public/tracks/seed/demo.m4a",
    rejectionReason: null, failureReason: null, order: 0,
    createdAt: Date.now(), updatedAt: Date.now(),
  });
  await callFn("submitProfileForReview", { profileId }, owner.user);
  const admin = await makeAdminUser(`${emailPrefix}a`);
  await callFn("reviewProfile", { profileId, decision: "approved" }, admin.user);
  return { owner, profileId };
}

export function gigContent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: "Friday Night Jazz", description: "A cozy weekly set in the back room.",
    wants: { genres: ["rock"], actSizes: ["band"] }, durationMinutes: 90,
    provisions: { hasPA: null, hasBackline: null, notes: null },
    budget: { minCents: 10_000, maxCents: 20_000, structure: "perHour" },
    startsAt: Date.now() + 7 * 24 * 3600 * 1000,
    ...overrides,
  };
}

// The "least ceremony" path to a filled gig, mirroring gigs.test.ts's
// "cancel the booking instead" fixture (createGig, publishGig, applyToGig,
// acceptBooking). This file's subject is events built ON TOP of a filled
// gig, not booking negotiation mechanics, so this stays single-offer-accept
// only, same as that precedent.
export async function makeFilledGig(prefix: string) {
  const curator = await makeApprovedCuratorProfile(`${prefix}c`, "venue");
  const musician = await makeApprovedMusicianProfile(`${prefix}m`);
  await makeMoneyReady(
    { owner: curator.owner, profileId: curator.profileId },
    { owner: musician.owner, profileId: musician.profileId });
  const { gigId } = await callFn<Record<string, unknown>, { gigId: string }>(
    "createGig", { profileId: curator.profileId, ...gigContent() }, curator.owner.user);
  await callFn("publishGig", { gigId }, curator.owner.user);
  const { bookingId } = await callFn<Record<string, unknown>, { bookingId: string }>(
    "applyToGig",
    { gigId, musicianProfileId: musician.profileId, offer: { amountCents: 15000, note: "Looking forward to it!" } },
    musician.owner.user);
  await callFn("acceptBooking", { bookingId }, curator.owner.user);
  return { curator, musician, gigId, bookingId };
}

export function eventContent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const startsAt = Date.now() + 7 * 24 * 3600 * 1000;
  return {
    title: "Friday Night Jazz Showcase", description: "An evening of live jazz.",
    startsAt, endsAt: startsAt + 3 * 3600 * 1000,
    lineup: [{ kind: "external", name: "The Quartet" }],
    ...overrides,
  };
}

export async function makeDraftEvent(prefix: string) {
  const { owner, profileId } = await makeApprovedCuratorProfile(prefix, "venue");
  const { eventId } = await callFn<Record<string, unknown>, { eventId: string }>(
    "createEvent", { curatorProfileId: profileId, source: { kind: "standalone" }, ...eventContent() }, owner.user);
  return { owner, profileId, eventId };
}

export async function addTiers(
  profileId: string, eventId: string, user: User,
  tiers: Record<string, unknown>[],
): Promise<void> {
  await callFn("setEventTiers", { curatorProfileId: profileId, eventId, tiers }, user);
}

export async function addTiersAndPublish(profileId: string, eventId: string, user: User, tiers: Record<string, unknown>[]) {
  await addTiers(profileId, eventId, user, tiers);
  await callFn("publishEvent", { curatorProfileId: profileId, eventId }, user);
}
export async function tierIdByName(eventId: string, name: string): Promise<string> {
  const snap = await adb.collection(`events/${eventId}/tiers`).where("name", "==", name).get();
  if (snap.docs.length !== 1) throw new Error(`expected one tier named ${name}`);
  return snap.docs[0].id;
}
export async function makeFan(prefix: string) { return signUpTestUser(`${prefix}-${Date.now()}@test.com`); }
export async function buyFreeTicket(eventId: string, tierId: string, user: User): Promise<string> {
  const { orderId } = await callFn<Record<string, unknown>, { orderId: string; clientSecret: string | null }>(
    "createTicketOrder", { eventId, items: [{ tierId, quantity: 1 }] }, user);
  return orderId;
}
/** A published event whose lineup is a REAL booking act (so lineupMusicianProfileIds is non-empty). */
export async function makePublishedBookingEvent(prefix: string, tiers: Record<string, unknown>[] = [
  { name: "General", priceCents: 0, capacity: 50, saleStartsAt: null, saleEndsAt: null },
]) {
  const { curator, musician, bookingId } = await makeFilledGig(prefix);
  const { eventId } = await callFn<Record<string, unknown>, { eventId: string }>("createEvent", {
    curatorProfileId: curator.profileId, source: { kind: "standalone" },
    ...eventContent({ lineup: [{ kind: "booking", bookingId, musicianProfileId: musician.profileId, name: "The Act" }] }),
  }, curator.owner.user);
  await addTiersAndPublish(curator.profileId, eventId, curator.owner.user, tiers);
  return { curator, musician, eventId };
}

// Triggers run asynchronously in the emulator: poll until the index doc
// reaches the expected state, and return the last seen state on timeout.
export async function waitForIndex(
  id: string, ok: (d: SearchIndexDoc | undefined) => boolean, ms = 15_000,
): Promise<SearchIndexDoc | undefined> {
  const until = Date.now() + ms;
  for (;;) {
    const snap = await adb.doc(`searchIndex/${id}`).get();
    const d = snap.exists ? (snap.data() as SearchIndexDoc) : undefined;
    if (ok(d)) return d;
    if (Date.now() > until) return d;
    await new Promise((r) => setTimeout(r, 300));
  }
}
