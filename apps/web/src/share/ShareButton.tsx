"use client";
import { useEffect, useRef, useState } from "react";
import { SHARE_LINK_COPIED_MESSAGE } from "@gatekeep/shared";
import { Button } from "../ui/button";
import { IconShare } from "../ui/icons";
import { getSiteUrl } from "../seo/siteUrl";

// Sub-project 11 (spec section 3.1): the one shared web share affordance,
// mounted on the public event page and both public profile pages. Mobile
// gets its own React Native version in Task 12, same env-driven link shape.
//
// The absolute URL is built INSIDE the click handler, never during render:
// eslint-config-next's React Compiler purity rule forbids an impure call
// (window.location.origin included) textually inside a component's render,
// the same constraint app/e/[eventId]/page.tsx's own `now` comment already
// works around for this codebase. getSiteUrl()'s Vercel branch reads a
// server-only env var that is always undefined in the browser, so
// window.location.origin is the real fallback on the client, which is
// exactly the spec's "always the web URL" rule (spec 3.1).
export function ShareButton({ path, title }: { path: string; title: string }) {
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
    };
  }, []);

  const onClick = async () => {
    const url = `${getSiteUrl() ?? window.location.origin}${path}`;
    if (typeof navigator !== "undefined" && typeof navigator.share === "function") {
      try {
        await navigator.share({ title, url });
      } catch (e) {
        // AbortError = the user dismissed the native share sheet, not a
        // failure: swallowed. Anything else is a genuine, if rare, share
        // failure (no share target installed, permission denied); logged
        // rather than silently dropped, same "auxiliary content shouldn't
        // fail loudly to the user but a real bug shouldn't vanish either"
        // tradeoff as storageUrl in app/u/[handle]/page.tsx.
        if (e instanceof Error && e.name === "AbortError") return;
        console.warn("navigator.share failed", e);
      }
      return;
    }
    await navigator.clipboard.writeText(url);
    // Clear any timer a rapid double click already started (the deferred
    // SaveSearchButton finding in docs/superpowers/sp8-rulings.md, applied
    // here so a stale timer can never flip `copied` back to false early).
    if (copiedTimer.current) clearTimeout(copiedTimer.current);
    setCopied(true);
    copiedTimer.current = setTimeout(() => setCopied(false), 2000);
  };

  return (
    <Button
      type="button"
      variant="secondary"
      size="sm"
      onClick={() => void onClick()}
      // Static, not conditional: a live region has to exist in the DOM
      // BEFORE its content changes for a screen reader to announce the
      // change. Added at the same moment as the new label, it usually
      // announces nothing at all.
      aria-live="polite"
    >
      <IconShare size={16} aria-hidden="true" />
      {copied ? SHARE_LINK_COPIED_MESSAGE : "Share"}
    </Button>
  );
}
