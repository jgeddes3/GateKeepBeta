"use client";

import { useLayoutEffect, useSyncExternalStore, type ComponentType } from "react";
import { IconMonitor, IconMoon, IconSun, type IconProps } from "../ui/icons";

export type ThemeChoice = "system" | "light" | "dark";

const STORAGE_KEY = "gk-theme";
const CHANGE_EVENT = "gk-theme-change";
const CYCLE: readonly ThemeChoice[] = ["system", "light", "dark"];

const THEME_META: Record<ThemeChoice, { label: string; icon: ComponentType<IconProps> }> = {
  system: { label: "System", icon: IconMonitor },
  light: { label: "Light", icon: IconSun },
  dark: { label: "Dark", icon: IconMoon },
};

// Client-only: React never calls this during server rendering, so no
// window guard is needed (useSyncExternalStore uses getServerSnapshot
// below for that render instead).
function getSnapshot(): ThemeChoice {
  const stored = window.localStorage.getItem(STORAGE_KEY);
  return stored === "light" || stored === "dark" ? stored : "system";
}

function getServerSnapshot(): ThemeChoice {
  return "system";
}

// Cross-tab updates arrive as native "storage" events; same-tab updates
// (this component's own click handler, or a second ThemeToggle instance)
// are broadcast on the custom event below, since "storage" only fires in
// OTHER tabs, never the tab that made the write.
function subscribe(onStoreChange: () => void) {
  window.addEventListener("storage", onStoreChange);
  window.addEventListener(CHANGE_EVENT, onStoreChange);
  return () => {
    window.removeEventListener("storage", onStoreChange);
    window.removeEventListener(CHANGE_EVENT, onStoreChange);
  };
}

function writeTheme(theme: ThemeChoice) {
  if (theme === "system") {
    window.localStorage.removeItem(STORAGE_KEY);
  } else {
    window.localStorage.setItem(STORAGE_KEY, theme);
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

/**
 * Three-state theme cycle button: System, Light, Dark. Persists the choice
 * to localStorage.gk-theme (System clears the key) and keeps data-theme on
 * <html> in sync. The pre-hydration script in layout.tsx reads the same
 * key before first paint, so there is no flash of the wrong theme on load;
 * useSyncExternalStore (with a fixed "system" server snapshot) is what
 * keeps this component's own render free of hydration mismatches.
 */
export function ThemeToggle() {
  const theme = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  // Keeps <html data-theme> in sync with the resolved theme. Belt and
  // suspenders alongside the pre-hydration script: also re-applies the
  // attribute after React Strict Mode's dev-only remount, which resets
  // <html> to only the attributes it manages from JSX and would otherwise
  // clear the one the inline script set. See node_modules/next/dist/docs/
  // 01-app/02-guides/preventing-flash-before-hydration.md, "Re-applying
  // attributes in development". This effect only calls a DOM method
  // (setAttribute/removeAttribute), never setState, so it stays outside
  // the react-hooks set-state-in-effect rule.
  useLayoutEffect(() => {
    if (theme === "system") {
      document.documentElement.removeAttribute("data-theme");
    } else {
      document.documentElement.setAttribute("data-theme", theme);
    }
  }, [theme]);

  const next = CYCLE[(CYCLE.indexOf(theme) + 1) % CYCLE.length];
  const current = THEME_META[theme];
  const CurrentIcon = current.icon;

  function handleClick() {
    writeTheme(next);
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      aria-label={`Theme: ${current.label}. Switch to ${THEME_META[next].label}.`}
      title={`Theme: ${current.label}`}
      className="flex w-full items-center gap-2 rounded-gk-sm px-2 py-1.5 text-left font-sora text-sm text-gk-text outline-none hover:bg-gk-border/40 focus-visible:ring-2 focus-visible:ring-gk-focus"
    >
      <CurrentIcon size={16} className="text-gk-muted" aria-hidden="true" />
      <span>Theme: {current.label}</span>
    </button>
  );
}
