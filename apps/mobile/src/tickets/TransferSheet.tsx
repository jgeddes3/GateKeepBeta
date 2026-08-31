import { useState } from "react";
import { View } from "react-native";
import { httpsCallable } from "firebase/functions";
import { TRANSFER_OFFER_SENT_MESSAGE } from "@gatekeep/shared";
import { getFirebase } from "../lib/firebase";
import { Text, Button, Input, Sheet, Callout, ErrorBanner, IconPaperPlaneTilt } from "../ui";
import { useTokens } from "../theme/ThemeProvider";
import { tokens } from "../theme/tokens";

// Sub-project 6 task 11 (controller ruling 3, binding): transfers are
// mobile-led in v1 (web only shows a hint, see apps/web/app/tickets/
// TicketsClient.tsx's own TicketCard). This is the entire send side: an
// email address and a Send button that always reports the SAME generic
// success text, regardless of whether that email resolves to a real
// account or that account is already at its ticket cap for this event
// (offerTransfer's own anti-enumeration contract, functions/src/
// ticketing.ts). A genuine SENDER-side failure (this ticket isn't valid,
// transfers are closed for the event, a duplicate open offer already
// exists, or the recipient typed is the sender's own email) still throws
// and surfaces verbatim below: those reveal nothing about anyone ELSE's
// account, so offerTransfer fails loudly for them by design.
export function TransferSheet({ ticketId, ticketLabel, onClose }: {
  ticketId: string; ticketLabel: string; onClose: () => void;
}) {
  const t = useTokens();
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  const send = async () => {
    const target = email.trim();
    if (!target) return;
    setBusy(true);
    setError(null);
    try {
      await httpsCallable<{ ticketId: string; target: string }, { message: string }>(
        getFirebase().functions, "offerTransfer")({ ticketId, target });
      setSent(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not send this transfer.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet visible onClose={onClose}>
      <View style={{ gap: tokens.space.md }}>
        <Text variant="title">Transfer this ticket</Text>
        {sent ? (
          <>
            <Callout tone="success"><Text color={t.success}>{TRANSFER_OFFER_SENT_MESSAGE}</Text></Callout>
            <Button title="Done" onPress={onClose} />
          </>
        ) : (
          <>
            <Text muted>
              Send your {ticketLabel} ticket to someone else by email. They&apos;ll get a notification to accept it.
            </Text>
            {error && <ErrorBanner message={error} />}
            <Input
              placeholder="Recipient's email"
              value={email}
              onChangeText={setEmail}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="email-address"
              editable={!busy}
            />
            <View style={{ flexDirection: "row", gap: tokens.space.sm }}>
              <Button onPress={() => void send()} disabled={busy || email.trim().length === 0}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: tokens.space.xs }}>
                  <IconPaperPlaneTilt size={16} color={t.onAccent} />
                  <Text variant="label" color={t.onAccent}>{busy ? "Sending…" : "Send"}</Text>
                </View>
              </Button>
              <Button title="Cancel" variant="secondary" onPress={onClose} disabled={busy} />
            </View>
          </>
        )}
      </View>
    </Sheet>
  );
}
