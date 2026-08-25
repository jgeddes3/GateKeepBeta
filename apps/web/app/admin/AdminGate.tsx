"use client";
import { useEffect, useState, type ReactNode } from "react";
import { useAuth } from "../../src/auth/AuthProvider";

// Gates admin-only UI by the `admin` custom claim. Invisible to non-admins per
// spec §5: unauthorized visitors see a plain "Not found", not a permission error.
// Mounted with key={user.uid} by AdminGate below, so React remounts (and thus
// resets `isAdmin` to null) whenever the signed-in identity changes, instead of a
// synchronous setState-in-effect reset — matches dashboard's ProfilesList pattern.
function ClaimCheck({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    user?.getIdTokenResult().then((t) => { if (!cancelled) setIsAdmin(t.claims.admin === true); });
    return () => { cancelled = true; };
  }, [user]);
  if (isAdmin === null) return null;
  if (!isAdmin) return <main><h1>Not found</h1></main>;
  return <>{children}</>;
}

export function AdminGate({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return null;
  if (!user) return <main><h1>Not found</h1></main>;
  return <ClaimCheck key={user.uid}>{children}</ClaimCheck>;
}
