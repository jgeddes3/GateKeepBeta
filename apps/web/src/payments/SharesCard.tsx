"use client";
import { useEffect, useState } from "react";
import { collection, doc, onSnapshot, query, where } from "firebase/firestore";
import { getFirebase } from "../lib/firebase";
import { callFn } from "../lib/callable";
import {
  MAX_PAYOUT_SHARES, payeeKey, validatePayoutShares,
  type HeldShareDoc, type MemberDoc, type PayoutShare, type StripeProfileDoc,
} from "@gatekeep/shared";
import { formatCents } from "../gigs/GigForms";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Skeleton } from "../ui/skeleton";
import { IconWarning } from "../ui/icons";

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
// Fix round 1: a version that recomputed `baseline` from the live prop on
// every render meant another admin's save (a real Firestore update landing
// on `shares`) flipped Save enabled purely because the frozen edit state now
// differed from the NEW baseline, and clicking Save would overwrite that
// other admin's newer split with this admin's stale numbers. Freezing both
// together means only THIS admin's own edits (setPercent) or a completed
// save/clear of THIS admin's own (handleSave/handleClear, which advance
// both halves together) ever change what "changed" means.
function SharesEditor({
  profileId, members, shares, heldByUid,
}: {
  profileId: string; members: MemberRow[]; shares: PayoutShare[] | null; heldByUid: Record<string, number>;
}) {
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
    <>
      {isEmpty && (
        <p className="font-sora text-sm text-gk-muted">
          No shares set. Everything goes to this profile&apos;s account.
        </p>
      )}
      <ul className="grid gap-2">
        {members.map((m) => {
          const key = memberKey(m.uid);
          const heldCents = heldByUid[m.uid];
          return (
            <li key={key} className="rounded-gk border border-gk-border bg-gk-surface px-3.5 py-2.5">
              <div className="flex items-center justify-between gap-2">
                <span className="font-sora text-sm text-gk-text">{m.label}</span>
                <div className="flex items-center gap-1.5">
                  <Input type="number" min="0" max="100" step="1" inputMode="numeric"
                    value={percents[key] ?? 0}
                    onChange={(e) => setPercent(key, e.target.value)}
                    disabled={busy}
                    aria-label={`${m.label} payout share percent`}
                    className="h-9 w-20 text-right" />
                  <span aria-hidden="true" className="font-sora text-sm text-gk-muted">%</span>
                </div>
              </div>
              {!!heldCents && (
                <p className="mt-0.5 font-sora text-xs text-gk-muted">Held: {formatCents(heldCents)}</p>
              )}
            </li>
          );
        })}
        <li className="rounded-gk border border-gk-border bg-gk-surface px-3.5 py-2.5">
          <div className="flex items-center justify-between gap-2">
            <span className="font-sora text-sm text-gk-text">Band fund</span>
            <div className="flex items-center gap-1.5">
              <Input type="number" min="0" max="100" step="1" inputMode="numeric"
                value={percents[PROFILE_KEY] ?? 0}
                onChange={(e) => setPercent(PROFILE_KEY, e.target.value)}
                disabled={busy}
                aria-label="Band fund payout share percent"
                className="h-9 w-20 text-right" />
              <span aria-hidden="true" className="font-sora text-sm text-gk-muted">%</span>
            </div>
          </div>
        </li>
      </ul>
      <p className={`font-sora text-sm ${total === 100 ? "text-gk-muted" : "text-gk-destructive"}`}>
        Total: {total}%
      </p>
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => void handleSave()} disabled={!canSave}>
          {busy ? "Saving…" : "Save"}
        </Button>
        <Button onClick={() => void handleClear()} disabled={busy || isEmpty} variant="secondary">
          Clear shares
        </Button>
      </div>
      {error && (
        <p role="alert" className="flex items-start gap-2 rounded-gk border border-gk-warning/40 bg-gk-warning/14 px-3.5 py-2.5 font-sora text-sm text-gk-warning">
          <IconWarning size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
          {error}
        </p>
      )}
      {message && <p className="font-sora text-sm text-gk-success">{message}</p>}
    </>
  );
}

// The read-only view a plain member gets: whatever shares are currently
// saved, or nothing extra when none are.
function SharesReadOnly({ members, shares, heldByUid }: {
  members: MemberRow[]; shares: PayoutShare[] | null; heldByUid: Record<string, number>;
}) {
  if (shares === null || shares.length === 0) {
    return (
      <p className="font-sora text-sm text-gk-muted">
        No shares set. Everything goes to this profile&apos;s account.
      </p>
    );
  }
  return (
    <ul className="grid gap-2">
      {shares.map((s) => {
        const key = payeeKey(s.payee);
        const payee = s.payee;
        const label = payee.kind === "profile" ? "Band fund" : members.find((m) => m.uid === payee.uid)?.label ?? "Member";
        const heldCents = payee.kind === "member" ? heldByUid[payee.uid] : undefined;
        return (
          <li key={key} className="rounded-gk border border-gk-border bg-gk-surface px-3.5 py-2.5">
            <div className="flex items-center justify-between gap-2">
              <span className="font-sora text-sm text-gk-text">{label}</span>
              <span className="font-sora text-sm font-medium text-gk-text">{s.percent}%</span>
            </div>
            {!!heldCents && (
              <p className="mt-0.5 font-sora text-xs text-gk-muted">Held: {formatCents(heldCents)}</p>
            )}
          </li>
        );
      })}
    </ul>
  );
}

// SP5c Task 9: the musician profile's standing payout split. Three live
// subscriptions (the member roster, the stripe-private doc's `shares`, and
// this profile's held shares) rather than one-shot reads: any of the three
// can change while the card is open (a member joins, another admin saves a
// split, a held share releases once the member's account activates), and a
// stale editor here is a wrong-money surface, not just a stale display.
export function SharesCard({ profileId, isAdmin }: { profileId: string; isAdmin: boolean }) {
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
    <div className="grid gap-2">
      <h3 className="font-syne text-sm font-semibold text-gk-text">Payout shares</h3>
      {(members === "loading" || shares === "loading") && (
        <div className="grid gap-2" role="status" aria-label="Loading payout shares">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-9 w-full" />
        </div>
      )}
      {(members === "error" || shares === "error") && (
        <p className="flex items-start gap-2 font-sora text-sm text-gk-warning">
          <IconWarning size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
          Couldn&apos;t load payout shares.
        </p>
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
    </div>
  );
}
