import type { User } from "firebase/auth";
import { callFn } from "./helpers";
import { adb, makeApprovedCuratorProfile, makeApprovedMusicianProfile } from "./discoverFixtures";
import {
  conversationPairId, type ConversationDoc, type ConversationRefDoc, type MessageDoc,
} from "@gatekeep/shared";

// An approved musician profile and an approved curator profile plus their
// owners and the pair id they resolve to. No expect() here (fixtures never
// assert); the tests that use it do the asserting.
export async function makeMessagingPair(prefix: string) {
  const musician = await makeApprovedMusicianProfile(`${prefix}m`);
  const curator = await makeApprovedCuratorProfile(`${prefix}c`, "venue");
  return {
    musician, curator,
    musicianProfileId: musician.profileId, curatorProfileId: curator.profileId,
    pairId: conversationPairId(musician.profileId, curator.profileId),
  };
}

export function sendAs(user: User, fromProfileId: string, toProfileId: string, text: string) {
  return callFn<{ fromProfileId: string; toProfileId: string; text: string },
    { conversationId: string; messageId: string }>(
    "sendMessage", { fromProfileId, toProfileId, text }, user);
}

export async function conversation(pairId: string): Promise<ConversationDoc | undefined> {
  return (await adb.doc(`conversations/${pairId}`).get()).data() as ConversationDoc | undefined;
}

// The per-profile mirror the inbox list query reads (spec 4, Task 3 ruling 1).
// Undefined when the mirror has not been written, which is what the tests
// assert against for a side that should never have gained one.
export async function mirror(profileId: string, pairId: string): Promise<ConversationRefDoc | undefined> {
  return (await adb.doc(`profiles/${profileId}/conversations/${pairId}`).get())
    .data() as ConversationRefDoc | undefined;
}

export async function messages(pairId: string): Promise<MessageDoc[]> {
  const snap = await adb.collection(`conversations/${pairId}/messages`).orderBy("at", "asc").get();
  return snap.docs.map((d) => d.data() as MessageDoc);
}

export async function notesOfKind(uid: string, kind: string) {
  const snap = await adb.collection(`users/${uid}/notifications`).where("kind", "==", kind).get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}
