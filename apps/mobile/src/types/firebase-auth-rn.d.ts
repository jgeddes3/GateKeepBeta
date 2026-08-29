// `@firebase/auth`'s package.json "exports" map lists a top-level "types" condition ahead of
// (i.e. shadowing) the "react-native" condition branch, so tsc always resolves imports from
// "@firebase/auth" to the browser type surface (dist/auth-public.d.ts) and never sees
// `getReactNativePersistence`, even with `customConditions: ["react-native"]` set (expo's
// tsconfig.base already sets this). Metro's *runtime* resolution is unaffected: it correctly
// picks the "react-native" condition and the symbol exists there at bundle time. This augments
// the module's types to match what's actually exported at runtime.
// Verified against @firebase/auth/dist/rn/src/platform_react_native/persistence/react_native.d.ts
// Upstream issue: https://github.com/firebase/firebase-js-sdk/issues/7020
import type { Persistence } from "firebase/auth";
import type AsyncStorage from "@react-native-async-storage/async-storage";

declare module "@firebase/auth" {
  export function getReactNativePersistence(
    storage: typeof AsyncStorage,
  ): Persistence;
}
