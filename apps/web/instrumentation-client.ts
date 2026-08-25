// Client-side crash reporting (Next.js instrumentation-client convention, App Router).
// No-op until NEXT_PUBLIC_SENTRY_DSN is set (see README manual follow-ups) — no
// account exists yet, so this stays inert by default in every environment.
import * as Sentry from "@sentry/nextjs";

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    tracesSampleRate: 0,
  });
}
