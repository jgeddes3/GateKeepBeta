"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { DIALOG_CANCEL_LABEL, DIALOG_CONFIRM_LABEL } from "@gatekeep/shared";
import { Button } from "./button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./dialog";

export type ConfirmOptions = { title: string; body?: string; confirmLabel?: string; destructive?: boolean };

// Task 19 (L70): a hook, not a <ConfirmDialog onConfirm={...}> component.
// Every call site this replaces is an imperative `if (!window.confirm(x))
// return;` inside an async handler; a promise-returning hook keeps that
// exact control flow (the caller still just awaits and early-returns on
// false), so the conversion is mechanical and cannot silently change which
// branch runs. A component driven by an onConfirm prop would instead force
// each handler to be split across a callback boundary, which is the
// restructuring this hook exists to avoid.
export function useConfirm(): { confirm: (opts: ConfirmOptions) => Promise<boolean>; dialog: ReactNode } {
  // `open` and `current` are deliberately separate: nulling the rendered
  // options the instant the dialog closes (fix round 1, finding 1) made
  // Radix's ~200ms exit animation fade out an empty shell instead of the
  // dialog the user just answered. `current` holds the LAST issued options
  // and is only ever replaced by a new confirm() call, never cleared on
  // close, so the closing animation still has real content to fade out.
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState<ConfirmOptions | null>(null);
  const resolveRef = useRef<((value: boolean) => void) | null>(null);

  // Fix round 1, finding 2: a resolver left pending when this hook's owner
  // unmounts (navigated away mid-dialog) would otherwise leak forever,
  // since nothing else can ever call settle() again.
  useEffect(() => () => { resolveRef.current?.(false); resolveRef.current = null; }, []);

  const confirm = (next: ConfirmOptions) => {
    // A still-pending resolver here means a second confirm() fired before
    // the first was ever answered; settle it as a cancellation rather than
    // silently abandoning that caller's promise forever.
    resolveRef.current?.(false);
    setCurrent(next);
    setOpen(true);
    return new Promise<boolean>((resolve) => {
      resolveRef.current = resolve;
    });
  };

  const settle = (value: boolean) => {
    resolveRef.current?.(value);
    resolveRef.current = null;
    setOpen(false);
  };

  const dialog = (
    <Dialog open={open} onOpenChange={(next) => { if (!next) settle(false); }}>
      <DialogContent {...(current?.body ? {} : { "aria-describedby": undefined })}>
        {current && (
          <>
            <DialogHeader>
              <DialogTitle>{current.title}</DialogTitle>
              {current.body && <DialogDescription>{current.body}</DialogDescription>}
            </DialogHeader>
            <DialogFooter>
              <Button type="button" variant="secondary" onClick={() => settle(false)}>
                {DIALOG_CANCEL_LABEL}
              </Button>
              <Button
                type="button"
                variant={current.destructive ? "destructive" : "default"}
                onClick={() => settle(true)}
              >
                {current.confirmLabel ?? DIALOG_CONFIRM_LABEL}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );

  return { confirm, dialog };
}
