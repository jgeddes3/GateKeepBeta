"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  signInWithEmailAndPassword, createUserWithEmailAndPassword, sendEmailVerification,
  signInWithPopup, GoogleAuthProvider, OAuthProvider, fetchSignInMethodsForEmail,
  type Auth, type AuthError,
} from "firebase/auth";
import { getFirebase } from "../../src/lib/firebase";

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
  const router = useRouter();
  const { auth } = getFirebase();

  const emailAuth = async () => {
    setError("");
    try {
      if (mode === "in") await signInWithEmailAndPassword(auth, email.trim(), password);
      else {
        const cred = await createUserWithEmailAndPassword(auth, email.trim(), password);
        await sendEmailVerification(cred.user);
      }
      router.push("/dashboard");
    } catch (e) {
      setError(authMessage((e as AuthError)?.code ?? "", mode));
    }
  };
  const social = async (provider: "google" | "apple") => {
    setError("");
    try {
      await signInWithPopup(auth, provider === "google" ? new GoogleAuthProvider() : new OAuthProvider("apple.com"));
      router.push("/dashboard");
    } catch (e) {
      const err = e as AuthError;
      if (err?.code === "auth/account-exists-with-different-credential") {
        setError(await accountExistsMessage(auth, err));
        return;
      }
      setError("Sign-in didn't complete.");
    }
  };

  return (
    <main style={{ maxWidth: 380, margin: "80px auto", display: "grid", gap: 12 }}>
      <h1>GateKeep</h1>
      <input placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} />
      <input placeholder="Password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
      <button onClick={emailAuth}>{mode === "in" ? "Sign in" : "Create account"}</button>
      <button onClick={() => social("google")}>Continue with Google</button>
      <button onClick={() => social("apple")}>Continue with Apple</button>
      <button onClick={() => setMode(mode === "in" ? "up" : "in")}>
        {mode === "in" ? "New here? Create an account" : "Have an account? Sign in"}
      </button>
      <button onClick={async () => {
        if (!email.trim()) { setError("Enter your email above, then press Forgot password."); return; }
        const { sendPasswordResetEmail } = await import("firebase/auth");
        try { await sendPasswordResetEmail(auth, email.trim()); setError("Reset link sent — check your email."); }
        catch { setError("Couldn't send the reset email."); }
      }}>Forgot password?</button>
      {error && <p style={{ color: "#dc2626" }}>{error}</p>}
    </main>
  );
}
