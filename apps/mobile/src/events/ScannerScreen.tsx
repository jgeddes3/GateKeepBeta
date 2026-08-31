import { useEffect, useState } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import { httpsCallable } from "firebase/functions";
import { TICKET_ALREADY_CHECKED_IN_MESSAGE } from "@gatekeep/shared";
import { getFirebase } from "../lib/firebase";
import { formatGigTime } from "./eventDisplay";
import {
  Text, Button, Callout, PageBackground, PhotoScrim,
  IconCameraSlash, IconCheckCircle, IconWarningCircle,
} from "../ui";
import { useTokens } from "../theme/ThemeProvider";
import { tokens } from "../theme/tokens";

// Sub-project 6 task 12: the door scanner. No web twin (mobile-only surface,
// same "mobile-led" posture as transfers, controller ruling 3 for Task 11).
//
// QR payload: {ticketId, eventId, qrSecret} (see TicketDetail.tsx's own
// header comment, the wallet side that mints this exact JSON string).
// Parsed DEFENSIVELY: a non-JSON scan, a QR missing a field, or a QR minted
// for a different event never throws, they all fall into the same
// full-screen "invalid" result state as a server-rejected ticket.
interface QrPayload { ticketId: string; eventId: string; qrSecret: string }
function parseQrPayload(data: string): QrPayload | null {
  let obj: unknown;
  try {
    obj = JSON.parse(data);
  } catch {
    return null;
  }
  if (
    obj !== null && typeof obj === "object"
    && typeof (obj as Record<string, unknown>).ticketId === "string"
    && typeof (obj as Record<string, unknown>).eventId === "string"
    && typeof (obj as Record<string, unknown>).qrSecret === "string"
  ) {
    return obj as QrPayload;
  }
  return null;
}

interface CheckInTicketResult { ownerName: string; tierName: string; checkedInAt: number }
interface CheckInTicketInput { curatorProfileId: string; eventId: string; ticketId: string; qrSecret: string }

type ScanResult =
  | { kind: "success"; ownerName: string; tierName: string }
  | { kind: "duplicate"; checkedInAt: number | undefined }
  | { kind: "invalid"; message: string };

// A FunctionsError's `details` (checkInTicket's original checkedInAt on a
// duplicate scan, see functions/src/ticketing.ts's own comment on why it
// rides in details rather than the message) isn't in @firebase/functions'
// public error type, only `.details?: unknown` on the class itself; this
// reads it defensively without importing that internal class.
function errorDetails(e: unknown): { checkedInAt?: number } | undefined {
  if (e && typeof e === "object" && "details" in e) {
    return (e as { details?: { checkedInAt?: number } }).details;
  }
  return undefined;
}

function ResultPanel({ result }: { result: ScanResult }) {
  const t = useTokens();
  const tone = result.kind === "success" ? "success" : "destructive";
  const toneColor = t[tone];
  return (
    <View style={{ flex: 1 }}>
      <PageBackground />
      <View style={{ flex: 1, padding: tokens.space.lg }}>
        <Callout tone={tone} style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: tokens.space.md }}>
          {result.kind === "success"
            ? <IconCheckCircle size={56} color={toneColor} />
            : <IconWarningCircle size={56} color={toneColor} />}
          {result.kind === "success" && (
            <View style={{ alignItems: "center", gap: 4 }}>
              <Text variant="heading" color={toneColor} style={{ textAlign: "center" }}>{result.ownerName}</Text>
              <Text variant="title" muted>{result.tierName}</Text>
            </View>
          )}
          {result.kind === "duplicate" && (
            <View style={{ alignItems: "center", gap: 4 }}>
              <Text variant="heading" color={toneColor}>Already checked in</Text>
              <Text muted style={{ textAlign: "center" }}>
                {result.checkedInAt != null
                  ? `Originally checked in at ${formatGigTime(result.checkedInAt)}.`
                  : "This ticket was already checked in."}
              </Text>
            </View>
          )}
          {result.kind === "invalid" && (
            <View style={{ alignItems: "center", gap: 4 }}>
              <Text variant="heading" color={toneColor}>Not valid</Text>
              <Text muted style={{ textAlign: "center" }}>{result.message}</Text>
            </View>
          )}
        </Callout>
      </View>
    </View>
  );
}

export function ScannerScreen({ curatorProfileId, eventId }: { curatorProfileId: string; eventId: string }) {
  const t = useTokens();
  const [permission, requestPermission] = useCameraPermissions();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ScanResult | null>(null);

  // Auto-ready for the next scan ~1.5s after a result appears (brief's own
  // anatomy), cleared on unmount and whenever a new result replaces this one.
  useEffect(() => {
    if (!result) return;
    const timer = setTimeout(() => setResult(null), 1500);
    return () => clearTimeout(timer);
  }, [result]);

  // Debounced twice over: the CameraView itself unmounts while `result` is
  // showing (see the branch below), so no further decode events can even
  // fire, and this early return additionally covers the brief window between
  // a decode landing and `busy` flipping true.
  const handleScan = ({ data }: { data: string }) => {
    if (busy || result) return;
    const payload = parseQrPayload(data);
    if (!payload || payload.eventId !== eventId) {
      setResult({ kind: "invalid", message: "This QR code isn't a ticket for this event." });
      return;
    }
    setBusy(true);
    httpsCallable<CheckInTicketInput, CheckInTicketResult>(getFirebase().functions, "checkInTicket")({
      curatorProfileId, eventId, ticketId: payload.ticketId, qrSecret: payload.qrSecret,
    })
      .then(({ data: res }) => setResult({ kind: "success", ownerName: res.ownerName, tierName: res.tierName }))
      .catch((e: unknown) => {
        const message = e instanceof Error ? e.message : "Could not check in this ticket.";
        if (message === TICKET_ALREADY_CHECKED_IN_MESSAGE) {
          setResult({ kind: "duplicate", checkedInAt: errorDetails(e)?.checkedInAt });
        } else {
          // TICKET_NOT_VALID_MESSAGE and every other rejection (event not
          // published, ticket not found) share this same destructive
          // "invalid" bucket: none has a useful interactive follow-up from a
          // door scan, matching AttendeeList's own "verbatim server error in
          // a friendly wrapper" convention.
          setResult({ kind: "invalid", message });
        }
      })
      .finally(() => setBusy(false));
  };

  if (!permission) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
        <PageBackground />
        <ActivityIndicator color={t.accent} />
      </View>
    );
  }

  if (!permission.granted) {
    return (
      <View style={{ flex: 1 }}>
        <PageBackground />
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: tokens.space.xl, gap: tokens.space.md }}>
          <IconCameraSlash size={40} color={t.muted} />
          <Text variant="title" style={{ textAlign: "center" }}>Camera access needed</Text>
          <Text muted style={{ textAlign: "center" }}>
            GateKeep scans ticket QR codes at the door. Grant camera access to start checking guests in.
          </Text>
          <Button
            title={permission.canAskAgain ? "Grant camera access" : "Open Settings to grant access"}
            onPress={() => void requestPermission()}
          />
        </View>
      </View>
    );
  }

  if (result) return <ResultPanel result={result} />;

  return (
    // tokens.dark.bg0 (not a raw hex): a dark backdrop behind the camera
    // preview while it initializes, same "always the dark palette regardless
    // of theme" reasoning PhotoScrim's own header comment documents, DESIGN.md's
    // zero-raw-hex rule has no camera-preview exception the way it does for
    // the QR modules.
    <View style={{ flex: 1, backgroundColor: tokens.dark.bg0 }}>
      <CameraView
        style={StyleSheet.absoluteFill}
        facing="back"
        barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
        onBarcodeScanned={handleScan}
      />
      <View style={StyleSheet.absoluteFill} pointerEvents="none">
        <View style={{ flex: 1 }} />
        <View style={{ flexDirection: "row", height: 240 }}>
          <View style={{ flex: 1 }} />
          <View style={{ width: 240, height: 240, borderWidth: 3, borderColor: t.accent, borderRadius: tokens.radius.card }} />
          <View style={{ flex: 1 }} />
        </View>
        <View style={{ flex: 1.2 }}>
          <PhotoScrim />
          <View style={{ position: "absolute", left: 0, right: 0, bottom: 0, padding: tokens.space.xl, alignItems: "center" }}>
            {/* tokens.dark.text (not a raw hex): PhotoScrim is always the dark
                night gradient in both themes, mirrors GigCard/MusicianBrowse's
                own on-scrim text color convention. */}
            <Text color={tokens.dark.text} style={{ textAlign: "center" }}>
              {busy ? "Checking in…" : "Point the camera at a ticket QR code"}
            </Text>
          </View>
        </View>
      </View>
    </View>
  );
}
