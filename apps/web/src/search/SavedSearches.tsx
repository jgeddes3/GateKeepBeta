"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { collection, onSnapshot, orderBy, query, where } from "firebase/firestore";
import type { SavedSearchDoc, SearchFace } from "@gatekeep/shared";
import { getFirebase } from "../lib/firebase";
import { Button } from "../ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { IconWarning } from "../ui/icons";
import { deleteSavedSearch } from "./searchApi";

type SavedSearchRow = { id: string } & SavedSearchDoc;

// Face names as they read on the dashboard, not the callable's own face
// values (controller ruling 3b): fan is the fan's own shows search,
// musician_gigs/musician_venues are the musician's two tabs, curator is the
// curator's find-an-artist search.
const FACE_NAME: Record<SearchFace, string> = {
  fan: "Shows",
  musician_gigs: "Gigs",
  musician_venues: "Venues",
  curator: "Artists",
};

// Mounted on the dashboard for every signed-in user (Task 11 step 2): a live
// list of this uid's saved searches, newest first via Task 3's own
// (uid asc, createdAt desc) composite index. Hidden entirely (returns null)
// when there are none, rather than an empty-state card nobody asked to save
// a search yet needs to see.
export function SavedSearches({ uid }: { uid: string }) {
  const [rows, setRows] = useState<SavedSearchRow[]>([]);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  useEffect(() => {
    const { db } = getFirebase();
    const unsubscribe = onSnapshot(
      query(collection(db, "savedSearches"), where("uid", "==", uid), orderBy("createdAt", "desc")),
      (snap) => setRows(snap.docs.map((d) => ({ id: d.id, ...(d.data() as SavedSearchDoc) }))),
    );
    return () => unsubscribe();
  }, [uid]);

  if (rows.length === 0) return null;

  const remove = async (id: string) => {
    setDeletingId(id);
    setDeleteError(null);
    try {
      await deleteSavedSearch(id);
      // No local filter here: onSnapshot's own next event removes the row,
      // the same "let the subscription be the only writer of `rows`" shape
      // NotificationsList's markRead uses.
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : "Could not delete this saved search.");
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <Card>
      <CardHeader><CardTitle>Saved searches</CardTitle></CardHeader>
      <CardContent>
        {deleteError && (
          <p
            role="alert"
            className="mb-3 flex items-start gap-2 rounded-gk border border-gk-warning/40 bg-gk-warning/14 px-3.5 py-2.5 font-sora text-sm text-gk-warning"
          >
            <IconWarning size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
            {deleteError}
          </p>
        )}
        <ul className="grid gap-3">
          {rows.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate font-sora text-sm font-semibold text-gk-text">{r.label}</p>
                <p className="font-sora text-xs text-gk-muted">{FACE_NAME[r.face]}</p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Button asChild size="sm" variant="secondary">
                  <Link href={`/search?saved=${r.id}`}>Open</Link>
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  className="text-gk-destructive"
                  disabled={deletingId === r.id}
                  onClick={() => void remove(r.id)}
                >
                  {deletingId === r.id ? "Deleting…" : "Delete"}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
