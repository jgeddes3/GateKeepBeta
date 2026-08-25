import { useState } from "react";
import { View, Text, TextInput, Pressable, Platform, Alert } from "react-native";
import { Link } from "expo-router";
import {
  signInWithEmailAndPassword, GoogleAuthProvider, OAuthProvider, signInWithCredential,
} from "firebase/auth";
import { GoogleSignin } from "@react-native-google-signin/google-signin";
import * as AppleAuthentication from "expo-apple-authentication";
import { getFirebase } from "../../src/lib/firebase";
import { GOOGLE_WEB_CLIENT_ID } from "../../src/auth/config";

GoogleSignin.configure({ webClientId: GOOGLE_WEB_CLIENT_ID });

// Firebase auth error codes → human messages (spec §9: friendly auth errors).
function authMessage(code: string): string {
  switch (code) {
    case "auth/invalid-credential":
    case "auth/wrong-password": return "That email and password don't match.";
    case "auth/user-not-found": return "No account with that email. Did you sign up with Google or Apple?";
    case "auth/too-many-requests": return "Too many tries. Wait a minute and try again.";
    default: return "Couldn't sign you in. Check your connection and try again.";
  }
}

export default function SignIn() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const { auth } = getFirebase();

  const emailSignIn = async () => {
    try { await signInWithEmailAndPassword(auth, email.trim(), password); }
    catch (e: any) { Alert.alert("Sign in", authMessage(e?.code ?? "")); }
  };
  const googleSignIn = async () => {
    try {
      await GoogleSignin.hasPlayServices();
      const res = await GoogleSignin.signIn();
      const idToken = res.data?.idToken;
      if (!idToken) return;
      await signInWithCredential(auth, GoogleAuthProvider.credential(idToken));
    } catch { Alert.alert("Sign in", "Google sign-in didn't complete."); }
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
    } catch { Alert.alert("Sign in", "Apple sign-in didn't complete."); }
  };

  return (
    <View style={{ flex: 1, justifyContent: "center", padding: 24, gap: 12 }}>
      <Text style={{ fontSize: 28, fontWeight: "700" }}>GateKeep</Text>
      <TextInput placeholder="Email" autoCapitalize="none" keyboardType="email-address"
        value={email} onChangeText={setEmail} style={{ borderWidth: 1, padding: 12, borderRadius: 8 }} />
      <TextInput placeholder="Password" secureTextEntry
        value={password} onChangeText={setPassword} style={{ borderWidth: 1, padding: 12, borderRadius: 8 }} />
      <Pressable onPress={emailSignIn} style={{ backgroundColor: "#111", padding: 14, borderRadius: 8 }}>
        <Text style={{ color: "#fff", textAlign: "center" }}>Sign in</Text>
      </Pressable>
      <Pressable onPress={googleSignIn} style={{ borderWidth: 1, padding: 14, borderRadius: 8 }}>
        <Text style={{ textAlign: "center" }}>Continue with Google</Text>
      </Pressable>
      {Platform.OS === "ios" && (
        <Pressable onPress={appleSignIn} style={{ borderWidth: 1, padding: 14, borderRadius: 8 }}>
          <Text style={{ textAlign: "center" }}>Continue with Apple</Text>
        </Pressable>
      )}
      <Pressable onPress={async () => {
        if (!email.trim()) { Alert.alert("Reset password", "Enter your email above first."); return; }
        const { sendPasswordResetEmail } = await import("firebase/auth");
        try { await sendPasswordResetEmail(auth, email.trim());
              Alert.alert("Reset password", "Reset link sent — check your email."); }
        catch { Alert.alert("Reset password", "Couldn't send the reset email."); }
      }}><Text>Forgot password?</Text></Pressable>
      <Link href="/(auth)/sign-up"><Text>New here? Create an account</Text></Link>
    </View>
  );
}
