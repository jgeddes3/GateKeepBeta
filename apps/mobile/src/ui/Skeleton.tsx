// MOTION 1 shimmer (DESIGN.md); pauses (renders static) under reduced motion.
import { useEffect, useState } from "react";
import { AccessibilityInfo, Animated, View, type DimensionValue } from "react-native";
import { tokens } from "../theme/tokens";
import { useTokens } from "../theme/ThemeProvider";

// react-native 0.86.2 (this install) does not export a `useReducedMotion`
// hook, so this falls back to AccessibilityInfo's imperative API: read once
// on mount, then stay live via its change event, per the task's fallback
// clause.
//
// Follow-up (not done here): every Skeleton mounts its own
// isReduceMotionEnabled() call and change-event subscription. Fine at
// today's scale; if a screen ever renders many Skeletons at once (a long
// list), consider hoisting this to a single shared subscription (context or
// module-level store) instead of N independent ones.
function useReducedMotion(): boolean {
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

export function Skeleton({
  width = "100%",
  height = 16,
  radius = tokens.radius.sm,
}: {
  width?: DimensionValue;
  height?: number;
  radius?: number;
}) {
  const t = useTokens();
  const reduced = useReducedMotion();
  // useState (not useRef().current) for the stable Animated.Value instance:
  // eslint-plugin-react-hooks's `refs` rule flags any `.current` read during
  // render, including the common useRef-lazy-init idiom. A useState
  // initializer gives the same one-time, referentially-stable value without
  // touching a ref.
  const [a] = useState(() => new Animated.Value(0.5));
  useEffect(() => {
    if (reduced) return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(a, { toValue: 1, duration: 900, useNativeDriver: true }),
        Animated.timing(a, { toValue: 0.5, duration: 900, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [reduced, a]);
  return (
    <Animated.View
      style={{
        width,
        height,
        borderRadius: radius,
        backgroundColor: t.border,
        opacity: reduced ? 0.6 : a,
      }}
    />
  );
}

// A card-shaped skeleton for list screens.
export function SkeletonCard() {
  const t = useTokens();
  return (
    <View
      style={{
        backgroundColor: t.surface,
        borderColor: t.border,
        borderWidth: 1,
        borderRadius: tokens.radius.card,
        padding: tokens.space.lg,
        gap: 10,
      }}
    >
      <Skeleton height={20} width="60%" />
      <Skeleton height={14} width="90%" />
      <Skeleton height={14} width="40%" />
    </View>
  );
}
