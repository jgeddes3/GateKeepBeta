"use client";
import { useLayoutEffect } from "react";
import { usePathname } from "next/navigation";

const STORAGE_KEY = "gk-theme";

// Signed-out marketing routes (spec section 2 / DESIGN.md: "dark is the
// brand default for signed-out marketing pages"). Kept as a literal Set
// here, separate from the equivalent string check in layout.tsx's
// pre-hydration script (that script can't import a shared module, since
// it's serialized to a plain string for dangerouslySetInnerHTML): both
// lists need to move together if a fourth marketing route is ever added.
const MARKETING_ROUTES = new Set(["/", "/terms", "/privacy"]);

// Post-review fix: keeps html[data-theme] correct across CLIENT-SIDE route
// transitions too, not just the first document load. layout.tsx's
// pre-hydration script only runs once, before the very first paint of a
// fresh document; it can't react to a Next <Link> navigation, which
// doesn't reload the document. Without this, a signed-out visitor who
// lands on a marketing route (stamped dark, no stored preference) and then
// client-navigates to a non-marketing route (e.g. clicking a hero CTA to
// /sign-in) would carry that forced-dark attribute onto a page that should
// follow the visitor's system preference instead, since nothing else ever
// clears it once set.
//
// No-ops whenever an explicit choice is stored (ThemeToggle writes
// "light"/"dark" directly, and its own effect keeps <html> in sync
// whenever it's mounted): an explicit choice must win on every route, this
// component only ever touches the attribute in its absence. Mounted once,
// unconditionally, in layout.tsx (outside AppShell's shell/non-shell
// branch) so it runs on every route, including the ones with no
// ThemeToggle in the DOM to otherwise correct this (marketing pages don't
// render one; DESIGN.md's spec puts it only in the signed-in shell's
// account menu).
export function MarketingThemeDefault() {
  const pathname = usePathname();
  useLayoutEffect(() => {
    let stored: string | null = null;
    try {
      stored = window.localStorage.getItem(STORAGE_KEY);
    } catch {
      // Storage can throw in a locked-down browser context; treat as
      // "no explicit choice" the same way the pre-hydration script does.
    }
    if (stored === "light" || stored === "dark") return;
    if (MARKETING_ROUTES.has(pathname)) {
      document.documentElement.setAttribute("data-theme", "dark");
    } else {
      document.documentElement.removeAttribute("data-theme");
    }
  }, [pathname]);
  return null;
}
