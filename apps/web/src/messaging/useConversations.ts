"use client";
import { useEffect, useRef, useState } from "react";
import { collection, doc, getDoc, limit, onSnapshot, orderBy, query } from "firebase/firestore";
import {
  conversationPairId, isValidDocId,
  type ConversationRefDoc, type ProfileDoc, type ProfileType,
} from "@gatekeep/shared";
import { getFirebase } from "../lib/firebase";

// Task 6 (web Messages page). Data facts as amended after the plan was
// written (spec section 4, binding over the task-6 brief): the client LISTS
// a profile's conversations from its own mirror subcollection
// (profiles/{profileId}/conversations/{pairId}, ConversationRefDoc), never
// from the top-level `conversations` collection: firestore.rules cannot
// prove a top-level `participants array-contains` list rule (see that
// file's own comment on the mirror), so every inbox list on every platform
// goes through the mirror instead. The top-level conversations/{pairId} doc
// is opened by id (ConversationThread.tsx), never listed.

export type ConversationRow = { id: string } & ConversationRefDoc;

// Same "loading | error | rows" + retry shape as EarningsPanel.tsx's own
// subscription (audit item #10: every onSnapshot gets an error callback
// that renders a real error state with a retry, not a silent hang).
export function useConversations(profileId: string | null): { rows: ConversationRow[] | "loading" | "error"; retry: () => void } {
  const [rows, setRows] = useState<ConversationRow[] | "loading" | "error">("loading");
  const [reloadKey, setReloadKey] = useState(0);
  // Render-time reset (the same synchronous-during-render idiom
  // useMyProfiles.ts's own trackedUid uses, not a setState call inside the
  // effect body below): react-hooks/set-state-in-effect forbids resetting
  // state synchronously as the FIRST thing an effect does, so a profile
  // switch drops the previous profile's rows back to "loading" here,
  // before the effect below even runs, rather than briefly showing the
  // wrong profile's stale list.
  const [trackedProfileId, setTrackedProfileId] = useState(profileId);
  if (profileId !== trackedProfileId) {
    setTrackedProfileId(profileId);
    setRows("loading");
  }

  useEffect(() => {
    if (!profileId) return;
    const { db } = getFirebase();
    const unsub = onSnapshot(
      query(collection(db, `profiles/${profileId}/conversations`), orderBy("lastMessageAt", "desc"), limit(50)),
      (snap) => setRows(snap.docs.map((d) => ({ id: d.id, ...(d.data() as ConversationRefDoc) }))),
      () => setRows("error"),
    );
    return () => { unsub(); };
  }, [profileId, reloadKey]);

  return {
    rows,
    retry: () => { setRows("loading"); setReloadKey((k) => k + 1); },
  };
}

// This profile's own unread count on a row: a plain number on the mirror
// (ConversationRefDoc.unread) now, not a per-profile map keyed by profileId
// (Task 3's fix round 1 moved that map off the shared top-level doc
// entirely so neither side could watch the other's read activity, see
// types.ts's own comment on ConversationDoc/ConversationRefDoc). Every row
// this hook returns already comes from THIS profile's own mirror, so
// `unread` needs no profileId argument to disambiguate: exported anyway so
// the list and the nav badge below read the exact same field rather than
// two copies that could drift.
export function unreadFor(row: ConversationRow): number {
  return row.unread ?? 0;
}

export type OtherProfileSummary = { profileId: string; name: string; type: ProfileType; handle: string };

// Resolves each row's OTHER participant to { name, type, handle }, one
// getDoc per distinct id, cached in a ref exactly like TicketsClient.tsx's
// own useEventCache: `requested` is a ref (not part of the returned state)
// so this effect's own setMap call never re-triggers itself. Returns null
// for a profile it cannot read (a rare race: the other profile was deleted
// or de-approved after this mirror row was written).
export function useOtherProfiles(
  rows: ConversationRow[] | "loading" | "error",
  profileId: string | null,
): Map<string, OtherProfileSummary | null> {
  const [map, setMap] = useState<Map<string, OtherProfileSummary | null>>(new Map());
  const requested = useRef(new Set<string>());

  const ids = rows === "loading" || rows === "error" ? [] : rows.map((r) => r.otherProfileId);
  const idsKey = ids.join(",");

  useEffect(() => {
    const missing = ids.filter((id) => !requested.current.has(id));
    if (missing.length === 0) return;
    for (const id of missing) requested.current.add(id);
    let cancelled = false;
    const { db } = getFirebase();
    void Promise.all(missing.map(async (id) => {
      try {
        const snap = await getDoc(doc(db, "profiles", id));
        if (!snap.exists()) return [id, null] as const;
        const d = snap.data() as ProfileDoc;
        return [id, { profileId: id, name: d.name, type: d.type, handle: d.handle }] as const;
      } catch {
        return [id, null] as const;
      }
    })).then((results) => {
      if (cancelled) return;
      setMap((prev) => {
        const next = new Map(prev);
        for (const [id, info] of results) next.set(id, info);
        return next;
      });
    });
    return () => { cancelled = true; };
    // idsKey (not `ids`, a fresh array every render) is the real dependency:
    // it only changes when the SET of distinct other-profile ids changes.
    // profileId is referenced only to reset resolution when the acting
    // profile itself switches (a fresh mirror list, a fresh cache).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey, profileId]);

  return map;
}

// The two profile ids a conversation id names, or null when the id is not a
// well-formed pair id. Client mirror of messaging.ts's own parsePairId:
// pure string work, no read, so a malformed or foreign id is turned away
// before anything is fetched.
function parsePairId(conversationId: string): { musicianProfileId: string; curatorProfileId: string } | null {
  const parts = conversationId.split("__");
  if (parts.length !== 2) return null;
  const [musicianProfileId, curatorProfileId] = parts;
  if (!isValidDocId(musicianProfileId) || !isValidDocId(curatorProfileId)) return null;
  if (conversationPairId(musicianProfileId, curatorProfileId) !== conversationId) return null;
  return { musicianProfileId, curatorProfileId };
}

// The thread's own "who am I talking to" resolver, DISTINCT from
// useOtherProfiles above: a conversation reached via a deep link
// (notificationHref, or Task 7's MessageButton) can name a pair that has
// never sent a first message yet ("the button opens the conversation,
// creating it on first send", spec 3.1), so neither this profile's mirror
// row nor the top-level conversation doc exists yet to read a name off of.
// The pair's two profile ids are already IN the conversation id itself
// (conversationPairId's own format), so this resolves the other profile
// directly off `profiles/{id}` rather than depending on a mirror row
// existing first. Returns null for a malformed id or one that does not
// name `profileId` as a participant at all.
export function useOtherProfileForConversation(
  conversationId: string | null,
  profileId: string | null,
): OtherProfileSummary | "loading" | "error" | null {
  // Pure derivation from the two arguments, recomputed every render: no
  // state, no effect needed just to decide WHICH profile id (if any) is the
  // other side, or whether the pair is malformed/foreign.
  const pair = conversationId ? parsePairId(conversationId) : null;
  const invalid = conversationId !== null && profileId !== null
    && (!pair || (pair.musicianProfileId !== profileId && pair.curatorProfileId !== profileId));
  // Fix round 1: `invalid` is folded INTO `otherId` itself, not just into
  // the state the render-time reset below writes. Before this fix, a
  // foreign pair (well-formed, but naming two profiles neither of which is
  // `profileId`) still computed a real `otherId` (the ternary's fallback
  // branch always resolves to `pair.musicianProfileId` when `profileId`
  // matches neither side), and the fetch effect below is keyed ONLY on
  // `otherId` - so it fired anyway, fetched that unrelated profile, and
  // overwrote the render-time reset's `null` with a real (wrong) result,
  // rendering an unrelated profile's name and a working composer as if it
  // were this conversation's other side. Null here means the effect below
  // never runs at all for an invalid pair, on first render or any later
  // profile switch.
  const otherId = (pair && profileId && !invalid)
    ? (pair.musicianProfileId === profileId ? pair.curatorProfileId : pair.musicianProfileId)
    : null;

  // Render-time reset (see useConversations' own comment above for why this
  // is a render-time assignment and not a setState call inside the effect
  // body): `otherId`/`invalid` changing means a genuinely different
  // resolution is about to run, so the previous conversation's resolved
  // profile is dropped back to "loading" (or straight to null for a
  // malformed/foreign id) here, before the effect below fires.
  //
  // Fix round 1: the INITIAL value is now a lazy initializer computed from
  // `invalid` at mount time, not a bare "loading". The old code initialized
  // `trackedTrackedKey` to `trackedKey`'s own current value, so on the very
  // FIRST render the two were equal by construction and the "did the key
  // change" check below never fired - a conversation that was ALREADY
  // malformed or foreign on mount (the common case: it arrives that way
  // from a bad ?c= or a stale deep link, never becomes that way mid-render)
  // stayed at the bare initial "loading" forever, hanging the thread pane
  // in its skeleton state.
  const [state, setState] = useState<OtherProfileSummary | "loading" | "error" | null>(() => (invalid ? null : "loading"));
  const trackedKey = otherId ?? (invalid ? "invalid" : "pending");
  const [trackedTrackedKey, setTrackedTrackedKey] = useState(trackedKey);
  if (trackedKey !== trackedTrackedKey) {
    setTrackedTrackedKey(trackedKey);
    setState(invalid ? null : "loading");
  }

  useEffect(() => {
    if (!otherId) return;
    let cancelled = false;
    const { db } = getFirebase();
    getDoc(doc(db, "profiles", otherId))
      .then((snap) => {
        if (cancelled) return;
        if (!snap.exists()) { setState(null); return; }
        const d = snap.data() as ProfileDoc;
        setState({ profileId: otherId, name: d.name, type: d.type, handle: d.handle });
      })
      .catch(() => { if (!cancelled) setState("error"); });
    return () => { cancelled = true; };
  }, [otherId]);

  return state;
}

// Sum of `unread` across every one of the caller's own conversation
// mirrors, across every profile id passed in. One onSnapshot per profile id
// (most accounts hold one or two musician/curator profiles), summed as they
// each resolve; a failed subscription counts as 0 for that profile rather
// than surfacing an error (a nav badge with no retry affordance isn't worth
// an error state, the same call EarningsPanel.tsx's own status makes for
// non-critical chrome). Used by the web nav badge (AppShell.tsx) and, per
// contract, by Task 11's mobile twin.
export function useUnreadTotal(profileIds: string[]): number {
  const [totals, setTotals] = useState<Record<string, number>>({});
  const idsKey = profileIds.join(",");

  useEffect(() => {
    const { db } = getFirebase();
    const unsubs = profileIds.map((profileId) => onSnapshot(
      collection(db, `profiles/${profileId}/conversations`),
      (snap) => {
        const sum = snap.docs.reduce((acc, d) => acc + unreadFor({ id: d.id, ...(d.data() as ConversationRefDoc) }), 0);
        setTotals((prev) => ({ ...prev, [profileId]: sum }));
      },
      () => setTotals((prev) => ({ ...prev, [profileId]: 0 })),
    ));
    return () => { unsubs.forEach((u) => u()); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey]);

  // Summed only over the CURRENT profileIds (not every key `totals` has ever
  // held): a profile that drops out of the list (e.g. the account no longer
  // administers it) stops contributing immediately rather than leaving a
  // stale count behind from before its own subscription was torn down.
  return profileIds.reduce((acc, id) => acc + (totals[id] ?? 0), 0);
}
