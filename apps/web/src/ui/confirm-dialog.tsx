"use client";
import { useRef, useState, type ReactNode } from "react";
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
  const [opts, setOpts] = useState<ConfirmOptions | null>(null);
  const resolveRef = useRef<((value: boolean) => void) | null>(null);

  const confirm = (next: ConfirmOptions) => {
    setOpts(next);
    return new Promise<boolean>((resolve) => {
      resolveRef.current = resolve;
    });
  };

  const settle = (value: boolean) => {
    resolveRef.current?.(value);
    resolveRef.current = null;
    setOpts(null);
  };

  const dialog = (
    <Dialog open={opts !== null} onOpenChange={(open) => { if (!open) settle(false); }}>
      <DialogContent>
        {opts && (
          <>
            <DialogHeader>
              <DialogTitle>{opts.title}</DialogTitle>
              {opts.body && <DialogDescription>{opts.body}</DialogDescription>}
            </DialogHeader>
            <DialogFooter>
              <Button type="button" variant="secondary" onClick={() => settle(false)}>
                {DIALOG_CANCEL_LABEL}
              </Button>
              <Button
                type="button"
                variant={opts.destructive ? "destructive" : "default"}
                onClick={() => settle(true)}
              >
                {opts.confirmLabel ?? DIALOG_CONFIRM_LABEL}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );

  return { confirm, dialog };
}
