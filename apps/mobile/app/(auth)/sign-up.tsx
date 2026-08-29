import { useState } from "react";
import { View, Alert } from "react-native";
import { createUserWithEmailAndPassword, sendEmailVerification } from "firebase/auth";
import { getFirebase } from "../../src/lib/firebase";
import { Text, Button, Input, PageBackground, ErrorBanner } from "../../src/ui";
import { tokens } from "../../src/theme/tokens";

export default function SignUp() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  // Presentation-only: the branded inline banner is the one error surface
  // for the caught failure below (replaces the old Alert.alert popup for
  // errors). The success alert is untouched.
  const [error, setError] = useState<string | null>(null);
  const create = async () => {
    try {
      const cred = await createUserWithEmailAndPassword(getFirebase().auth, email.trim(), password);
      await sendEmailVerification(cred.user);
      Alert.alert("Welcome!", "We sent a verification link to your email.");
    } catch (e: any) {
      const msg = e?.code === "auth/email-already-in-use"
        ? "That email already has an account: try signing in instead."
        : e?.code === "auth/weak-password" ? "Password must be at least 6 characters."
        : "Couldn't create the account. Try again.";
      setError(msg);
    }
  };
  return (
    <View style={{ flex: 1 }}>
      <PageBackground />
      <View style={{ flex: 1, justifyContent: "center", padding: tokens.space.xl, gap: tokens.space.md }}>
        <Text variant="heading">Create your account</Text>
        <ErrorBanner message={error} />
        <Input placeholder="Email" autoCapitalize="none" keyboardType="email-address"
          value={email} onChangeText={setEmail} />
        <Input placeholder="Password" secureTextEntry
          value={password} onChangeText={setPassword} />
        <Button title="Create account" onPress={() => { setError(null); void create(); }} />
      </View>
    </View>
  );
}
