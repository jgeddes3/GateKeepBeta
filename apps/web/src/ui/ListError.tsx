"use client";
import { Button } from "./button";
import { IconWarning } from "./icons";

// SP12 follow-on (audit #10). The house shape for "this list failed to
// load": the branded warning line plus one Retry, modelled on
// src/payments/EarningsPanel.tsx's own precedent. Every onSnapshot in
// apps/web now has an error callback that sets an "error" sentinel, and
// every one of those sentinels renders THIS, so the failure state cannot
// drift into a dozen shapes.
export function ListError({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center gap-3 rounded-gk border border-gk-warning/40 bg-gk-warning/14 px-3.5 py-2.5 font-sora text-sm text-gk-warning"
    >
      <IconWarning size={16} className="shrink-0" aria-hidden="true" />
      <span className="min-w-0 flex-1">{message}</span>
      {onRetry && <Button type="button" size="sm" variant="secondary" onClick={onRetry}>Retry</Button>}
    </div>
  );
}
