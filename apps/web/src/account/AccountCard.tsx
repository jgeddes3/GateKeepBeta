"use client";
import { useEffect, useId, useState } from "react";
import { doc, getDoc } from "firebase/firestore";
import { getFirebase } from "../lib/firebase";
import { callFn } from "../lib/callable";
import { cn } from "../lib/utils";
import {
  ACCOUNT_NAME_HELP, ACCOUNT_CITY_HELP, ACCOUNT_SAVED_MESSAGE, ACCOUNT_GEOCODE_MISS_MESSAGE,
  type UpdateAccountInput, type UpdateAccountResult, type UserDoc,
} from "@gatekeep/shared";
import { Button } from "../ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { Input } from "../ui/input";
import { Skeleton } from "../ui/skeleton";
import { IconWarning } from "../ui/icons";

// SP11 Task 9 (spec section 3.3): display name and home city only, no photo
// upload (spec section 2's owner decision). Seeds both inputs from
// users/{uid} ONCE on mount with a plain getDoc (never a prop that keeps
// changing, per the task brief): the doc's own committed values double as
// the dirty-check baseline, so Save stays disabled until something actually
// differs from what the server last stored, and re-typing back to that
// value disables it again rather than latching on "was this ever touched".
// A successful save re-reads the doc (spec section 3.3: "success re-reads
// the user doc") so the card always reflects what the server actually kept,
// including a geocoder miss that stored the city text with no point.
export function AccountCard({ uid }: { uid: string }) {
  const nameFieldId = useId();
  const cityFieldId = useId();
  const [loaded, setLoaded] = useState(false);
  const [name, setName] = useState("");
  const [city, setCity] = useState("");
  const [savedName, setSavedName] = useState("");
  const [savedCity, setSavedCity] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<{ text: string; kind: "success" | "muted" } | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const snap = await getDoc(doc(getFirebase().db, "users", uid));
      if (cancelled) return;
      const d = snap.data() as UserDoc | undefined;
      const n = d?.displayName ?? "";
      const c = d?.homeCity ?? "";
      setName(n);
      setCity(c);
      setSavedName(n);
      setSavedCity(c);
      setLoaded(true);
    })();
    return () => { cancelled = true; };
  }, [uid]);

  const dirty = name !== savedName || city !== savedCity;

  const save = async () => {
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      const { data } = await callFn<UpdateAccountInput, UpdateAccountResult>("updateAccount", {
        displayName: name.trim(), homeCity: city.trim() === "" ? null : city.trim(),
      });
      setStatus(data.geocoded === false
        ? { text: ACCOUNT_GEOCODE_MISS_MESSAGE, kind: "muted" }
        : { text: ACCOUNT_SAVED_MESSAGE, kind: "success" });
      const snap = await getDoc(doc(getFirebase().db, "users", uid));
      const d = snap.data() as UserDoc | undefined;
      const n = d?.displayName ?? "";
      const c = d?.homeCity ?? "";
      setName(n);
      setCity(c);
      setSavedName(n);
      setSavedCity(c);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save your account.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Account</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4">
        {!loaded ? (
          <div className="grid gap-4" role="status" aria-label="Loading your account">
            <div className="grid gap-1.5">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-10 w-full" />
            </div>
            <div className="grid gap-1.5">
              <Skeleton className="h-4 w-20" />
              <Skeleton className="h-10 w-full" />
            </div>
          </div>
        ) : (
          <>
            <div className="grid gap-1.5">
              <label htmlFor={nameFieldId} className="font-sora text-sm font-medium text-gk-text">
                Display name
              </label>
              <Input
                id={nameFieldId}
                maxLength={80}
                value={name}
                disabled={busy}
                onChange={(e) => { setName(e.target.value); setStatus(null); }}
              />
              <p className="font-sora text-xs text-gk-muted">{ACCOUNT_NAME_HELP}</p>
            </div>
            <div className="grid gap-1.5">
              <label htmlFor={cityFieldId} className="font-sora text-sm font-medium text-gk-text">
                Home city
              </label>
              <Input
                id={cityFieldId}
                maxLength={80}
                value={city}
                disabled={busy}
                onChange={(e) => { setCity(e.target.value); setStatus(null); }}
              />
              <p className="font-sora text-xs text-gk-muted">{ACCOUNT_CITY_HELP}</p>
            </div>
            <Button type="button" onClick={save} disabled={busy || !dirty} className="w-fit">
              {busy ? "Saving…" : "Save"}
            </Button>
            {error && (
              <p role="alert" className="flex items-start gap-2 rounded-gk border border-gk-warning/40 bg-gk-warning/14 px-3.5 py-2.5 font-sora text-sm text-gk-warning">
                <IconWarning size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
                {error}
              </p>
            )}
            {status && (
              <p className={cn("font-sora text-sm", status.kind === "success" ? "text-gk-success" : "text-gk-muted")}>
                {status.text}
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
