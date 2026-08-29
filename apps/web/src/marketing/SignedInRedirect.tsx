"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "../auth/AuthProvider";

// Spec section 5.1: "Logged-in visitors are redirected to their dashboard."
// No prior implementation of this existed (task 3's own report explicitly
// left "/" out of its shell/auth-guard sweep, deferring it to this task:
// "'/' (landing): excluded per the brief, Task 4 owns its own variant").
// This mirrors the auth-guard effect already used by Dashboard and Join
// (app/dashboard/page.tsx, app/join/page.tsx), run in the opposite
// direction, but deliberately non-blocking: those are protected pages that
// must gate all render behind the auth check, while the landing page is
// public marketing content that anonymous visitors (the large majority of
// hits) need to see immediately. This renders nothing and only fires the
// redirect once Firebase confirms a signed-in user, instead of holding the
// whole page back while auth resolves.
export function SignedInRedirect() {
  const { user, loading } = useAuth();
  const router = useRouter();
  useEffect(() => {
    if (!loading && user) router.replace("/dashboard");
  }, [user, loading, router]);
  return null;
}
