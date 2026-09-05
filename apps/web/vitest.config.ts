import { defineConfig } from "vitest/config";
// Sub-project 11 task 7: the two well-known route handlers are plain modules
// (no JSX, no app-router request context), so their 404-when-unset behaviour
// is unit-testable the same way src/**/*.test.ts already covers plain
// modules; the include list widens to admit their co-located route.test.ts
// files without pulling in anything else under app/ (nothing else there is
// a plain, non-component module worth this same treatment yet).
export default defineConfig({
  test: { environment: "node", include: ["src/**/*.test.ts", "app/well-known/**/*.test.ts"] },
});
