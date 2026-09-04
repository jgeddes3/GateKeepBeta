// Plain (non-"use client") display helper, same rationale as this
// directory's own gigDisplay.ts: a Server Component that imports a value
// from a "use client" module gets an opaque client-reference stub back
// instead of the real thing (calling a stubbed function throws at request
// time; indexing into a stubbed object silently reads undefined). Task 9
// review fix: MusicianProfile.tsx (a Server Component) needs to call
// formatChipLabel, which previously lived only in src/portfolio/
// PortfolioForms.tsx ("use client"). PortfolioForms.tsx now imports and
// re-exports this instead of defining it itself, so there is exactly one
// implementation; every existing "use client" importer of formatChipLabel
// (GigCard.tsx, the search result rows, CuratorArtistRow.tsx) keeps
// importing it from PortfolioForms.tsx unchanged, since a client module
// importing a plain value from another client module was never the problem
// here.

// Reskins a raw option code ("hip-hop", "bar_club") into a readable chip
// label ("Hip Hop", "Bar Club") for display only. Every caller still passes
// the raw code (never this formatted string) into toggle/save logic, so the
// value the server sees is byte-identical to before.
export function formatChipLabel(code: string): string {
  return code.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
