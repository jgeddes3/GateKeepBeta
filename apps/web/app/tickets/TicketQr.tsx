"use client";
import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";

// Sub-project 6 task 10 (brief anatomy: "QR (rendered with qrcode from
// {ticketId, eventId, qrSecret} JSON)"). Renders entirely client-side, no
// network fetch of any kind: `qrcode`'s toCanvas draws directly onto a
// <canvas> from the JSON payload the door scanner (SP6 Task 8's
// checkInTicket, mobile-side) expects. Possession of qrSecret is door proof
// (TicketDoc's own doc comment); this component's only job is to put that
// secret in front of the ticket's owner as a scannable code, never to
// validate it.
//
// Static dark-on-light regardless of site theme (controller ruling 7,
// verbatim): a QR code's own light/dark modules ARE its data, so this never
// follows --gk-bg/--gk-text the way ordinary content does. A real black
// module on a real white background is what scanners are tuned for; a
// gk-token-driven code would silently degrade scan reliability in dark
// theme for zero visual benefit (nobody reads a QR code as decoration).
const QR_DARK = "#0A0A0A";
const QR_LIGHT = "#FFFFFF";

export function TicketQr({ ticketId, eventId, qrSecret, size = 220 }: {
  ticketId: string; eventId: string; qrSecret: string; size?: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let cancelled = false;
    const payload = JSON.stringify({ ticketId, eventId, qrSecret });
    QRCode.toCanvas(canvas, payload, {
      width: size, margin: 1, errorCorrectionLevel: "M",
      color: { dark: QR_DARK, light: QR_LIGHT },
    }).catch((e) => {
      if (!cancelled) { setError(true); console.error("TicketQr: render failed", ticketId, e); }
    });
    return () => { cancelled = true; };
  }, [ticketId, eventId, qrSecret, size]);

  if (error) {
    return (
      <p className="font-sora text-xs text-gk-muted" role="alert">
        Couldn&apos;t render this ticket&apos;s QR code. Refresh to try again.
      </p>
    );
  }
  return (
    // The white padding card is deliberate (not decoration): a QR code
    // needs a light quiet-zone margin around it to scan reliably, and
    // dark theme's page background would otherwise sit flush against the
    // code's own white modules with no border between them.
    <div className="inline-flex rounded-gk-sm bg-white p-3" style={{ width: size + 24, height: size + 24 }}>
      <canvas ref={canvasRef} width={size} height={size} aria-label="Ticket QR code" />
    </div>
  );
}
