import type { Metadata } from "next";
import { Syne, Sora } from "next/font/google";
import "./globals.css";
import { AuthProvider } from "../src/auth/AuthProvider";
import { AppShell } from "../src/shell/AppShell";
import { MarketingThemeDefault } from "../src/shell/MarketingThemeDefault";

const syne = Syne({
  variable: "--font-syne",
  subsets: ["latin"],
  weight: ["600", "700", "800"],
});

const sora = Sora({
  variable: "--font-sora",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
});

// Reads the user's saved theme choice before the browser paints, so there is
// no flash of the wrong theme on load. An explicit stored choice always
// wins, everywhere: "light"/"dark" stamps that attribute regardless of
// route. See node_modules/next/dist/docs/01-app/02-guides/
// preventing-flash-before-hydration.md, "Themes".
//
// Post-review fix: with NO stored choice, signed-in routes still leave no
// attribute (globals.css's prefers-color-scheme media query decides, per
// the existing "system default" behavior). Signed-out marketing routes
// (/, /terms, /privacy) are the one exception: spec section 2 and
// DESIGN.md both say dark is the brand default there ("dark is the brand
// default for signed-out marketing pages"), not the visitor's OS
// preference, so with no stored choice those three routes stamp
// data-theme="dark" on <html> itself. Stamping the root (not just a
// subtree, the way HeroCarousel forces dark on its own always-dark-photo
// section) is required so body's gk-page background and every below-fold
// section on these routes also resolve dark at the document edges, not
// just the hero. This script only runs once, on the very first paint of a
// fresh document load: it can't react to a later client-side <Link>
// transition (Next doesn't reload the document for those). That's what
// MarketingThemeDefault (mounted below, in <body>) is for: it re-applies
// this exact route/stored-choice logic on every pathname change too, so
// the attribute stays correct navigating between a marketing route and a
// non-marketing one without a full reload in either direction.
const themeScript = `(function(){try{
  var t=localStorage.getItem("gk-theme");
  if(t==="light"||t==="dark"){document.documentElement.setAttribute("data-theme",t);return}
  var p=window.location.pathname;
  if(p==="/"||p==="/terms"||p==="/privacy"){document.documentElement.setAttribute("data-theme","dark")}
}catch(e){}})()`;

// NEXT_PUBLIC_SITE_URL is the explicit override (set it once a production
// domain exists); VERCEL_PROJECT_PRODUCTION_URL is Vercel's own env var,
// available automatically on Vercel deployments without any config. If
// neither is set, metadataBase is omitted entirely rather than falling back
// to a localhost URL. A missing canonical/og:url is invisible, but a
// canonical link pointing at http://localhost:3000 would ship broken SEO/
// share metadata into production.
const siteUrl = process.env.NEXT_PUBLIC_SITE_URL
  ?? (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : undefined);

export const metadata: Metadata = {
  ...(siteUrl ? { metadataBase: new URL(siteUrl) } : {}),
  title: "GateKeep",
  description: "Find the music. Book the night.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${syne.variable} ${sora.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>
        <MarketingThemeDefault />
        <AuthProvider>
          <AppShell>{children}</AppShell>
        </AuthProvider>
      </body>
    </html>
  );
}
