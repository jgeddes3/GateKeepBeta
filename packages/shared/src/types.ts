export type ProfileType = "musician" | "curator";
export type MusicianSubtype = "solo" | "band";
export type CuratorSubtype = "venue" | "planner" | "individual_host";
export type ProfileStatus = "draft" | "pending_review" | "approved" | "rejected";
export type MemberRole = "admin" | "member";

export interface UserDoc {
  displayName: string;
  email: string;
  photoUrl: string | null;
  homeCity: string | null;
  createdAt: number; // epoch ms
  // Task 8: lowercased displayName for prefix search (searchUsersByName).
  // Written by onUserCreated and kept in sync by the onUserDocWritten
  // trigger — NEVER client-writable (outside firestore.rules' users update
  // hasOnly set). Optional because pre-Task-8 seed data / in-flight docs may
  // not have it yet until the trigger or backfillDisplayNameLower catches up.
  displayNameLower?: string;
}

export interface ProfileDoc {
  type: ProfileType;
  subtype: MusicianSubtype | CuratorSubtype;
  name: string;
  handle: string;            // unique, lowercase
  status: ProfileStatus;
  rejectionReason: string | null;
  createdAt: number;
  updatedAt: number;
  portfolio?: PortfolioData; // musicians only; seeded empty by createProfileDraft
  curator?: CuratorDetails;  // curators only; seeded by createProfileDraft
  // Anti-spam (Task 4): stamped by reviewProfile on every reject, of any
  // profile type; submitProfileForReview reads it to enforce a
  // RESUBMIT_COOLDOWN_MS resubmit cooldown. Absent until the first reject.
  lastRejectedAt?: number;
  // Task 8: how many times this profile has been resubmitted after a
  // rejection (i.e. submitProfileForReview called while status was
  // "rejected") — lets the admin queue render "resubmitted Nth time".
  // Absent for a profile that has never been rejected+resubmitted; the
  // FIRST ever submission (draft -> pending_review) deliberately does not
  // count as a resubmit.
  resubmitCount?: number;
  // SP4: mirrors profiles/{id}/private/booking's `preferences` iff that
  // doc's `visibility.preferences == "public"` — rebuildBookingProjections
  // is the sole writer; NEVER rates (rates are never public, spec decision
  // 4). Optional (not `publicBooking:`) so pre-SP4 docs/fixtures stay
  // type-valid, mirroring BookingDoc.visibility's migration strategy —
  // readers must treat an absent value the same as null (`?? null`).
  // Server writers (createProfileDraft, rebuildBookingProjections) always
  // stamp it explicitly, present-and-nullable, going forward.
  publicBooking?: BookingPreferences | null;
}

export interface MemberDoc {
  uid: string;               // duplicates the doc id — required for collection-group "my profiles" queries
  role: MemberRole;
  label: string;             // "drummer", "venue manager"
  joinedAt: number;
}

export interface InviteDoc {
  profileId: string;
  profileName: string;
  invitedUid: string;
  role: MemberRole;
  label: string;
  invitedByUid: string;
  status: "pending" | "accepted" | "declined" | "revoked";
  createdAt: number;
}

export interface AuditLogDoc {
  actorUid: string;
  action: "profile_approved" | "profile_rejected" | "admin_granted" | "profile_deleted"
    | "track_approved" | "track_rejected" | "gig_taken_down" | "account_flagged"
    | "reliability_mark_removed" | "booking_visibility_backfilled";
  targetId: string;          // profileId or uid
  detail: string;
  at: number;
}

export interface NotificationDoc {
  title: string;
  body: string;
  kind: "profile_review" | "track_review" | "system" | "gig_moderation" | "booking";
  read: boolean;
  createdAt: number;
  // SP4 Task 10: optional reference id for deep-linking a notification row
  // to the thing it's about — today only booking-kind notifications set it
  // (the bookingId), letting the web notification list link straight to
  // /dashboard/bookings/[refId]. Optional/backward-compatible: every
  // pre-Task-10 notification (profile/track review, gig moderation, system)
  // omits it, and readers must not assume it's present even on a "booking"
  // kind doc written before this field existed.
  refId?: string;
}

export interface ProfileDraftInput {
  type: ProfileType;
  subtype: string;
  name: string;
  handle: string;
}

// ---------- Sub-project 2: musician portfolio ----------

export const TRACK_STATUSES = ["processing", "pending_review", "approved", "rejected", "failed"] as const;
export type TrackStatus = (typeof TRACK_STATUSES)[number];

export interface TrackDoc {
  title: string;
  status: TrackStatus;
  uploaderUid: string;
  startSec: number;              // chosen clip window start, seconds into the original
  durationSec: number | null;    // measured clip length, set by the transcode trigger
  storagePath: string | null;    // review/... while pending, public/... once approved
  rejectionReason: string | null;
  failureReason: string | null;  // transcode errors, shown to the musician
  order: number;                 // musician-sortable display order
  createdAt: number;
  updatedAt: number;
}

export type ExternalLinkKind = "spotify" | "youtube" | "instagram" | "website";
export interface ExternalLink { kind: ExternalLinkKind; url: string; }

export interface PortfolioData {
  bio: string;
  genres: string[];              // 1-3 from GENRES once set; [] on a fresh draft
  externalLinks: ExternalLink[];
  avatarPhotoPath: string | null; // public/photos/... paths, written by the photo pipeline
  coverPhotoPath: string | null;
}

export interface RateAmount { amountCents: number; note: string | null; }
export interface BookingRates {
  perHour: RateAmount | null;    // extra time played bills at the rate
  perSong: RateAmount | null;    // pay scales with songs requested (e.g. wedding playlists)
  perSet: RateAmount | null;     // flat rate for a defined set
}
export const ACT_SIZES = ["solo", "duo", "band"] as const;
export type ActSize = (typeof ACT_SIZES)[number];
export const AVAILABILITY_PATTERNS = ["weekends", "weeknights", "anytime", "limited"] as const;
export type AvailabilityPattern = (typeof AVAILABILITY_PATTERNS)[number];
export interface BookingPreferences {
  gigTypes: string[];            // subset of GIG_TYPES
  travelRadiusKm: number | null;
  actSize: ActSize | null;
  typicalSetMinutes: number | null;
  bringsOwnPA: boolean | null;
  availabilityPattern: AvailabilityPattern | null;
}
// profiles/{profileId}/private/booking — members + admins only (sub-3 widens to curators)
export interface BookingDoc {
  rates: BookingRates; preferences: BookingPreferences; updatedAt: number;
  // SP4: per-field read tiers. Optional (not `visibility:`) so pre-SP4
  // docs/fixtures stay type-valid — updateBookingInfo always writes a
  // complete one going forward, and Task 3's backfill converges legacy docs;
  // consumers must treat an absent value the same as the backfill default
  // (all rates "curators", preferences "curators").
  visibility?: BookingVisibility;
}

export interface PortfolioUpdateInput {
  profileId: string;
  bio?: string;
  genres?: string[];
  externalLinks?: ExternalLink[];
}
export interface BookingUpdateInput {
  profileId: string; rates: BookingRates; preferences: BookingPreferences; visibility: BookingVisibility;
}
export interface CreateTrackInput {
  profileId: string; title: string; startSec: number; sizeBytes: number; contentType: string;
}

export const GENRES = [
  "rock", "indie", "pop", "country", "folk", "americana", "blues", "jazz", "soul",
  "r&b", "hip-hop", "electronic", "dance", "latin", "reggae", "metal", "punk",
  "classical", "singer-songwriter", "cover-band", "worship", "other",
] as const;

export const GIG_TYPES = [
  "wedding", "bar_club", "festival", "private_event", "corporate", "restaurant_cafe",
] as const;

export const MAX_TRACKS = 10;
export const MAX_CLIP_SECONDS = 30;
export const MAX_AUDIO_UPLOAD_BYTES = 50 * 1024 * 1024;
export const MAX_PHOTO_UPLOAD_BYTES = 10 * 1024 * 1024;
export const AUDIO_CONTENT_TYPES = [
  "audio/mpeg", "audio/mp3", "audio/wav", "audio/x-wav", "audio/mp4",
  "audio/m4a", "audio/x-m4a", "audio/aac", "audio/flac", "audio/ogg",
] as const;

// ---------- Sub-project 3: curator profiles & gig postings ----------

export const GIG_STATUSES = ["draft", "open", "filled", "closed", "cancelled", "taken_down"] as const;
export type GigStatus = (typeof GIG_STATUSES)[number];
export const SERIES_STATUSES = ["active", "paused", "ended"] as const;
export type SeriesStatus = (typeof SERIES_STATUSES)[number];
export const SERIES_CADENCES = ["weekly", "biweekly", "monthly"] as const;
export type SeriesCadence = (typeof SERIES_CADENCES)[number];
export const FILL_MODES = ["per_occurrence", "whole_run"] as const;
export type FillMode = (typeof FILL_MODES)[number];
export type BudgetStructure = "perHour" | "perSong" | "perSet"; // BookingRates keys
export type AddressVisibility = "public" | "neighborhood";

export interface LookingFor { genres: string[]; actSizes: ActSize[]; notes: string | null; }
export interface CuratorDetails {
  about: string;
  lookingFor: LookingFor;
  amenities: { capacity: number | null; hasPA: boolean | null; hasBackline: boolean | null;
               indoorOutdoor: "indoor" | "outdoor" | "both" | null; notes: string | null };
  advertisingInterest: boolean;
  // venues: full street address (public). planners/hosts: city only.
  location: { address: string | null; city: string; neighborhood: string | null;
              geo: { lat: number; lng: number } | null;
              // S2 (geocoder throttle): the exact query string (address or
              // city) that produced this geo — lets updateCuratorProfile
              // skip a redundant geocode call (and its budget charge) when a
              // caller re-submits the same location input. Optional so
              // pre-S2 seed data / admin-SDK test fixtures without this
              // field remain valid; absent is treated as "never matches."
              geocodedFrom?: string };
  photoPaths: string[];          // public/photos/... "gallery" kind (SP2 photo pipeline, widened in Task 4b)
}
// Curator gallery cap — enforced by media.ts's processPhoto trigger when
// appending a newly processed "gallery" photo to curator.photoPaths.
export const MAX_CURATOR_PHOTOS = 12;
// Curator content soft caps — server-enforced in functions/src/curator.ts's
// updateCuratorProfile validation; exported here so client forms (web +
// mobile) consume the same numbers as maxLength/UX-only soft caps instead of
// re-declaring their own copies that could drift from the server gate.
export const MAX_ABOUT_LENGTH = 2000;
export const MAX_ADDRESS_LENGTH = 300;
export const MAX_CITY_LENGTH = 120;
export const MAX_AMENITY_NOTES_LENGTH = 500;
export const MAX_CAPACITY = 100_000;
// lives on ProfileDoc as `curator?: CuratorDetails` (curators only; seeded by createProfileDraft)

export interface GigBudget { minCents: number; maxCents: number; structure: BudgetStructure; }
export interface GigWants { genres: string[]; actSizes: ActSize[]; }
export interface GigPublicLocation {
  venueName: string | null; neighborhood: string | null; city: string;
  geo: { lat: number; lng: number } | null;   // coarsened when visibility=neighborhood
  addressVisibility: AddressVisibility;
  address: string | null;                      // present ONLY when visibility=public
}
export interface GigDoc {
  curatorProfileId: string; seriesId: string | null; detachedFromTemplate: boolean;
  title: string; description: string; wants: GigWants; budget: GigBudget;
  startsAt: number; durationMinutes: number;
  provisions: { hasPA: boolean | null; hasBackline: boolean | null; notes: string | null };
  location: GigPublicLocation;
  status: GigStatus; createdAt: number; updatedAt: number;
  // SP4: public queryable booking linkage — stamped atomically with
  // status:"filled" by acceptBooking (and by the materializer for a
  // whole-run occurrence born already-filled); cleared back to null
  // whenever the gig reopens (cancellation/moderation unwind). Public
  // (not private) so the Shows section and gigs/{id}/private/location's
  // booked-musician reveal rule can both read it — it names the booked act
  // only, no terms.
  bookingId: string | null; bookedMusicianProfileId: string | null;
}
// gigs/{id}/private/location:
export interface GigPrivateLocation {
  address: string; geo: { lat: number; lng: number } | null;
  // S2 (geocoder throttle): pass-through of the exact query string that
  // produced `address`/`geo` — mirrors CuratorDetails.location.geocodedFrom.
  // Optional for the same reason (pre-S2 fixtures/materialized copies of an
  // older template omit it; absent never matches, so it never wrongly skips
  // a geocode).
  geocodedFrom?: string;
}
export interface GigSeriesDoc {
  curatorProfileId: string;
  recurrence: { weekday: number; hour: number; minute: number; cadence: SeriesCadence; endDate: number | null };
  fillMode: FillMode; template: Omit<GigDoc,
    "curatorProfileId"|"seriesId"|"detachedFromTemplate"|"status"|"startsAt"|"createdAt"|"updatedAt"
    |"bookingId"|"bookedMusicianProfileId">;
  // The exact address+geo backing template.location (which is the public,
  // possibly-coarsened shape) — mirrors gigs/{id}/private/location, but
  // inline rather than a subcollection: unlike gigs, a gigSeries doc is
  // NEVER publicly readable (firestore.rules gates it member/admin-only
  // with no "open" disjunct), so there's no doc-level exposure to split
  // against. Task 7's materializer copies both halves onto each occurrence
  // it creates without re-geocoding.
  templatePrivateLocation: GigPrivateLocation;
  status: SeriesStatus; materializedThrough: number; createdAt: number; updatedAt: number;
  // SP4: set when a whole-run booking is accepted (acceptBooking) — mirrors
  // GigDoc's per-occurrence linkage at the series level so the materializer
  // can birth future occurrences already "filled". Both null otherwise;
  // cleared by cancellation/moderation unwind alongside the occurrences'.
  activeBookingId: string | null; bookedMusicianProfileId: string | null;
}
export interface AdminNoteDoc { notes: { byUid: string; at: number; text: string }[]; }

export const MAX_OPEN_GIGS_PER_PROFILE = 50;
export const MAX_ACTIVE_SERIES_PER_PROFILE = 10;
export const MAX_PENDING_CURATOR_PROFILES = 1;
export const RESUBMIT_COOLDOWN_MS = 24 * 60 * 60 * 1000;
export const SERIES_MATERIALIZE_WEEKS = 8;

// V1 is a single-metro launch: gig display times (public curator page + the
// curator dashboard's gigs/series lists) are pinned to ONE IANA zone rather
// than each renderer's own clock (server TZ for SSR, browser TZ client-side)
// so a curator and a fan looking at the same gig see the same wall time.
// Set this to the launch metro's zone before launch (Task 14 adds the
// README launch-checklist item to not forget this).
export const LAUNCH_TIMEZONE = "America/New_York";

// ---------- Sub-project 4: booking flow ----------

export const BOOKING_STATUSES = ["open", "confirmed", "completed", "declined", "withdrawn",
  "superseded", "expired", "cancelled_by_curator", "cancelled_by_musician"] as const;
export type BookingStatus = (typeof BOOKING_STATUSES)[number];
export type BookingSide = "musician" | "curator";

export interface OfferEntry {
  by: BookingSide; amountCents: number;
  // perSong: song count (required int >=1); perHour: hours derived from the
  // gig's durationMinutes at write time (server-set); perSet: null. DISPLAY
  // DATA ONLY for perHour — a listed thread entry's quantity can go stale if
  // the gig's duration is edited later. Never multiply amountCents by this
  // field to compute money owed; always go through
  // computeExpectedTotalCents(structure, amountCents, { durationMinutes }),
  // which re-derives the hours from the gig itself at the moment of use.
  expectedQuantity: number | null;
  note: string | null; at: number;
}
export interface AcceptedTerms { amountCents: number; expectedQuantity: number | null; expectedTotalCents: number; }
export interface BookingDeposit {
  amountCents: number; status: "unpaid";               // sub-5 adds "held" | "refunded" | "forfeited"
  forfeitedTo: "musician" | null;                       // set by cancellation outcome; money moves in sub-5
  policy: { percent: number; curatorForfeitHours: number; musicianMarkHours: number }; // snapshot, never re-read from constants
}
export interface BookingCancellation {
  by: BookingSide; reason: string; at: number; hoursBeforeStart: number;
  outcome: "deposit_forfeited" | "deposit_refunded"; markApplied: boolean;
}
// Task 6: one entry per cancelOccurrence call against a whole-run booking —
// unlike BookingCancellation (the run-level outcome, which also moves
// deposit.forfeitedTo), a per-occurrence outcome is recorded ONLY here;
// deposit.forfeitedTo is deliberately left untouched by cancelOccurrence
// (sub-5 reads these entries directly for occurrence-level settlement).
export interface OccurrenceCancellation {
  gigId: string; by: BookingSide; at: number; hoursBeforeStart: number;
  outcome: "deposit_forfeited" | "deposit_refunded"; markApplied: boolean;
}
// Named BookingRequestDoc (not BookingDoc) because SP2's BookingDoc (the
// rates+prefs subdoc at profiles/{id}/private/booking, above) already owns
// the obvious name — use BookingRequestDoc everywhere for this top-level doc.
export interface BookingRequestDoc {
  gigId: string; seriesId: string | null;               // seriesId set <=> whole-run booking
  curatorProfileId: string; musicianProfileId: string;
  initiatedBy: BookingSide; structure: BudgetStructure; // copied from gig budget, immutable
  thread: OfferEntry[]; awaitingSide: BookingSide;
  status: BookingStatus;
  acceptedTerms: AcceptedTerms | null; deposit: BookingDeposit | null;
  cancellation: BookingCancellation | null;
  createdAt: number; updatedAt: number; confirmedAt: number | null; resolvedAt: number | null;
  // Task 6: whole-run per-date cancellations (cancelOccurrence). Optional
  // (not `occurrenceCancellations:`) so every pre-Task-6 booking literal —
  // bookings.ts's own finalizeBookingRequest write, and every existing
  // fixture in bookings.test.ts — stays valid without modification; absent
  // is treated identically to an empty array by readers. Capped at
  // MAX_OCCURRENCE_CANCELLATIONS, drop-oldest, once cancelOccurrence starts
  // writing it.
  occurrenceCancellations?: OccurrenceCancellation[];
}

// visibility + projections + reliability
export type RateVisibility = "curators" | "private";    // rates are NEVER public (spec decision 4)
export type PrefsVisibility = "public" | "curators";
export interface BookingVisibility {
  perHour: RateVisibility; perSong: RateVisibility; perSet: RateVisibility; preferences: PrefsVisibility;
}
export interface ReliabilitySummary { noShowCount: number; completedCount: number; }
export interface CuratorBookingDoc {                     // profiles/{id}/private/curatorBooking
  rates: BookingRates;                                   // structures marked "private" are null here even if set in the source
  preferences: BookingPreferences; reliability: ReliabilitySummary; updatedAt: number;
}
export interface ReliabilityMark {
  bookingId: string; gigId: string; kind: "late_cancel" | "reported_no_show";
  at: number; reportedByProfileId: string | null; removedByAdmin: boolean;
}
export interface ReliabilityDoc { marks: ReliabilityMark[]; completedCount: number; updatedAt: number; } // profiles/{id}/private/reliability

export const MAX_BOOKING_THREAD_ENTRIES = 50;
export const MAX_OFFER_NOTE_LENGTH = 280;
export const MAX_CANCEL_REASON_LENGTH = 500;
export const MAX_OPEN_BOOKINGS_INITIATED_PER_PROFILE = 25;
export const MAX_OFFER_AMOUNT_CENTS = 10_000_000;       // $100k
export const MAX_OFFER_SONG_COUNT = 500;                // perSong expectedQuantity upper bound
export const DEPOSIT_PERCENT = 35;
export const CURATOR_FORFEIT_WINDOW_HOURS = 72;
export const MUSICIAN_MARK_WINDOW_HOURS = 24;
export const MAX_RELIABILITY_MARKS = 200;
export const NO_SHOW_REPORT_WINDOW_DAYS = 14;
export const MAX_OCCURRENCE_CANCELLATIONS = 100;
