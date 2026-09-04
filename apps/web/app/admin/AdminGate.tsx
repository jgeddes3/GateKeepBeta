"use client";
import { useEffect, useState, type ReactNode } from "react";
import { useAuth } from "../../src/auth/AuthProvider";

// Gates admin-only UI by the `admin` custom claim. Invisible to non-admins per
// spec §5: unauthorized visitors see a plain "Not found", not a permission error.
// Mounted with key={user.uid} by AdminGate below, so React remounts (and thus
// resets `isAdmin` to null) whenever the signed-in identity changes, instead of a
// synchronous setState-in-effect reset, matches dashboard's ProfilesList pattern.
//
// Task 12 restyle: the "Not found" body now matches
// app/u/[handle]/not-found.tsx's gk-token treatment (this route was still on
// bare, unstyled markup pre-restyle). The gate's own logic (claim check,
// which branch renders when) is unchanged.
function NotFound() {
  return (
    <main className="mx-auto max-w-5xl px-4 py-16 text-center sm:px-6">
      <h1 className="font-syne text-2xl font-extrabold text-gk-text sm:text-3xl">Not found</h1>
    </main>
  );
}

function ClaimCheck({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    user?.getIdTokenResult(true).then((t) => { if (!cancelled) setIsAdmin(t.claims.admin === true); });
    return () => { cancelled = true; };
  }, [user]);
  if (isAdmin === null) return null;
  if (!isAdmin) return <NotFound />;
  return <>{children}</>;
}

export function AdminGate({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return null;
  if (!user) return <NotFound />;
  return <ClaimCheck key={user.uid}>{children}</ClaimCheck>;
}
