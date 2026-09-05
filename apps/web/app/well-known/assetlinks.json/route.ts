// SP11 (spec section 3.1): the Android app-link claim file, served at
// /.well-known/assetlinks.json through the rewrite pair in next.config.ts.
// Same request-time, env-gated shape as the AASA handler next to this file:
// every value is read at REQUEST time from server-only env (never
// NEXT_PUBLIC), and a missing value returns 404 rather than a half-filled
// claim, which is what would break link verification for a whole domain.
export const dynamic = "force-dynamic";

export function GET(): Response {
  const pkg = process.env.ANDROID_PACKAGE;
  const fingerprint = process.env.ANDROID_CERT_SHA256;
  if (!pkg || !fingerprint) return new Response("Not found", { status: 404 });
  const body = [{
    relation: ["delegate_permission/common.handle_all_urls"],
    target: { namespace: "android_app", package_name: pkg, sha256_cert_fingerprints: [fingerprint] },
  }];
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=300" },
  });
}
