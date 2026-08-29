import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useColorScheme } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SplashScreen from "expo-splash-screen";
import { tokens, type GkTokens } from "./tokens";

type ThemeChoice = "light" | "dark" | "system";
const KEY = "gk-theme";

interface Ctx {
  t: GkTokens;               // active token set (readonly fields, see tokens.ts)
  active: "light" | "dark";  // resolved theme
  choice: ThemeChoice;
  setChoice: (c: ThemeChoice) => void;
}
const ThemeCtx = createContext<Ctx | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const system = useColorScheme(); // "light" | "dark" | null
  const [choice, setChoiceState] = useState<ThemeChoice>("system");
  const [ready, setReady] = useState(false);

  useEffect(() => {
    AsyncStorage.getItem(KEY)
      .then((v) => {
        if (v === "light" || v === "dark") setChoiceState(v);
      })
      .catch(() => {
        // A rejected read (storage unavailable, corrupted, etc.) falls back
        // to the system/dark default below instead of leaving `ready` false
        // forever, which would otherwise brick the app on a permanent blank
        // screen (ThemeProvider renders null while !ready).
      })
      .finally(() => setReady(true));
  }, []);

  // _layout.tsx calls SplashScreen.preventAutoHideAsync() and only mounts
  // this provider once fonts have loaded; hiding the splash here, gated on
  // `ready`, means it stays up until BOTH fonts and the stored theme choice
  // have resolved, so the first frame ever shown already has the right font
  // and the right theme (no system-font or wrong-theme flash in between).
  useEffect(() => {
    if (ready) SplashScreen.hideAsync().catch(() => {});
  }, [ready]);

  const setChoice = useCallback((c: ThemeChoice) => {
    setChoiceState(c);
    if (c === "system") AsyncStorage.removeItem(KEY);
    else AsyncStorage.setItem(KEY, c);
  }, []);

  // Dark is the brand default when system is unknown (DESIGN.md).
  const active: "light" | "dark" =
    choice === "system" ? (system === "light" ? "light" : "dark") : choice;
  const t = active === "light" ? tokens.light : tokens.dark;

  // Memoized: this context is read by every themed screen (30+ once the ui
  // sweep lands), so a new object identity on every render of ThemeProvider
  // (e.g. from an unrelated parent re-render) would cascade re-renders down
  // the whole tree.
  const value = useMemo<Ctx>(() => ({ t, active, choice, setChoice }), [t, active, choice, setChoice]);

  if (!ready) return null; // avoids a first-paint flash of the wrong theme
  return <ThemeCtx.Provider value={value}>{children}</ThemeCtx.Provider>;
}

export function useTokens(): GkTokens {
  const c = useContext(ThemeCtx);
  if (!c) throw new Error("useTokens must be used inside ThemeProvider");
  return c.t;
}
export function useThemeChoice() {
  const c = useContext(ThemeCtx);
  if (!c) throw new Error("useThemeChoice must be used inside ThemeProvider");
  return { choice: c.choice, active: c.active, setChoice: c.setChoice };
}
