// SP11 (spec section 3.1): the iOS universal-link claim file, served at
// /.well-known/apple-app-site-association through the rewrite pair in
// next.config.ts. Every value is read at REQUEST time from server-only env
// (never NEXT_PUBLIC: this file must not be inlined into a client bundle),
// and a missing value returns 404 rather than a half-filled claim, which is
// what would break link verification for a whole domain.
export const dynamic = "force-dynamic";

export function GET(): Response {
  const teamId = process.env.APPLE_TEAM_ID;
  const bundleId = process.env.IOS_BUNDLE_ID;
  if (!teamId || !bundleId) return new Response("Not found", { status: 404 });
  const body = {
    applinks: {
      details: [{
        appIDs: [`${teamId}.${bundleId}`],
        components: [{ "/": "/e/*" }, { "/": "/u/*" }],
      }],
    },
  };
  // Apple fetches this file without an extension and expects JSON content
  // type regardless (spec 3.1's binding note): no Content-Disposition, no
  // charset suffix, so the response is exactly what Response's default
  // header would NOT give a plain string body.
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=300" },
  });
}
