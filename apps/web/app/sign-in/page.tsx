import { SignInForm } from "./SignInForm";

// Sub-project 6 task 9: a thin Server Component wrapper around SignInForm
// (the actual "use client" form, moved to its own file unchanged). Reads
// the `next` query param via the Page `searchParams` prop rather than
// SignInForm calling useSearchParams() itself: the Next.js docs' own
// recommended shape for this exact case ("You can also pass the Page
// searchParams prop directly to a Client Component") avoids a Suspense
// boundary and an extra client-only render pass for one query param.
//
// isSafeNext guards against an open-redirect: `next` only ever comes from a
// URL a visitor (or this app's own links, e.g. BuyTicketsFlow's sign-in
// gate) controls, so it must be a same-origin relative path, never an
// absolute URL or a protocol-relative "//host" one (which a browser
// resolves as absolute too).
function isSafeNext(raw: string | string[] | undefined): string | null {
  const next = Array.isArray(raw) ? raw[0] : raw;
  if (!next || !next.startsWith("/") || next.startsWith("//")) return null;
  return next;
}

export default async function SignInPage(props: PageProps<"/sign-in">) {
  const searchParams = await props.searchParams;
  return <SignInForm next={isSafeNext(searchParams.next)} />;
}
