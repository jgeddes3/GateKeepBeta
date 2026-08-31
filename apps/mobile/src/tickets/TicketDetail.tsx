import { Linking, ScrollView, View, useWindowDimensions } from "react-native";
import QRCode from "react-native-qrcode-svg";
import type { EventDoc } from "@gatekeep/shared";
import { gigLocationLabel } from "../bookings/BookingForms";
import {
  formatEventFullDate, formatEventTimeRange, TICKET_STATUS_LABEL, TICKET_STATUS_TONE,
  useTicketHolderAddress, mapUrl,
} from "../events/eventDisplay";
import type { TicketRow } from "./TicketList";
import { Text, Button, Card, StatusBadge, Sheet, IconMapPin, IconArrowsLeftRight } from "../ui";
import { useTokens } from "../theme/ThemeProvider";
import { tokens } from "../theme/tokens";

// Sub-project 6 task 11: a ticket's full detail, opened from a row in
// TicketList.tsx. Rendered on the `Sheet` primitive (the only modal-chrome
// primitive 9B shipped) rather than a bespoke `Modal`, per this task's
// binding "9B primitives ONLY" rule; forced to a near-full-screen minimum
// height below so the QR reads as the brief's own "full-screen QR", not a
// half-height bottom sheet. Not visually verified on-device (this machine
// has no dev client, see HANDOFF.md); the exact height fraction is a
// reasonable approximation for the owner's next EAS smoke pass, not a
// pixel-tuned value.
//
// Static dark-on-light QR regardless of theme (controller ruling 4,
// mirrors apps/web/app/tickets/TicketQr.tsx verbatim): a QR code's own
// light/dark modules ARE its data, so this never follows the theme tokens
// the way ordinary content does. The two hex literals below are DESIGN.md's
// documented exception to "zero raw hexes" (binding rule 8).
const QR_DARK = "#0A0A0A";
const QR_LIGHT = "#FFFFFF";

export function TicketDetail({ uid, ticket, event, now, onClose, onTransferPress }: {
  uid: string; ticket: TicketRow; event: EventDoc; now: number;
  onClose: () => void; onTransferPress: () => void;
}) {
  const t = useTokens();
  const { height } = useWindowDimensions();
  const address = useTicketHolderAddress(ticket.eventId, uid);
  // A live entry credential only while it's still "valid"/"checked_in": a
  // refunded or transferred-away ticket is no longer this holder's to
  // present at the door, matching the web twin's own `isLive` gate.
  const isLive = ticket.status === "valid" || ticket.status === "checked_in";
  // Transfer only offered on a still-valid ticket for a published,
  // not-yet-started event (controller ruling 3): a client-side mirror of
  // offerTransfer's own server gates, purely for affordance, the server
  // stays authoritative regardless.
  const canTransfer = ticket.status === "valid" && event.status === "published" && event.startsAt > now;
  const payload = JSON.stringify({ ticketId: ticket.id, eventId: ticket.eventId, qrSecret: ticket.qrSecret });

  return (
    <Sheet visible onClose={onClose}>
      <ScrollView
        style={{ maxHeight: height * 0.82 }}
        contentContainerStyle={{ minHeight: height * 0.6, gap: tokens.space.lg }}
        showsVerticalScrollIndicator={false}
      >
        <View style={{ flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between", gap: tokens.space.sm }}>
          <View style={{ flex: 1, gap: 2 }}>
            <Text variant="heading" numberOfLines={2}>{event.title}</Text>
            <Text muted>{ticket.tierName}</Text>
          </View>
          <StatusBadge label={TICKET_STATUS_LABEL[ticket.status]} status={TICKET_STATUS_TONE[ticket.status]} />
        </View>

        {isLive ? (
          <View style={{ alignItems: "center", gap: tokens.space.sm }}>
            <View style={{ backgroundColor: QR_LIGHT, padding: tokens.space.lg, borderRadius: tokens.radius.card }}>
              <QRCode value={payload} size={220} color={QR_DARK} backgroundColor={QR_LIGHT} ecl="M" />
            </View>
            <Text variant="meta" muted style={{ textAlign: "center" }}>Show this at the door to check in.</Text>
          </View>
        ) : (
          <Card>
            <Text muted>
              {ticket.status === "refunded"
                ? "This ticket was refunded."
                : "This ticket was transferred to someone else."}
            </Text>
          </Card>
        )}

        <View style={{ gap: 4 }}>
          <Text variant="label">{formatEventFullDate(event.startsAt)}</Text>
          <Text muted>{formatEventTimeRange(event.startsAt, event.endsAt)}</Text>
          <Text muted>{gigLocationLabel(event.location)}</Text>
        </View>

        {address !== "hidden" && (
          <View style={{ flexDirection: "row", gap: tokens.space.xs, alignItems: "flex-start" }}>
            <IconMapPin size={16} color={t.muted} />
            <Text style={{ flex: 1 }}>
              {address.address}{" "}
              <Text
                color={t.muted}
                style={{ textDecorationLine: "underline" }}
                onPress={() => void Linking.openURL(mapUrl(address))}
              >
                Map
              </Text>
            </Text>
          </View>
        )}

        <View style={{ gap: tokens.space.sm }}>
          {canTransfer && (
            <Button variant="secondary" onPress={onTransferPress}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: tokens.space.xs }}>
                <IconArrowsLeftRight size={16} color={t.text} />
                <Text variant="label">Transfer this ticket</Text>
              </View>
            </Button>
          )}
          <Button variant="ghost" title="Close" onPress={onClose} />
        </View>
      </ScrollView>
    </Sheet>
  );
}
