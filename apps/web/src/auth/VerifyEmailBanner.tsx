"use client";
import { useEffect, useState } from "react";
import { sendEmailVerification } from "firebase/auth";
import { useAuth } from "./AuthProvider";
import { Button } from "../ui/button";
import { IconWarning } from "../ui/icons";

// Shown whenever the signed-in user's email is unverified (sp1 audit
// finding 5): every booking, ticket, and gig callable refuses until it is,
// and before this banner nothing on the web client said so or offered a
// resend. Mounted once in app/layout.tsx above AppShell so it appears on
// the shell routes AND on the bare public event page, where a fan who just
// signed up from a Buy button is most likely to hit the refusal.
const RESEND_COOLDOWN_S = 60;

export function VerifyEmailBanner() {
  const { user } = useAuth();
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [busy, setBusy] = useState<"resend" | "check" | null>(null);
  const [note, setNote] = useState<string | null>(null);
  // user.reload() mutates the Firebase User in place; AuthProvider still
  // holds the same reference, so nothing re-renders on its own. Bumped after
  // every reload so `user.emailVerified` below is re-read.
  const [, setReloadCount] = useState(0);

  // Client-side resend cooldown. The countdown runs in a timeout callback,
  // never synchronously in the effect body (react-hooks/set-state-in-effect).
  useEffect(() => {
    if (secondsLeft <= 0) return;
    const t = setTimeout(() => setSecondsLeft((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [secondsLeft]);

  if (!user || user.emailVerified) return null;

  const resend = async () => {
    setBusy("resend");
    setNote(null);
    try {
      await sendEmailVerification(user);
      setSecondsLeft(RESEND_COOLDOWN_S);
      setNote(`Link sent to ${user.email}.`);
    } catch (e) {
      const code = (e as { code?: string }).code;
      setNote(code === "auth/too-many-requests"
        ? "Too many tries. Wait a minute and try again."
        : "Couldn't send the link. Try again.");
    } finally {
      setBusy(null);
    }
  };

  const check = async () => {
    setBusy("check");
    setNote(null);
    try {
      await user.reload();
      // Force the ID token, not just the User: the callables read the
      // token's email_verified claim, which the hourly rotation would
      // otherwise leave stale for up to an hour after the link was clicked.
      await user.getIdToken(true);
      setReloadCount((n) => n + 1);
      if (!user.emailVerified) setNote("Still unverified. Open the link in the email first.");
    } catch {
      setNote("Couldn't check right now. Try again.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div role="status" className="border-b border-gk-warning/40 bg-gk-warning/14">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2 sm:px-6">
        <p className="flex min-w-0 flex-1 items-start gap-2 font-sora text-sm text-gk-warning">
          <IconWarning size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
          <span>
            Verify your email to book, buy tickets, or post gigs.{" "}
            {note ?? `We sent a link to ${user.email}.`}
          </span>
        </p>
        <div className="flex shrink-0 gap-2">
          <Button type="button" variant="secondary" size="sm" className="min-h-11"
            onClick={resend} disabled={busy !== null || secondsLeft > 0}>
            {busy === "resend" ? "Sending…" : secondsLeft > 0 ? `Resend in ${secondsLeft}s` : "Resend link"}
          </Button>
          <Button type="button" size="sm" className="min-h-11" onClick={check} disabled={busy !== null}>
            {busy === "check" ? "Checking…" : "I've verified"}
          </Button>
        </div>
      </div>
    </div>
  );
}
