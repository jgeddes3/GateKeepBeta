import { GigBrowse } from "../../src/bookings/GigBrowse";

// Musician "Find gigs" tab (SP4 Task 12): public open-gigs browse + the
// Apply flow, replacing the earlier placeholder. GigBrowse is
// self-contained (owns its own ScrollView, queries, and modal detail/apply
// flow), no membership gate needed here: browsing is public the same way
// web's app/gigs/page.tsx is, and the Apply flow itself gates on an
// approved musician profile internally (GigBrowse's ApplyPanel).
export default function Gigs() {
  return <GigBrowse />;
}
