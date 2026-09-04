import { useEffect, useState } from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { sendEmailVerification } from "firebase/auth";
import { useAuth } from "./AuthProvider";
import { Text, Button, IconWarningCircle } from "../ui";
import { useTokens } from "../theme/ThemeProvider";
import { tokens } from "../theme/tokens";

// RN twin of apps/web/src/auth/VerifyEmailBanner.tsx (sp1 audit finding 5).
// Mounted above the root Stack in app/_layout.tsx's Gate, so it sits over
// every signed-in screen; the top safe-area inset is applied here because
// nothing above this view pads for the status bar. 14% warning tint over the
// warning border, the same soft-tint figure Callout and StatusBadge use.
const RESEND_COOLDOWN_S = 60;

export function VerifyEmailBanner() {
  const { user } = useAuth();
  const t = useTokens();
  const insets = useSafeAreaInsets();
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [busy, setBusy] = useState<"resend" | "check" | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [, setReloadCount] = useState(0);

  useEffect(() => {
    if (secondsLeft <= 0) return;
    const timer = setTimeout(() => setSecondsLeft((s) => s - 1), 1000);
    return () => clearTimeout(timer);
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
    <View
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
      style={{
        paddingTop: insets.top + tokens.space.sm, paddingBottom: tokens.space.sm,
        paddingHorizontal: tokens.space.lg, gap: tokens.space.sm,
        backgroundColor: t.warning + "24", borderBottomWidth: 1, borderBottomColor: t.warning,
      }}
    >
      <View style={{ flexDirection: "row", gap: tokens.space.xs, alignItems: "flex-start" }}>
        <IconWarningCircle size={18} color={t.warning} />
        <Text style={{ flex: 1 }} color={t.warning}>
          Verify your email to book, buy tickets, or post gigs. {note ?? `We sent a link to ${user.email}.`}
        </Text>
      </View>
      <View style={{ flexDirection: "row", gap: tokens.space.sm }}>
        <Button variant="secondary" onPress={() => void resend()} disabled={busy !== null || secondsLeft > 0}
          title={busy === "resend" ? "Sending…" : secondsLeft > 0 ? `Resend in ${secondsLeft}s` : "Resend link"} />
        <Button onPress={() => void check()} disabled={busy !== null}
          title={busy === "check" ? "Checking…" : "I've verified"} />
      </View>
    </View>
  );
}
