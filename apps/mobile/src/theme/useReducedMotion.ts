import { useEffect, useState } from "react";
import { AccessibilityInfo } from "react-native";

// react-native 0.86.2 (this install) does not export a `useReducedMotion`
// hook, so this falls back to AccessibilityInfo's imperative API: read once
// on mount, then stay live via its change event, per the task's fallback
// clause.
//
// Follow-up (not done here): every consumer mounts its own
// isReduceMotionEnabled() call and change-event subscription. Fine at
// today's scale; if many consumers ever mount at once (a long list),
// consider hoisting this to a single shared subscription (context or
// module-level store) instead of N independent ones.
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    let mounted = true;
    AccessibilityInfo.isReduceMotionEnabled().then((v) => {
      if (mounted) setReduced(v);
    });
    const sub = AccessibilityInfo.addEventListener("reduceMotionChanged", (v) => setReduced(v));
    return () => {
      mounted = false;
      sub.remove();
    };
  }, []);
  return reduced;
}
