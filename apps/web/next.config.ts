import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // /@ava is the canonical public URL; /u/ava 308s to it. Redirects run before
  // rewrites on incoming requests only, so the internal rewrite cannot loop
  // (verified against next/dist/docs rewrites.md ordering).
  async redirects() {
    return [{ source: "/u/:handle", destination: "/@:handle", permanent: true }];
  },
  async rewrites() {
    return { beforeFiles: [{ source: "/@:handle", destination: "/u/:handle" }], afterFiles: [], fallback: [] };
  },
};

export default nextConfig;
