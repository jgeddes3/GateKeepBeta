import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // /@ava is the canonical public URL; /u/ava 308s to it. Redirects run before
  // rewrites on incoming requests only, so the internal rewrite cannot loop
  // (verified against next/dist/docs rewrites.md ordering).
  //
  // Sub-project 9A task 9: the new past-shows page adds a second path depth
  // (/@ava/shows -> app/u/[handle]/shows/page.tsx). Next's `:handle` segment
  // matcher only captures ONE path segment, so the existing single-segment
  // rules above don't also cover /shows: it needs its own pair, same shape.
  async redirects() {
    return [
      { source: "/u/:handle", destination: "/@:handle", permanent: true },
      { source: "/u/:handle/shows", destination: "/@:handle/shows", permanent: true },
    ];
  },
  async rewrites() {
    return {
      beforeFiles: [
        { source: "/@:handle", destination: "/u/:handle" },
        { source: "/@:handle/shows", destination: "/u/:handle/shows" },
      ],
      afterFiles: [],
      fallback: [],
    };
  },
};

export default nextConfig;
