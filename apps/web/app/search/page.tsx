import type { Metadata } from "next";
import { SearchClient } from "./SearchClient";

// Same thin Server Component wrapper as app/discover/page.tsx: metadata
// lives here (a "use client" file cannot export it), all the actual
// signed-in-only rendering lives in SearchClient.
export const metadata: Metadata = { title: "Search" };

export default function SearchPage() {
  return <SearchClient />;
}
