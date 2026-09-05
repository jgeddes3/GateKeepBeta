"use client";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { DIALOG_CANCEL_LABEL, DIALOG_CONFIRM_LABEL } from "@gatekeep/shared";
import { Button } from "./button";
import { Input } from "./input";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "./dialog";

export type PromptOptions = { title: string; label: string; initialValue?: string; maxLength?: number };

// Task 19 (L70): same imperative-hook shape as useConfirm (see its comment)
// for the same reason, a promise-returning hook keeps every
// `window.prompt(...)?.trim()` call site's control flow unchanged. Wrapped
// in a form so Enter confirms, same as a native prompt.
export function usePrompt(): { prompt: (opts: PromptOptions) => Promise<string | null>; dialog: ReactNode } {
  // See useConfirm's identical comment: `open` and `current` are separate
  // so the exit animation still has the last issued options to render
  // instead of fading out an empty shell (fix round 1, finding 1).
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState<PromptOptions | null>(null);
  const [value, setValue] = useState("");
  const resolveRef = useRef<((value: string | null) => void) | null>(null);
  // A real per-instance id (fix round 1, finding 6), not a hardcoded
  // literal: two usePrompt() instances mounted at once would otherwise
  // collide on the same input id.
  const inputId = useId();

  // Fix round 1, finding 2: same unmount-leak guard as useConfirm.
  useEffect(() => () => { resolveRef.current?.(null); resolveRef.current = null; }, []);

  const prompt = (next: PromptOptions) => {
    // A still-pending resolver means a second prompt() fired before the
    // first was ever answered; settle it as a cancellation rather than
    // abandoning that caller's promise forever.
    resolveRef.current?.(null);
    setCurrent(next);
    setValue(next.initialValue ?? "");
    setOpen(true);
    return new Promise<string | null>((resolve) => {
      resolveRef.current = resolve;
    });
  };

  const settle = (result: string | null) => {
    resolveRef.current?.(result);
    resolveRef.current = null;
    setOpen(false);
  };

  const submit = () => {
    const trimmed = value.trim();
    settle(trimmed.length > 0 ? trimmed : null);
  };

  const dialog = (
    <Dialog open={open} onOpenChange={(next) => { if (!next) settle(null); }}>
      <DialogContent aria-describedby={undefined}>
        {current && (
          <form onSubmit={(e) => { e.preventDefault(); submit(); }}>
            <DialogHeader>
              <DialogTitle>{current.title}</DialogTitle>
            </DialogHeader>
            <div className="grid gap-1.5 py-4">
              <label htmlFor={inputId} className="font-sora text-sm font-medium text-gk-text">
                {current.label}
              </label>
              <Input
                id={inputId}
                autoFocus
                maxLength={current.maxLength}
                value={value}
                onChange={(e) => setValue(e.target.value)}
              />
            </div>
            <DialogFooter>
              <Button type="button" variant="secondary" onClick={() => settle(null)}>
                {DIALOG_CANCEL_LABEL}
              </Button>
              <Button type="submit">{DIALOG_CONFIRM_LABEL}</Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );

  return { prompt, dialog };
}
