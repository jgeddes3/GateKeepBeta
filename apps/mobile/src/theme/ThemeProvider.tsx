import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { useColorScheme } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { tokens, type GkTokens } from "./tokens";

type ThemeChoice = "light" | "dark" | "system";
const KEY = "gk-theme";

interface Ctx {
  t: GkTokens;               // active token set
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
    AsyncStorage.getItem(KEY).then((v) => {
      if (v === "light" || v === "dark") setChoiceState(v);
      setReady(true);
    });
  }, []);

  const setChoice = (c: ThemeChoice) => {
    setChoiceState(c);
    if (c === "system") AsyncStorage.removeItem(KEY);
    else AsyncStorage.setItem(KEY, c);
  };

  // Dark is the brand default when system is unknown (DESIGN.md).
  const active: "light" | "dark" =
    choice === "system" ? (system === "light" ? "light" : "dark") : choice;
  const t = active === "light" ? tokens.light : tokens.dark;

  if (!ready) return null; // avoids a first-paint flash of the wrong theme
  return <ThemeCtx.Provider value={{ t, active, choice, setChoice }}>{children}</ThemeCtx.Provider>;
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
