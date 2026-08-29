"use client";
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  signInWithEmailAndPassword, createUserWithEmailAndPassword, sendEmailVerification,
  signInWithPopup, GoogleAuthProvider, OAuthProvider, fetchSignInMethodsForEmail,
  type Auth, type AuthError,
} from "firebase/auth";
import { getFirebase } from "../../src/lib/firebase";
import { Button } from "../../src/ui/button";
import { Input } from "../../src/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../src/ui/card";
import { Footer } from "../../src/shell/Footer";
import { IconApple, IconGoogle, IconWarning } from "../../src/ui/icons";

// Firebase auth error codes -> human messages (mirrors apps/mobile's authMessage()).
function authMessage(code: string, mode: "in" | "up"): string {
  switch (code) {
    case "auth/invalid-credential":
    case "auth/wrong-password": return "That email and password don't match.";
    case "auth/user-not-found": return "No account with that email. Did you sign up with Google or Apple?";
    case "auth/too-many-requests": return "Too many tries. Wait a minute and try again.";
    case "auth/email-already-in-use": return "That email already has an account — try signing in instead.";
    case "auth/weak-password": return "Password must be at least 6 characters.";
    case "auth/account-exists-with-different-credential":
      return "This email is already registered with a different sign-in method.";
    default: return mode === "in" ? "That email and password don't match." : "Couldn't create the account.";
  }
}

// One-method-per-user stance: when a Google/Apple credential collides with an email already
// registered under a different provider, tell the user which method to use instead of a
// generic failure (mirrors apps/mobile's accountExistsMessage()).
async function accountExistsMessage(auth: Auth, e: AuthError): Promise<string> {
  const fallback = "This email is already registered with a different sign-in method.";
  const email = e.customData?.email as string | undefined;
  if (!email) return fallback;
  try {
    const methods = await fetchSignInMethodsForEmail(auth, email);
    const label = methods.includes("password") ? "email & password"
      : methods.includes("google.com") ? "Google"
      : methods.includes("apple.com") ? "Apple"
      : undefined;
    return label
      ? `This email already has a GateKeep account using ${label}. Sign in with that method instead.`
      : fallback;
  } catch { return fallback; }
}

export default function SignInPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mode, setMode] = useState<"in" | "up">("in");
  const [error, setError] = useState("");
  // Restyle addition (task 5 brief: "every async submit gets a busy state").
  // Purely a UI affordance layered around the existing calls below: it does
  // not change which Firebase functions run, their arguments, their order,
  // or the redirect target.
  const [busy, setBusy] = useState(false);
  const router = useRouter();
  const { auth } = getFirebase();

  const emailAuth = async () => {
    setError("");
    setBusy(true);
    try {
      if (mode === "in") await signInWithEmailAndPassword(auth, email.trim(), password);
      else {
        const cred = await createUserWithEmailAndPassword(auth, email.trim(), password);
        await sendEmailVerification(cred.user);
      }
      router.push("/dashboard");
    } catch (e) {
      setError(authMessage((e as AuthError)?.code ?? "", mode));
      setBusy(false);
    }
  };
  const social = async (provider: "google" | "apple") => {
    setError("");
    setBusy(true);
    try {
      await signInWithPopup(auth, provider === "google" ? new GoogleAuthProvider() : new OAuthProvider("apple.com"));
      router.push("/dashboard");
    } catch (e) {
      const err = e as AuthError;
      if (err?.code === "auth/account-exists-with-different-credential") {
        setError(await accountExistsMessage(auth, err));
        setBusy(false);
        return;
      }
      setError("Sign-in didn't complete.");
      setBusy(false);
    }
  };

  const heading = mode === "in" ? "Welcome back" : "Create your account";
  const subline = mode === "in"
    ? "Sign in to manage your gigs, your bookings, or just tonight's plans."
    : "Musicians book the gig, curators fill the room, you pick which one you are.";

  return (
    <>
      {/* Standalone auth route: AppShell deliberately does not wrap /sign-in
          (see src/shell/AppShell.tsx's SHELL_PREFIXES comment), and this
          route follows system preference / the visitor's stored theme
          choice like the rest of the signed-out-but-not-marketing surface,
          not the dark marketing default forced on "/", "/terms", "/privacy".
          body already paints var(--gk-page) (globals.css), so the card just
          needs to sit centered on top of it. flex-1 on <main> matches the
          same pattern LegalPage uses so Footer stays pinned to the bottom
          of a short viewport instead of floating right under the card. */}
      <main className="flex flex-1 flex-col items-center justify-center px-4 py-16 sm:py-24">
        <div className="w-full max-w-sm">
          <Link href="/" className="mb-8 inline-block font-sora text-sm text-gk-muted hover:text-gk-text">
            &larr; GateKeep
          </Link>
          <Card>
            <CardHeader>
              <CardTitle className="font-syne text-2xl font-bold text-gk-text">{heading}</CardTitle>
              <CardDescription>{subline}</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4">
              <div className="grid gap-1.5">
                <label htmlFor="signin-email" className="font-sora text-sm font-medium text-gk-text">
                  Email
                </label>
                <Input
                  id="signin-email"
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </div>
              <div className="grid gap-1.5">
                <label htmlFor="signin-password" className="font-sora text-sm font-medium text-gk-text">
                  Password
                </label>
                <Input
                  id="signin-password"
                  type="password"
                  autoComplete={mode === "in" ? "current-password" : "new-password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </div>

              {error && (
                <div
                  role="alert"
                  className="flex items-start gap-2 rounded-gk border border-gk-destructive/40 bg-gk-destructive/14 px-3.5 py-2.5 font-sora text-sm text-gk-destructive"
                >
                  <IconWarning size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
                  <p>{error}</p>
                </div>
              )}

              <Button type="button" onClick={emailAuth} disabled={busy}>
                {busy
                  ? (mode === "in" ? "Signing in…" : "Creating account…")
                  : (mode === "in" ? "Sign in" : "Create account")}
              </Button>

              <div className="flex items-center gap-3 py-1">
                <div className="h-px flex-1 bg-gk-border" />
                <span className="font-sora text-xs text-gk-muted">or</span>
                <div className="h-px flex-1 bg-gk-border" />
              </div>

              <Button type="button" variant="secondary" onClick={() => social("google")} disabled={busy}>
                <IconGoogle size={18} aria-hidden="true" />
                Continue with Google
              </Button>
              <Button type="button" variant="secondary" onClick={() => social("apple")} disabled={busy}>
                <IconApple size={18} aria-hidden="true" />
                Continue with Apple
              </Button>

              <div className="mt-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
                <Button
                  type="button"
                  variant="link"
                  className="h-auto p-0 text-gk-muted"
                  onClick={() => setMode(mode === "in" ? "up" : "in")}
                >
                  {mode === "in" ? "New here? Create an account" : "Have an account? Sign in"}
                </Button>
                <Button
                  type="button"
                  variant="link"
                  className="h-auto p-0 text-gk-muted"
                  onClick={async () => {
                    if (!email.trim()) { setError("Enter your email above, then press Forgot password."); return; }
                    const { sendPasswordResetEmail } = await import("firebase/auth");
                    try { await sendPasswordResetEmail(auth, email.trim()); setError("Reset link sent — check your email."); }
                    catch { setError("Couldn't send the reset email."); }
                  }}
                >
                  Forgot password?
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      </main>
      <Footer />
    </>
  );
}
