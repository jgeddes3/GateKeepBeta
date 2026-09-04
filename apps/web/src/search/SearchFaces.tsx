"use client";
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
export function SearchFaces() {
  const { user } = useAuth();
  const profiles = useMyProfiles(user?.uid ?? null);
  // Created once here, not inside any one face: FanFace and MusicianFace
  // both need the same live position, and a device location prompt should
  // never fire twice for one signed-in visit.
  const location = useBrowserLocation();

  const hasApprovedMusician = profiles.some((p) => p.type === "musician" && p.status === "approved");
  const approvedCurator = profiles.find((p) => p.type === "curator" && p.status === "approved");

  if (hasApprovedMusician && approvedCurator) {
    return (
      <Tabs defaultValue="gigs">
        <TabsList>
          <TabsTrigger value="gigs">Gigs</TabsTrigger>
          <TabsTrigger value="venues">Venues</TabsTrigger>
          <TabsTrigger value="artists">Artists</TabsTrigger>
        </TabsList>
        <TabsContent value="gigs"><MusicianGigsPanel location={location} /></TabsContent>
        <TabsContent value="venues"><MusicianVenuesPanel location={location} /></TabsContent>
        <TabsContent value="artists"><CuratorFace curatorProfileId={approvedCurator.profileId} /></TabsContent>
      </Tabs>
    );
  }
  if (approvedCurator) return <CuratorFace curatorProfileId={approvedCurator.profileId} />;
  if (hasApprovedMusician) return <MusicianFace location={location} />;
  return <FanFace location={location} />;
}
