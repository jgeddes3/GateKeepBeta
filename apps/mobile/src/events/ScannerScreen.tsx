import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Linking, Pressable, StyleSheet, View } from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import { FunctionsError } from "firebase/functions";
import { TICKET_ALREADY_CHECKED_IN_MESSAGE, SCANNER_OFFLINE_MESSAGE } from "@gatekeep/shared";
import { callFn } from "../lib/callable";
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
  | { kind: "invalid"; message: string }
  // Transport or server failure, NOT a ticket verdict (sp6 audit finding 3):
  // the door must never turn a fan away over venue Wi-Fi.
  | { kind: "offline" };

// The three codes checkInTicket uses for a verdict ABOUT THE TICKET (or the
// caller's right to scan it). Everything else, unavailable, deadline-exceeded,
// internal, a plain fetch failure that is not even a FunctionsError, is the
// network or the server, and renders the neutral offline panel.
const VERDICT_CODES = new Set(["functions/failed-precondition", "functions/not-found", "functions/permission-denied"]);

// A FunctionsError's `details` (checkInTicket's original checkedInAt on a
// duplicate scan, see functions/src/ticketing.ts's own comment on why it
// rides in details rather than the message) IS part of firebase/functions'
// public types (`FunctionsError extends FirebaseError` with a public
// `readonly details?: unknown`, exported from @firebase/functions'
// functions-public.d.ts, the package's declared `types` entry point).
// `instanceof FunctionsError` is the precise, typed way to read it.
function errorDetails(e: unknown): { checkedInAt?: number } | undefined {
  return e instanceof FunctionsError ? (e.details as { checkedInAt?: number } | undefined) : undefined;
}

function ResultPanel({ result, onDismiss }: { result: ScanResult; onDismiss: () => void }) {
  const t = useTokens();
  const tone = result.kind === "success" ? "success" : result.kind === "offline" ? "neutral" : "destructive";
  const toneColor = result.kind === "success" ? t.success : result.kind === "offline" ? t.muted : t.destructive;
  // Success clears itself; the other three wait for a tap so the staffer
  // can actually read the verdict (the old 1.5 s clear on "Not valid" was
  // gone before anyone could).
  const sticky = result.kind !== "success";
  return (
    <Pressable
      onPress={sticky ? onDismiss : undefined}
      disabled={!sticky}
      accessibilityRole={sticky ? "button" : undefined}
      accessibilityLabel={sticky ? "Scan the next ticket" : undefined}
      style={{ flex: 1 }}
    >
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
          {result.kind === "offline" && (
            <View style={{ alignItems: "center", gap: 4 }}>
              <Text variant="heading" color={toneColor} style={{ textAlign: "center" }}>{SCANNER_OFFLINE_MESSAGE}</Text>
              <Text muted style={{ textAlign: "center" }}>
                This is a connection problem, not a verdict on the ticket. Check the venue Wi-Fi and scan it again.
              </Text>
            </View>
          )}
          {sticky && <Text variant="meta" muted style={{ marginTop: tokens.space.md }}>Tap anywhere to scan the next ticket</Text>}
        </Callout>
      </View>
    </Pressable>
  );
}

export function ScannerScreen({ curatorProfileId, eventId }: { curatorProfileId: string; eventId: string }) {
  const t = useTokens();
  const [permission, requestPermission] = useCameraPermissions();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ScanResult | null>(null);
  // Fix round 1 (code review, Important): expo-camera fires
  // `onBarcodeScanned` per analyzed frame on both platforms, so a queued
  // burst of callbacks can all read the SAME stale `busy`/`result` state
  // before any of them commits a re-render (React state reads are a
  // closure snapshot, not synchronous). A plain `useRef` boolean sidesteps
  // that: reading and writing `.current` is synchronous and happens
  // immediately in the handler, so the SECOND frame in a burst already sees
  // the lock the first one just set, before either has a chance to call
  // checkInTicket twice (the hazard: two in-flight calls racing to set
  // `result`, where a legitimate first "success" can be overwritten by a
  // second call's "duplicate", flashing the wrong state at the door). The
  // `busy`/`result` STATE stays exactly as before for rendering only
  // (spinner text, which panel to show); the ref is the sole gate on
  // whether a decode is allowed to proceed.
  const scanLockRef = useRef(false);

  // Auto-ready for the next scan 1.5 s after a SUCCESS (brief's own anatomy).
  // Duplicate, invalid, and offline stay until the staffer taps the panel
  // (dismiss below), which is also where the scan lock re-arms for them.
  useEffect(() => {
    if (!result || result.kind !== "success") return;
    const timer = setTimeout(() => {
      setResult(null);
      scanLockRef.current = false;
    }, 1500);
    return () => clearTimeout(timer);
  }, [result]);
  const dismiss = () => {
    setResult(null);
    scanLockRef.current = false;
  };

  // The CameraView itself also unmounts while `result` is showing (see the
  // branch below), so no further decode events can even fire once a result
  // lands; `scanLockRef` is what closes the window BEFORE that, between the
  // first frame of a burst locking and the camera actually unmounting.
  const handleScan = ({ data }: { data: string }) => {
    if (scanLockRef.current) return;
    scanLockRef.current = true;
    const payload = parseQrPayload(data);
    if (!payload || payload.eventId !== eventId) {
      setResult({ kind: "invalid", message: "This QR code isn't a ticket for this event." });
      return;
    }
    setBusy(true);
    callFn<CheckInTicketInput, CheckInTicketResult>("checkInTicket", {
      curatorProfileId, eventId, ticketId: payload.ticketId, qrSecret: payload.qrSecret,
    })
      .then(({ data: res }) => setResult({ kind: "success", ownerName: res.ownerName, tierName: res.tierName }))
      .catch((e: unknown) => {
        // A verdict is one of three codes checkInTicket throws about the
        // ticket itself; anything else is the network or the server and gets
        // the neutral offline panel, never the destructive "Not valid" one.
        if (!(e instanceof FunctionsError) || !VERDICT_CODES.has(e.code)) {
          setResult({ kind: "offline" });
          return;
        }
        if (e.message === TICKET_ALREADY_CHECKED_IN_MESSAGE) {
          setResult({ kind: "duplicate", checkedInAt: errorDetails(e)?.checkedInAt });
        } else {
          // TICKET_NOT_VALID_MESSAGE and every other ticket-verdict rejection
          // (event not published, ticket not found) share this same
          // destructive "invalid" bucket: none has a useful interactive
          // follow-up from a door scan, matching AttendeeList's own
          // "verbatim server error in a friendly wrapper" convention.
          setResult({ kind: "invalid", message: e.message });
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
          {/* Fix round 1 (code review, Important): once canAskAgain is
              false (permanently denied, e.g. after "Don't ask again"), the
              OS permission dialog itself is gone for good, requestPermission()
              is a silent no-op in that state. The button must fall through
              to the Settings app instead (same Linking.openURL precedent as
              TicketDetail.tsx's map link, here openSettings()). */}
          <Button
            title={permission.canAskAgain ? "Grant camera access" : "Open Settings to grant access"}
            onPress={() => void (permission.canAskAgain ? requestPermission() : Linking.openSettings())}
          />
        </View>
      </View>
    );
  }

  if (result) return <ResultPanel result={result} onDismiss={dismiss} />;

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
