import { useState } from "react";
import { View, Platform, Alert } from "react-native";
import { Link } from "expo-router";
import {
  signInWithEmailAndPassword, GoogleAuthProvider, OAuthProvider, signInWithCredential,
  fetchSignInMethodsForEmail, type Auth,
} from "firebase/auth";
import { GoogleSignin } from "@react-native-google-signin/google-signin";
import * as AppleAuthentication from "expo-apple-authentication";
import { getFirebase } from "../../src/lib/firebase";
import { GOOGLE_WEB_CLIENT_ID } from "../../src/auth/config";
import { Text, Button, Input, PageBackground } from "../../src/ui";
import { useTokens } from "../../src/theme/ThemeProvider";
import { tokens } from "../../src/theme/tokens";

GoogleSignin.configure({ webClientId: GOOGLE_WEB_CLIENT_ID });

// Firebase auth error codes → human messages (spec §9: friendly auth errors).
function authMessage(code: string): string {
  switch (code) {
    case "auth/invalid-credential":
    case "auth/wrong-password": return "That email and password don't match.";
    case "auth/user-not-found": return "No account with that email. Did you sign up with Google or Apple?";
    case "auth/too-many-requests": return "Too many tries. Wait a minute and try again.";
    case "auth/account-exists-with-different-credential":
      return "This email is already registered with a different sign-in method.";
    default: return "Couldn't sign you in. Check your connection and try again.";
  }
}

// spec §4: when a Google/Apple credential collides with an email already registered under
// a different provider, tell the user which method to use instead of a generic failure.
async function accountExistsMessage(auth: Auth, e: any): Promise<string> {
  const fallback = "This email is already registered with a different sign-in method.";
  const email = e?.customData?.email as string | undefined;
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

export default function SignIn() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  // Presentation-only: the branded inline banner is the one error surface
  // for every caught auth failure (replaces the old Alert.alert popup for
  // errors). Does not change what triggers a catch or what message is
  // computed, only where the message renders. Success alerts are untouched.
  const [error, setError] = useState<string | null>(null);
  const { auth } = getFirebase();
  const t = useTokens();

  const emailSignIn = async () => {
    try { await signInWithEmailAndPassword(auth, email.trim(), password); }
    catch (e: any) { setError(authMessage(e?.code ?? "")); }
  };
  const googleSignIn = async () => {
    try {
      await GoogleSignin.hasPlayServices();
      const res = await GoogleSignin.signIn();
      const idToken = res.data?.idToken;
      if (!idToken) return;
      await signInWithCredential(auth, GoogleAuthProvider.credential(idToken));
    } catch (e: any) {
      console.warn("sign-in error", e?.code);
      if (e?.code === "auth/account-exists-with-different-credential") {
        setError(await accountExistsMessage(auth, e));
        return;
      }
      setError("Google sign-in didn't complete.");
    }
  };
  const appleSignIn = async () => {
    try {
      const cred = await AppleAuthentication.signInAsync({
        requestedScopes: [AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
                          AppleAuthentication.AppleAuthenticationScope.EMAIL],
      });
      if (!cred.identityToken) return;
      const provider = new OAuthProvider("apple.com");
      await signInWithCredential(auth, provider.credential({ idToken: cred.identityToken }));
    } catch (e: any) {
      // User dismissed the native Apple sheet: not an error worth surfacing.
      if (e?.code === "ERR_REQUEST_CANCELED") return;
      console.warn("sign-in error", e?.code);
      if (e?.code === "auth/account-exists-with-different-credential") {
        setError(await accountExistsMessage(auth, e));
        return;
      }
      setError("Apple sign-in didn't complete.");
    }
  };

  return (
    <View style={{ flex: 1 }}>
      <PageBackground />
      <View style={{ flex: 1, justifyContent: "center", padding: tokens.space.xl, gap: tokens.space.md }}>
        <Text variant="display">GateKeep</Text>
        {error ? (
          <View style={{ borderWidth: 1, borderColor: t.destructive, borderRadius: tokens.radius.card,
            padding: tokens.space.md, backgroundColor: t.surface }}>
            <Text color={t.destructive}>{error}</Text>
          </View>
        ) : null}
        <Input placeholder="Email" autoCapitalize="none" keyboardType="email-address"
          value={email} onChangeText={setEmail} />
        <Input placeholder="Password" secureTextEntry
          value={password} onChangeText={setPassword} />
        <Button title="Sign in" onPress={() => { setError(null); void emailSignIn(); }} />
        <Button title="Continue with Google" variant="secondary"
          onPress={() => { setError(null); void googleSignIn(); }} />
        {Platform.OS === "ios" && (
          <Button title="Continue with Apple" variant="secondary"
            onPress={() => { setError(null); void appleSignIn(); }} />
        )}
        <Button title="Forgot password?" variant="ghost" onPress={async () => {
          setError(null);
          if (!email.trim()) { setError("Enter your email above first."); return; }
          const { sendPasswordResetEmail } = await import("firebase/auth");
          try { await sendPasswordResetEmail(auth, email.trim());
                Alert.alert("Reset password", "Reset link sent, check your email."); }
          catch { setError("Couldn't send the reset email."); }
        }} />
        <Link href="/(auth)/sign-up"><Text color={t.accent}>New here? Create an account</Text></Link>
      </View>
    </View>
  );
}
