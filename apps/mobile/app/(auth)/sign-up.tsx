import { useState } from "react";
import { View, Text, TextInput, Pressable, Alert } from "react-native";
import { createUserWithEmailAndPassword, sendEmailVerification } from "firebase/auth";
import { getFirebase } from "../../src/lib/firebase";

export default function SignUp() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const create = async () => {
    try {
      const cred = await createUserWithEmailAndPassword(getFirebase().auth, email.trim(), password);
      await sendEmailVerification(cred.user);
      Alert.alert("Welcome!", "We sent a verification link to your email.");
    } catch (e: any) {
      const msg = e?.code === "auth/email-already-in-use"
        ? "That email already has an account — try signing in instead."
        : e?.code === "auth/weak-password" ? "Password must be at least 6 characters."
        : "Couldn't create the account. Try again.";
      Alert.alert("Sign up", msg);
    }
  };
  return (
    <View style={{ flex: 1, justifyContent: "center", padding: 24, gap: 12 }}>
      <Text style={{ fontSize: 24, fontWeight: "700" }}>Create your account</Text>
      <TextInput placeholder="Email" autoCapitalize="none" keyboardType="email-address"
        value={email} onChangeText={setEmail} style={{ borderWidth: 1, padding: 12, borderRadius: 8 }} />
      <TextInput placeholder="Password" secureTextEntry
        value={password} onChangeText={setPassword} style={{ borderWidth: 1, padding: 12, borderRadius: 8 }} />
      <Pressable onPress={create} style={{ backgroundColor: "#111", padding: 14, borderRadius: 8 }}>
        <Text style={{ color: "#fff", textAlign: "center" }}>Create account</Text>
      </Pressable>
    </View>
  );
}
