"use client";
import type { SearchFace, SearchFilters } from "@gatekeep/shared";
import { useAuth } from "../auth/AuthProvider";
import { useMyProfiles } from "../shell/useMyProfiles";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/tabs";
import { CuratorFace } from "./CuratorFace";
import { FanFace } from "./FanFace";
import { MusicianFace, MusicianGigsPanel, MusicianVenuesPanel } from "./MusicianFace";
import { useBrowserLocation } from "./useBrowserLocation";

// Role resolution (controller ruling 3): an approved musician profile with
// no approved curator profile gets MusicianFace; an approved curator with
// no approved musician gets CuratorFace, scoped to that curator's own
// first approved profile; holding both gets the three-segment strip below
// (a working musician who also curates shows still needs both); neither
// gets the plain fan face. useMyProfiles returns [] while its own
// subscription is still loading, so a signed-in account with profiles
// briefly sees FanFace until that first snapshot arrives, the same
// loading-shape tradeoff AppShell's own nav resolution already accepts.
// initial (Task 11): the ?saved=<id> restore path. SearchClient resolves
// the saved search doc BEFORE this component ever mounts (its own loading
// gate), so `initial` here is either absent (the ordinary /search visit) or
// the full, final value for this mount's whole lifetime, never a value that
// arrives after Tabs has already picked its (uncontrolled) defaultValue.
export function SearchFaces({ initial }: { initial?: { face: SearchFace; q: string; filters: SearchFilters } }) {
  const { user } = useAuth();
  const profiles = useMyProfiles(user?.uid ?? null);
  // Created once here, not inside any one face: FanFace and MusicianFace
  // both need the same live position, and a device location prompt should
  // never fire twice for one signed-in visit.
  const location = useBrowserLocation();

  const hasApprovedMusician = profiles.some((p) => p.type === "musician" && p.status === "approved");
  const approvedCurator = profiles.find((p) => p.type === "curator" && p.status === "approved");

  // Only the leaf whose own face matches the saved search's face gets the
  // saved q/filters; every other leaf mounts with its ordinary blank state.
  const initialFor = (face: SearchFace): { q: string; filters: SearchFilters } | undefined =>
    initial && initial.face === face ? { q: initial.q, filters: initial.filters } : undefined;

  if (hasApprovedMusician && approvedCurator) {
    const defaultTab = initial?.face === "musician_venues" ? "venues" : initial?.face === "curator" ? "artists" : "gigs";
    return (
      <Tabs defaultValue={defaultTab}>
        <TabsList>
          <TabsTrigger value="gigs">Gigs</TabsTrigger>
          <TabsTrigger value="venues">Venues</TabsTrigger>
          <TabsTrigger value="artists">Artists</TabsTrigger>
        </TabsList>
        <TabsContent value="gigs"><MusicianGigsPanel location={location} initial={initialFor("musician_gigs")} /></TabsContent>
        <TabsContent value="venues"><MusicianVenuesPanel location={location} initial={initialFor("musician_venues")} /></TabsContent>
        <TabsContent value="artists"><CuratorFace curatorProfileId={approvedCurator.profileId} initial={initialFor("curator")} /></TabsContent>
      </Tabs>
    );
  }
  if (approvedCurator) return <CuratorFace curatorProfileId={approvedCurator.profileId} initial={initialFor("curator")} />;
  if (hasApprovedMusician) {
    return (
      <MusicianFace
        location={location}
        initialFace={initial?.face}
        initial={initial ? { q: initial.q, filters: initial.filters } : undefined}
      />
    );
  }
  return <FanFace location={location} initial={initialFor("fan")} />;
}
