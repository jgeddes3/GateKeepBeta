import { useEffect, useState } from "react";
import { View } from "react-native";
import { collection, doc, onSnapshot, query, where } from "firebase/firestore";
import { getFirebase } from "../lib/firebase";
import { callFn } from "../lib/callable";
import {
  MAX_PAYOUT_SHARES, payeeKey, validatePayoutShares,
  type HeldShareDoc, type MemberDoc, type PayoutShare, type StripeProfileDoc,
} from "@gatekeep/shared";
import { formatCents } from "../gigs/GigForms";
import { Text, Button, Input, Callout, Card, Skeleton } from "../ui";
import { useTokens } from "../theme/ThemeProvider";
import { tokens } from "../theme/tokens";

// SP5c Task 11: mobile's direct port of apps/web/src/payments/SharesCard.tsx
// (Task 9), every helper below travels, comments included, ported onto the
// mobile primitives (Card/Input/Text/Button/Callout/Skeleton) in place of
// web's Tailwind classes.

type MemberRow = { uid: string; label: string };
type Loadable<T> = T | "loading" | "error";

const PROFILE_KEY = "profile";
function memberKey(uid: string): string { return `member:${uid}`; }

// The editor's baseline: every row's percent as it currently stands on the
// server (0 for a row with no share of its own), keyed the same way
// PayoutShare.payee is keyed (payeeKey, @gatekeep/shared). Comparing the
// live edit state against THIS (not against the raw `shares` array) is what
// "something changed" means: a row typed to 0 that started at 0 is not a
// change, and a row typed to its own already-saved value is not either.
function baselineFrom(shares: PayoutShare[] | null, memberUids: string[]): Record<string, number> {
  const base: Record<string, number> = { [PROFILE_KEY]: 0 };
  for (const uid of memberUids) base[memberKey(uid)] = 0;
  if (shares) for (const s of shares) base[payeeKey(s.payee)] = s.percent;
  return base;
}

// The admin-only editor. Split out from SharesCard so its edit state can be
// seeded ONCE, straight from props, via useState's lazy initializer:
// SharesCard only mounts this once the member roster and the current shares
// have both actually loaded, so there is no async "seed this after the
// effect fires" step. `baseline` and `percents` are held together in ONE
// state object, both frozen at that same mount: the dirty check ("Save
// disabled unless the total is 100 and something changed") compares
// `percents` against `baseline` alone, never against the live `shares` prop.
// Fix round 1 (web): a version that recomputed `baseline` from the live prop
// on every render meant another admin's save (a real Firestore update landing
// on `shares`) flipped Save enabled purely because the frozen edit state now
// differed from the NEW baseline, and clicking Save would overwrite that
// other admin's newer split with this admin's stale numbers. Freezing both
// together means only THIS admin's own edits (setPercent) or a completed
// save/clear of THIS admin's own (handleSave/handleClear, which advance both
// halves together) ever change what "changed" means.
function SharesEditor({
  profileId, members, shares, heldByUid,
}: {
  profileId: string; members: MemberRow[]; shares: PayoutShare[] | null; heldByUid: Record<string, number>;
}) {
  const t = useTokens();
  const [state, setState] = useState<{ baseline: Record<string, number>; percents: Record<string, number> }>(() => {
    const baseline = baselineFrom(shares, members.map((m) => m.uid));
    return { baseline, percents: baseline };
  });
  const { baseline, percents } = state;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const total = Object.values(percents).reduce((sum, n) => sum + n, 0);
  const changed = Object.keys(baseline).some((k) => (percents[k] ?? 0) !== (baseline[k] ?? 0));
  const canSave = total === 100 && changed && !busy;
  const isEmpty = shares === null || shares.length === 0;

  const setPercent = (key: string, raw: string) => {
    const n = raw === "" ? 0 : Math.round(Number(raw));
    const clamped = Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : 0;
    setState((prev) => ({ ...prev, percents: { ...prev.percents, [key]: clamped } }));
    setError(null); setMessage(null);
  };

  const handleSave = async () => {
    setBusy(true); setError(null); setMessage(null);
    const built: PayoutShare[] = [];
    for (const m of members) {
      const percent = percents[memberKey(m.uid)] ?? 0;
      if (percent > 0) built.push({ payee: { kind: "member", uid: m.uid }, percent });
    }
    const profilePercent = percents[PROFILE_KEY] ?? 0;
    if (profilePercent > 0) built.push({ payee: { kind: "profile" }, percent: profilePercent });
    const v = validatePayoutShares(built, new Set(members.map((m) => m.uid)));
    if (!v.ok) { setError(v.reason); setBusy(false); return; }
    try {
      await callFn<{ profileId: string; shares: PayoutShare[] | null }, { ok: boolean }>(
        "setPayoutShares", { profileId, shares: v.shares });
      // The just-saved values are now the server's truth: advance the frozen
      // baseline to match so "changed" (and Save) correctly go back to false,
      // without waiting on the live `shares` prop to catch up.
      const saved = baselineFrom(v.shares, members.map((m) => m.uid));
      setState({ baseline: saved, percents: saved });
      setMessage("Shares saved.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save shares.");
    } finally {
      setBusy(false);
    }
  };

  const handleClear = async () => {
    setBusy(true); setError(null); setMessage(null);
    try {
      await callFn<{ profileId: string; shares: PayoutShare[] | null }, { ok: boolean }>(
        "setPayoutShares", { profileId, shares: null });
      const cleared = baselineFrom(null, members.map((m) => m.uid));
      setState({ baseline: cleared, percents: cleared });
      setMessage("Shares cleared.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not clear shares.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={{ gap: tokens.space.sm }}>
      {isEmpty && (
        <Text muted>No shares set. Everything goes to this profile&apos;s account.</Text>
      )}
      <View style={{ gap: tokens.space.sm }}>
        {members.map((m) => {
          const key = memberKey(m.uid);
          const heldCents = heldByUid[m.uid];
          return (
            <Card key={key} style={{ padding: tokens.space.md }}>
              <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: tokens.space.sm }}>
                <Text>{m.label}</Text>
                <View style={{ flexDirection: "row", alignItems: "center", gap: tokens.space.xs }}>
                  <Input
                    keyboardType="number-pad"
                    value={String(percents[key] ?? 0)}
                    onChangeText={(v) => setPercent(key, v)}
                    editable={!busy}
                    accessibilityLabel={`${m.label} payout share percent`}
                    style={{ width: 60, textAlign: "right" }}
                  />
                  <Text muted>%</Text>
                </View>
              </View>
              {!!heldCents && (
                <Text variant="meta" muted style={{ marginTop: tokens.space.xs }}>Held: {formatCents(heldCents)}</Text>
              )}
            </Card>
          );
        })}
        <Card style={{ padding: tokens.space.md }}>
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: tokens.space.sm }}>
            <Text>Band fund</Text>
            <View style={{ flexDirection: "row", alignItems: "center", gap: tokens.space.xs }}>
              <Input
                keyboardType="number-pad"
                value={String(percents[PROFILE_KEY] ?? 0)}
                onChangeText={(v) => setPercent(PROFILE_KEY, v)}
                editable={!busy}
                accessibilityLabel="Band fund payout share percent"
                style={{ width: 60, textAlign: "right" }}
              />
              <Text muted>%</Text>
            </View>
          </View>
        </Card>
      </View>
      {/* Task 11 brief: on mobile the off-100 total is a Callout, not a
          coloured line. A single tinted word in a stack of number rows is easy
          to miss on a phone; the Callout gives it the same weight as the error
          it will become the moment Save is pressed. Web keeps its coloured
          line, which its own brief names. */}
      {total === 100 ? (
        <Text muted>Total: {total}%</Text>
      ) : (
        <Callout tone="warning"><Text color={t.warning}>Total: {total}%</Text></Callout>
      )}
      <View style={{ flexDirection: "row", gap: tokens.space.sm, flexWrap: "wrap" }}>
        <Button title={busy ? "Saving…" : "Save"} onPress={() => void handleSave()} disabled={!canSave} />
        <Button title="Clear shares" variant="secondary" onPress={() => void handleClear()} disabled={busy || isEmpty} />
      </View>
      {error && (
        <Callout tone="warning"><Text color={t.warning}>{error}</Text></Callout>
      )}
      {message && (
        <Callout tone="success"><Text color={t.success}>{message}</Text></Callout>
      )}
    </View>
  );
}

// The read-only view a plain member gets: whatever shares are currently
// saved, or nothing extra when none are.
function SharesReadOnly({ members, shares, heldByUid }: {
  members: MemberRow[]; shares: PayoutShare[] | null; heldByUid: Record<string, number>;
}) {
  if (shares === null || shares.length === 0) {
    return (
      <Text muted>No shares set. Everything goes to this profile&apos;s account.</Text>
    );
  }
  return (
    <View style={{ gap: tokens.space.sm }}>
      {shares.map((s) => {
        const key = payeeKey(s.payee);
        const payee = s.payee;
        const label = payee.kind === "profile" ? "Band fund" : members.find((m) => m.uid === payee.uid)?.label ?? "Member";
        const heldCents = payee.kind === "member" ? heldByUid[payee.uid] : undefined;
        return (
          <Card key={key} style={{ padding: tokens.space.md }}>
            <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: tokens.space.sm }}>
              <Text>{label}</Text>
              <Text variant="label">{s.percent}%</Text>
            </View>
            {!!heldCents && (
              <Text variant="meta" muted style={{ marginTop: tokens.space.xs }}>Held: {formatCents(heldCents)}</Text>
            )}
          </Card>
        );
      })}
    </View>
  );
}

// SP5c Task 11: the musician profile's standing payout split. Three live
// subscriptions (the member roster, the stripe-private doc's `shares`, and
// this profile's held shares) rather than one-shot reads: any of the three
// can change while the card is open (a member joins, another admin saves a
// split, a held share releases once the member's account activates), and a
// stale editor here is a wrong-money surface, not just a stale display.
export function SharesCard({ profileId, isAdmin }: { profileId: string; isAdmin: boolean }) {
  const t = useTokens();
  const [members, setMembers] = useState<Loadable<MemberRow[]>>("loading");
  const [shares, setShares] = useState<Loadable<PayoutShare[] | null>>("loading");
  const [heldByUid, setHeldByUid] = useState<Record<string, number>>({});

  useEffect(() => {
    let cancelled = false;
    const { db } = getFirebase();
    const unsubMembers = onSnapshot(collection(db, `profiles/${profileId}/members`), (snap) => {
      if (cancelled) return;
      setMembers(snap.docs.map((d) => {
        const data = d.data() as MemberDoc;
        return { uid: d.id, label: data.label || "Member" };
      }));
    }, () => { if (!cancelled) setMembers("error"); });
    const unsubStripe = onSnapshot(doc(db, `profiles/${profileId}/private/stripe`), (snap) => {
      if (cancelled) return;
      setShares((snap.data() as StripeProfileDoc | undefined)?.shares ?? null);
    }, () => { if (!cancelled) setShares("error"); });
    const unsubHeld = onSnapshot(
      query(collection(db, "heldShares"), where("profileId", "==", profileId), where("status", "in", ["held", "failed"])),
      (snap) => {
        if (cancelled) return;
        const totals: Record<string, number> = {};
        for (const d of snap.docs) {
          const h = d.data() as HeldShareDoc;
          totals[h.uid] = (totals[h.uid] ?? 0) + h.amountCents;
        }
        setHeldByUid(totals);
      },
      () => { if (!cancelled) setHeldByUid({}); },
    );
    return () => { cancelled = true; unsubMembers(); unsubStripe(); unsubHeld(); };
  }, [profileId]);

  return (
    <View style={{ gap: tokens.space.sm }}>
      <Text variant="title">Payout shares</Text>
      {(members === "loading" || shares === "loading") && (
        <View style={{ gap: tokens.space.sm }}>
          <Skeleton height={16} width={128} />
          <Skeleton height={36} width="100%" />
        </View>
      )}
      {(members === "error" || shares === "error") && (
        <Callout tone="warning"><Text color={t.warning}>Couldn&apos;t load payout shares.</Text></Callout>
      )}
      {members !== "loading" && members !== "error" && shares !== "loading" && shares !== "error" && (
        // Every share editor/display works off the same row cap
        // (MAX_PAYOUT_SHARES, @gatekeep/shared) validatePayoutShares itself
        // enforces server-side: one slot is reserved for the band-fund row,
        // so at most MAX_PAYOUT_SHARES - 1 members get an editable row.
        isAdmin
          ? <SharesEditor profileId={profileId} members={members.slice(0, MAX_PAYOUT_SHARES - 1)} shares={shares} heldByUid={heldByUid} />
          : <SharesReadOnly members={members} shares={shares} heldByUid={heldByUid} />
      )}
    </View>
  );
}
