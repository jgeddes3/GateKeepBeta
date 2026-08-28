import type { Metadata } from "next";
import { Syne, Sora } from "next/font/google";
import "./globals.css";
import { AuthProvider } from "../src/auth/AuthProvider";
import { AppShell } from "../src/shell/AppShell";

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
// no flash of the wrong theme on load. "system" (or no saved value) leaves
// no data-theme attribute: globals.css's prefers-color-scheme media query
// then decides. See node_modules/next/dist/docs/01-app/02-guides/
// preventing-flash-before-hydration.md, "Themes".
const themeScript = `(function(){try{var t=localStorage.getItem("gk-theme");if(t==="light"||t==="dark"){document.documentElement.setAttribute("data-theme",t)}}catch(e){}})()`;

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
        <AuthProvider>
          <AppShell>{children}</AppShell>
        </AuthProvider>
      </body>
    </html>
  );
}
