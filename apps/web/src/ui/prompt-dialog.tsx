"use client";
import { useRef, useState, type ReactNode } from "react";
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
  const [opts, setOpts] = useState<PromptOptions | null>(null);
  const [value, setValue] = useState("");
  const resolveRef = useRef<((value: string | null) => void) | null>(null);

  const prompt = (next: PromptOptions) => {
    setOpts(next);
    setValue(next.initialValue ?? "");
    return new Promise<string | null>((resolve) => {
      resolveRef.current = resolve;
    });
  };

  const settle = (result: string | null) => {
    resolveRef.current?.(result);
    resolveRef.current = null;
    setOpts(null);
  };

  const submit = () => {
    const trimmed = value.trim();
    settle(trimmed.length > 0 ? trimmed : null);
  };

  const dialog = (
    <Dialog open={opts !== null} onOpenChange={(open) => { if (!open) settle(null); }}>
      <DialogContent>
        {opts && (
          <form onSubmit={(e) => { e.preventDefault(); submit(); }}>
            <DialogHeader>
              <DialogTitle>{opts.title}</DialogTitle>
            </DialogHeader>
            <div className="grid gap-1.5 py-4">
              <label htmlFor="prompt-dialog-input" className="font-sora text-sm font-medium text-gk-text">
                {opts.label}
              </label>
              <Input
                id="prompt-dialog-input"
                autoFocus
                maxLength={opts.maxLength}
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
