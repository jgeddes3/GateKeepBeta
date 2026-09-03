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
  // trigger, NEVER client-writable (outside firestore.rules' users update
  // hasOnly set). Optional because pre-Task-8 seed data / in-flight docs may
  // not have it yet until the trigger or backfillDisplayNameLower catches up.
  displayNameLower?: string;
  // SP7, stamped by markGenrePickerSeen
  genrePickerSeenAt?: number;
  // SP10: stamped when this user's own profile is rejected, mirrors
  // ProfileDoc.lastRejectedAt at the user level for account-scoped gates.
  lastProfileRejectedAt?: number;
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
  // "rejected"), lets the admin queue render "resubmitted Nth time".
  // Absent for a profile that has never been rejected+resubmitted; the
  // FIRST ever submission (draft -> pending_review) deliberately does not
  // count as a resubmit.
  resubmitCount?: number;
  // SP4: mirrors profiles/{id}/private/booking's `preferences` iff that
  // doc's `visibility.preferences == "public"`, rebuildBookingProjections
  // is the sole writer; NEVER rates (rates are never public, spec decision
  // 4). Optional (not `publicBooking:`) so pre-SP4 docs/fixtures stay
  // type-valid, mirroring BookingDoc.visibility's migration strategy,
  // readers must treat an absent value the same as null (`?? null`).
  // Server writers (createProfileDraft, rebuildBookingProjections) always
  // stamp it explicitly, present-and-nullable, going forward.
  publicBooking?: BookingPreferences | null;
  // SP7, server-maintained by followTarget/unfollowTarget; absent means 0
  followerCount?: number;
}

export interface MemberDoc {
  uid: string;               // duplicates the doc id, required for collection-group "my profiles" queries
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
    | "reliability_mark_removed" | "booking_visibility_backfilled"
    // SP5 Task 9: an operator manually released a stuck accept saga
    // (releaseStuckSaga) after reconciling the Stripe side by hand.
    | "booking_saga_released"
    // SP7 Task 6: an admin removed a musician's show post (not the author).
    | "show_post_removed"
    // SP10 hardening: an admin took down a published event; an account
    // deletion completed; a profile's Stripe ids were cleared on deletion.
    | "event_taken_down" | "account_deleted" | "profile_deleted_stripe_ids";
  targetId: string;          // profileId, uid, or bookingId (booking_saga_released)
  detail: string;
  at: number;
}

export interface NotificationDoc {
  title: string;
  body: string;
  // SP6 Task 5: "ticket" is a ticket-order purchase confirmation; its refId
  // is the eventId (see refId's own comment below).
  // SP7: "show_announced", "new_music", "show_rescheduled", "show_post" are added for fan discovery notifications
  kind: "profile_review" | "track_review" | "system" | "gig_moderation" | "booking" | "ticket" | "show_announced" | "new_music" | "show_rescheduled" | "show_post";
  read: boolean;
  createdAt: number;
  // SP4 Task 10: optional reference id for deep-linking a notification row
  // to the thing it's about, today only booking-kind notifications set it
  // (the bookingId), letting the web notification list link straight to
  // /dashboard/bookings/[refId]. Optional/backward-compatible: every
  // pre-Task-10 notification (profile/track review, gig moderation, system)
  // omits it, and readers must not assume it's present even on a "booking"
  // kind doc written before this field existed.
  // SP7: eventId for show_announced / show_rescheduled / show_post; the artist's profileId for new_music.
  refId?: string;
}

// ---------- Sub-project 10 hardening ----------
export const CHECK_IN_OPENS_BEFORE_MS = 12 * 3600 * 1000;
export const PENDING_ORDERS_PER_USER_CAP = 3;
export const SETTLEMENT_CLAIM_STALE_MS = 24 * 3600 * 1000;
export const WEBHOOK_SYNC_OWNER_WINDOW_MS = 15 * 60 * 1000;
export const TICKET_ORDER_STUCK_AFTER_MS = 2 * 3600 * 1000;
export const POSTER_UPLOAD_TTL_MS = 24 * 3600 * 1000;
export type NotificationKind = NotificationDoc["kind"];

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
// profiles/{profileId}/private/booking, members + admins only (sub-3 widens to curators)
export interface BookingDoc {
  rates: BookingRates; preferences: BookingPreferences; updatedAt: number;
  // SP4: per-field read tiers. Optional (not `visibility:`) so pre-SP4
  // docs/fixtures stay type-valid, updateBookingInfo always writes a
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
              // city) that produced this geo, lets updateCuratorProfile
              // skip a redundant geocode call (and its budget charge) when a
              // caller re-submits the same location input. Optional so
              // pre-S2 seed data / admin-SDK test fixtures without this
              // field remain valid; absent is treated as "never matches."
              geocodedFrom?: string };
  photoPaths: string[];          // public/photos/... "gallery" kind (SP2 photo pipeline, widened in Task 4b)
}
// Curator gallery cap, enforced by media.ts's processPhoto trigger when
// appending a newly processed "gallery" photo to curator.photoPaths.
export const MAX_CURATOR_PHOTOS = 12;
// Curator content soft caps, server-enforced in functions/src/curator.ts's
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
  // SP4: public queryable booking linkage, stamped atomically with
  // status:"filled" by acceptBooking (and by the materializer for a
  // whole-run occurrence born already-filled); cleared back to null
  // whenever the gig reopens (cancellation/moderation unwind). Public
  // (not private) so the Shows section and gigs/{id}/private/location's
  // booked-musician reveal rule can both read it, it names the booked act
  // only, no terms.
  bookingId: string | null; bookedMusicianProfileId: string | null;
  // SP10: set when this gig is promoted to an event (GIG_ALREADY_PROMOTED_MESSAGE
  // guards a second promotion), mirrors the series-level FillMode for a
  // standalone (non-series) gig. Optional/backward-compatible: absent on every
  // pre-SP10 gig and on any gig that was never promoted.
  fillMode?: "whole_run" | "per_occurrence" | null;
}
// gigs/{id}/private/location:
export interface GigPrivateLocation {
  address: string; geo: { lat: number; lng: number } | null;
  // S2 (geocoder throttle): pass-through of the exact query string that
  // produced `address`/`geo`, mirrors CuratorDetails.location.geocodedFrom.
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
  // possibly-coarsened shape), mirrors gigs/{id}/private/location, but
  // inline rather than a subcollection: unlike gigs, a gigSeries doc is
  // NEVER publicly readable (firestore.rules gates it member/admin-only
  // with no "open" disjunct), so there's no doc-level exposure to split
  // against. Task 7's materializer copies both halves onto each occurrence
  // it creates without re-geocoding.
  templatePrivateLocation: GigPrivateLocation;
  status: SeriesStatus; materializedThrough: number; createdAt: number; updatedAt: number;
  // SP4: set when a whole-run booking is accepted (acceptBooking), mirrors
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
  // DATA ONLY for perHour, a listed thread entry's quantity can go stale if
  // the gig's duration is edited later. Never multiply amountCents by this
  // field to compute money owed; always go through
  // computeExpectedTotalCents(structure, amountCents, { durationMinutes }),
  // which re-derives the hours from the gig itself at the moment of use.
  expectedQuantity: number | null;
  note: string | null; at: number;
}
export interface AcceptedTerms { amountCents: number; expectedQuantity: number | null; expectedTotalCents: number; }
export interface BookingDeposit {
  amountCents: number; status: DepositStatus;           // see DepositStatus in the SP5 section below
  forfeitedTo: "musician" | null;                       // set by cancellation outcome; money moves in sub-5
  policy: { percent: number; curatorForfeitHours: number; musicianMarkHours: number }; // snapshot, never re-read from constants
}
export interface BookingCancellation {
  by: BookingSide; reason: string; at: number; hoursBeforeStart: number;
  outcome: "deposit_forfeited" | "deposit_refunded"; markApplied: boolean;
  graceApplied?: boolean;   // SP5: 1h post-accept grace neutralized the penalty
}
// Task 6: one entry per cancelOccurrence call against a whole-run booking,
// unlike BookingCancellation (the run-level outcome, which also moves
// deposit.forfeitedTo), a per-occurrence outcome is recorded ONLY here;
// deposit.forfeitedTo is deliberately left untouched by cancelOccurrence
// (sub-5 reads these entries directly for occurrence-level settlement).
export interface OccurrenceCancellation {
  gigId: string; by: BookingSide; at: number; hoursBeforeStart: number;
  outcome: "deposit_forfeited" | "deposit_refunded"; markApplied: boolean;
  graceApplied?: boolean;   // SP5: 1h post-accept grace neutralized the penalty
}
// Named BookingRequestDoc (not BookingDoc) because SP2's BookingDoc (the
// rates+prefs subdoc at profiles/{id}/private/booking, above) already owns
// the obvious name, use BookingRequestDoc everywhere for this top-level doc.
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
  // (not `occurrenceCancellations:`) so every pre-Task-6 booking literal,
  // bookings.ts's own finalizeBookingRequest write, and every existing
  // fixture in bookings.test.ts, stays valid without modification; absent
  // is treated identically to an empty array by readers. Capped at
  // MAX_OCCURRENCE_CANCELLATIONS; cancelOccurrence REFUSES (resource-
  // exhausted) once the array is already at the cap rather than
  // dropping the oldest entry (security audit wave F7, ruling:
  // reject-when-full, a settlement record must never be silently
  // discarded).
  occurrenceCancellations?: OccurrenceCancellation[];
  // Security audit wave F5 (ruling: allow but exclude from trust metric):
  // stamped true by acceptBooking when it detects membership overlap
  // between the two profiles (the same uid is a member of BOTH the
  // curator and musician side), e.g. a venue owner performing at their
  // own venue. The booking is allowed to proceed exactly as any other, but
  // scheduled.ts's sweep step 7 skips the completedCount increment (and
  // recompute) for a selfDeal booking so a self-booking can never farm the
  // curator-facing reliability/trust metric. Optional/backward-compatible
  //, absent on every pre-existing booking and on any booking accepted
  // before this fix landed, treated identically to false.
  selfDeal?: boolean;
  // SP5: fee snapshot + aggregate payment state. Optional so every pre-SP5
  // booking/fixture stays valid; acceptBooking writes both going forward.
  feePolicy?: FeePolicy;
  paymentSummary?: PaymentSummary;
  // SP5: accept-saga crash marker, true between the staging transaction and
  // the post-charge commit; the hourly payments sweep reconciles stuck ones.
  depositChargePending?: boolean;
  // SP5 Task 6: how many deposit-charge ATTEMPTS this booking has staged.
  // Load-bearing for money safety, not diagnostics: both real Stripe and
  // FakeStripe cache a DECLINE under its idempotency key, so a retry after a
  // decline must use a DIFFERENT key or it just replays the decline forever.
  // The accept saga's charge key is `{bookingId}:accept:deposit:{attempt}`;
  // staging transaction A increments this counter, and crash-reconciliation
  // (Task 9) reuses the PERSISTED value so its replay hits the same key (and
  // therefore Stripe's original intent) rather than charging twice.
  depositChargeAttempt?: number;
  // SP5 Task 6: pending-charge recovery marker. Set when chargeOffSession
  // left the PaymentIntent `processing` (StripePaymentPendingError), a
  // same-key retry is impossible (the cached `processing` outcome replays
  // forever), so the intent id is persisted here, the staged payment docs
  // and depositChargePending are LEFT in place, and the
  // payment_intent.succeeded webhook finalizes the accept out-of-band.
  // Cleared on commit and on any unstage.
  depositChargeIntentId?: string | null;
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
  // null when the projection was seeded by a reliability event (a completion
  // or a mark) before the musician ever saved booking info (SP10 Task 18).
  preferences: BookingPreferences | null;
  reliability: ReliabilitySummary; updatedAt: number;
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

// ---------- Sub-project 5: payments ----------

export const CURATOR_FEE_PCT = 11;
export const MUSICIAN_FEE_PCT = 2;
export const INSTANT_FEE_PCT = 4;
export const INSTANT_FEE_MIN_CENTS = 100;
// Owner ruling (M4): the smallest cash-out that may go out INSTANT. Below this
// the 4% fee is a poor deal and the fast rail isn't worth it, a standard payout
// (still >= $1) is the route for smaller amounts. Enforced by requestPayout and
// mirrored by the Earnings page's Instant button.
export const INSTANT_PAYOUT_MIN_CENTS = 1000;   // $10.00
export const LATE_FEE_PCT = 10;
// Percentage-POINTS of the outstanding amount, not "7% of the late fee",
// meaningful only relative to LATE_FEE_PCT: 7 of LATE_FEE_PCT's 10 points go
// to the musician, the remaining 3 to the platform.
export const LATE_FEE_MUSICIAN_PCT = 7;
export const SETTLEMENT_DELAY_MS = 3 * 24 * 60 * 60 * 1000;   // T+3 window after gig END
export const CANCEL_GRACE_MS = 60 * 60 * 1000;                // 1h post-accept grace, both sides
// Owner ruling (M3): how long INSTANT payouts are BLOCKED on a profile after
// self-deal-funded money lands in its balance (a forfeit transfer or an earnings
// transfer for a `selfDeal` booking, the same uid on both sides). Self-deal is
// a card->cash conversion path; the hold removes the FAST conversion, leaving
// standard-payout-after-settle as the only route. 3 days lines up with the T+3
// settlement window (SETTLEMENT_DELAY_MS) but is named separately so the two can
// move independently.
export const SELF_DEAL_HOLD_MS = 3 * 24 * 60 * 60 * 1000;     // 3d instant-payout hold on self-deal funds
export const SETTLEMENT_RETRY_OFFSETS_MS =
  [24 * 60 * 60 * 1000, 2 * 24 * 60 * 60 * 1000, 2 * 24 * 60 * 60 * 1000] as const; // +1d, +2d, +2d
export const MAX_TRUE_UP_EXTRA_MINUTES = 720;
export const MAX_TRUE_UP_EXTRA_SONGS = 500;

// Snapshotted onto the booking at accept (alongside SP4's deposit.policy),
// later fee-constant changes never touch an accepted booking. All five
// fields are INTEGER percent values, the money layer's assertPct rejects
// fractional pcts at runtime, so never author a snapshot like 11.5.
export interface FeePolicy {
  curatorFeePct: number; musicianFeePct: number; instantFeePct: number;
  lateFeePct: number; lateFeeMusicianPct: number;
}

// The deposit state machine. `unpaid` is the birth state; `applied`,
// `refunded` and `forfeited` are terminal (only Task 12's clawback ever
// re-opens one, and only from `applied`). Legal transitions, nothing else
// is a valid write:
//   unpaid  -> unpaid           SP5 Task 9: a DECLINED birth-deposit charge
//                               stays unpaid and bumps depositAttempts +
//                               depositNextRetryAt (see DepositState below),
//                               a decline is a retry, never a state change
//   unpaid  -> held             THREE writers: the accept saga's batch charge,
//                               the sweep's per-birth charge for a materialized
//                               date, and (Task 11) finalizeDepositPayDue, when
//                               a curator pays an exhausted birth deposit
//                               on-session through payPastDue
//   unpaid  -> refund_pending   a cancellation/no-show/waive landing on a
//                               never-charged date. Only when a charge might
//                               still be outstanding against it (an intent is
//                               recorded); the executor then resolves it with
//                               NO Stripe call in two shapes, a birth charge
//                               left `processing`, and an UNCONFIRMED pay-now
//                               intent (isUnconfirmedPayDueDeposit), neither of
//                               which has a charge to refund
//   unpaid  -> refunded         DIRECT, no executor and no money: the deposit
//                               obligation is discharged without ever having
//                               been collected. Three writers, all Task 11,
//                               the two waive branches' no-executor path (the
//                               date is owed nothing), finalizeSettlementSuccess
//                               when a settlement charged the FULL base and so
//                               ABSORBED the deposit, and the same function
//                               retiring a deposit whose only intent was an
//                               unconfirmed pay-now one
//   held    -> applied          settlement consumed the escrow for its date
//   held    -> refund_pending   cancellation / no-show, refund outcome
//   held    -> forfeit_pending  curator late-cancel of THAT date only
//   *_pending -> refunded/forfeited   the post-commit executor, or the
//                               sweep re-running a doc stuck pending
//   applied -> (clawback)       Task 12 ONLY, needs a transfer reversal,
//                               never a refund; no cancellation path may
//                               touch an applied deposit
// The two `*_pending` states are the transactional intent-to-move-money:
// written in the same transaction as the cancellation itself, so a crash
// before the money moves always leaves a doc the sweep can find and finish.
//
// THE CLOSING INVARIANT, and the reason the `unpaid -> refunded` edges above
// exist at all: `unpaid` IS A DEBT-QUERY ANSWER, NOT A RESTING STATE. Once its
// retry schedule is exhausted, an `unpaid` doc is precisely what
// clearDelinquencyIfSettled counts as outstanding deposit debt, the thing that
// gates the curator out of booking. So no path may leave a doc there once the
// obligation has been DISCHARGED, by any route: paid, waived, cancelled, or
// absorbed into a settlement that charged the full base. Leaving it `unpaid`
// out of tidiness ("no money moved, so nothing to record") is how a curator
// ends up permanently gated over a date they demonstrably owe nothing on.
// `refunded` is the terminal state for "no escrow of ours is outstanding",
// whether or not anything was ever collected.
export type DepositStatus = "unpaid" | "held" | "applied"
  | "refund_pending" | "refunded" | "forfeit_pending" | "forfeited";
export type SettlementStatus = "not_due" | "pending" | "past_due" | "paid" | "waived";
export type TransferStatus = "none" | "pending" | "transferred" | "reversed";

export interface DepositState {
  sliceCents: number;                    // ceil(the booking's deposit.policy.percent% of baseCents), the accepted booking's frozen snapshot, never a live constant
  feeShareCents: number;                 // ceil(sliceCents * curatorFeePct / 100)
  intentId: string | null;               // shared for the accept batch; per-birth otherwise
  // The Stripe CHARGE behind `intentId` (a PaymentIntent's latest_charge),
  // captured at charge time. Transfers backed by a fresh charge must pass it
  // as `sourceChargeId` (Task 8's forfeit transfer) so the transfer draws on
  // that charge's own funds instead of the platform's aggregate available
  // balance, otherwise a not-yet-settled charge yields balance_insufficient
  // in live mode. Stays null when the charge id isn't known (a deposit
  // finalized out-of-band by the payment_intent.succeeded webhook, whose
  // event payload need not carry latest_charge).
  chargeId: string | null;
  status: DepositStatus;
  chargedAt: number | null; resolvedAt: number | null;
  forfeitTransferId: string | null;
  // SP5 Task 9, BIRTH-deposit dunning only (a date materialized onto an
  // already-booked whole run, charged individually by the hourly payments
  // sweep; the accept saga's own batch charge duns through the BOOKING's
  // `depositChargeAttempt` instead, never these).
  //
  // `depositAttempts` is load-bearing for money safety, not diagnostics,
  // exactly like BookingRequestDoc.depositChargeAttempt: both real Stripe and
  // FakeStripe CACHE a decline under its idempotency key, so a retry after a
  // decline must carry a different key or it replays the decline forever. The
  // birth charge key is `{bookingId}:{gigId}:deposit:{depositAttempts}`, and
  // the counter is PERSISTED before the attempt it names, so a crash between
  // the charge and recording its outcome replays the SAME key (Stripe hands
  // back the original intent) rather than charging twice. It increments ONLY
  // on a decline.
  //
  // `depositNextRetryAt` is when the next attempt becomes due (offsets from
  // SETTLEMENT_RETRY_OFFSETS_MS); null/absent means "no retry pending",
  // either it has never been attempted, or the retry schedule is exhausted
  // (at which point the curator profile is flagged delinquent instead; there
  // is deliberately NO late fee on a deposit, late fees are a settlement
  // concept, spec §4).
  //
  // Both optional so every pre-Task-9 payment doc stays type-valid; readers
  // must treat absent as 0 / null respectively.
  depositAttempts?: number;
  depositNextRetryAt?: number | null;
  // SP5 Task 11, the ON-SESSION intent `payPastDue` minted to rescue this
  // deposit after its retry schedule ran out, mirrored out of `intentId` for
  // exactly the reason SettlementState.payDueIntentId is: `intentId` alone
  // cannot say whether the outstanding charge is one payPastDue may replace,
  // and an `unpaid` deposit can also be carrying a birth charge left
  // `processing` by the sweep. Optional; absent means null.
  payDueIntentId?: string | null;
  // SP10: the amount actually charged for this deposit's PaymentIntent, may
  // differ from `sliceCents` when Stripe rounds or when a partial/legacy
  // charge amount was recorded. Optional; absent means "use sliceCents".
  chargeAmountCents?: number;
}
export interface SettlementState {
  status: SettlementStatus;
  settleAfter: number | null;            // gig END + SETTLEMENT_DELAY_MS, set when the gig ends
  computedCents: number | null;          // final base − deposit slice (>= 0), set at charge time
  feeShareCents: number | null;
  trueUp: { extraMinutes: number; extraSongs: number; reportedAt: number } | null;
  intentId: string | null;
  // SP5 Task 11, the ON-SESSION intent `payPastDue` minted for this
  // occurrence, mirrored out of `intentId` so the two can be told apart.
  //
  // LOAD-BEARING, not diagnostics. `intentId` alone cannot answer "is the
  // outstanding intent one payPastDue may replace?", and getting that wrong is
  // a double charge: an off-session settlement intent left `processing` (or
  // one that succeeded against a doc whose payout was blocked) also lives in
  // `intentId`, and minting a second, confirmable intent beside it would let
  // the curator pay a night twice. payPastDue therefore refuses whenever
  // `intentId != null && intentId !== payDueIntentId`, and otherwise re-issues
  // under its own deterministic key, which REPLAYS its previous intent rather
  // than creating a second one, so an abandoned attempt is resumable.
  //
  // Optional so every pre-Task-11 payment doc stays type-valid; readers must
  // treat absent as null.
  payDueIntentId?: string | null;
  attempts: number; nextRetryAt: number | null;
  lateFeeCents: number | null; lateFeeMusicianCents: number | null;
  // Explicit delinquency marker, set once (never cleared) when delinquency
  // is declared. lateFeeCents is the MONEY, never the flag, a legitimately
  // -zero late fee (e.g. a 0-pct policy snapshot) must not read as
  // "not delinquent" just because the cents happen to be 0.
  delinquentAt: number | null;
  // SP5 Task 10, PRE-CHARGE marker, written immediately before the
  // settlement's Stripe call and cleared by every terminal write. Two jobs,
  // both about the non-transactional gap a charge opens:
  //  1. it closes the true-up window BEFORE the money is computed, so a
  //     curator can never report extra minutes against a charge that is
  //     already in flight (the settlement would then record an amount that
  //     was never charged). `settlement.intentId` closes that window too, but
  //     only AFTER the call returns, this covers the call itself.
  //  2. its write time is the CAS baseline the terminal write is held to, so
  //     the precondition spans the whole charge (same persist-before-charge
  //     idiom as DepositState.depositAttempts).
  // Readers must treat it as advisory and TIME-BOUNDED (IDEMPOTENCY_WINDOW_MS)
  //, an instance that died mid-charge would otherwise lock the true-up
  // window forever. Optional so every pre-Task-10 payment doc stays valid.
  chargingSince?: number | null;
}
export interface TransferState {         // musician earnings for this occurrence
  status: TransferStatus;
  id: string | null; amountCents: number | null; transferredAt: number | null;
}
// bookings/{bookingId}/payments/{gigId}, one doc per occurrence, the money
// truth for that date. Server-written only; readable by both booking sides.
export interface PaymentDoc {
  bookingId: string; gigId: string; occurrenceStartsAt: number;
  curatorProfileId: string; musicianProfileId: string; selfDeal: boolean;
  baseCents: number;                       // this occurrence's expected total (frozen terms, ITS OWN duration for perHour)
  deposit: DepositState;
  settlement: SettlementState;
  transfer: TransferState;
  createdAt: number; updatedAt: number;
}

export type PaymentSummaryState = "current" | "past_due" | "delinquent";
export interface PaymentSummary {
  state: PaymentSummaryState; heldCents: number; paidCents: number; transferredCents: number;
}

// SP5 Task 13: the MOST RECENT completed payout request for a profile, kept on
// the identity doc as the replay memo for `requestPayout`.
//
// WHY IT EXISTS. Payout idempotency is scoped to a client-minted `requestId`
// (not a timestamp), so a retried call reuses the same Stripe key and Stripe
// replays the original payout instead of making a second one. But the
// callable's own available-balance pre-check runs BEFORE that key is ever
// used, and the first call already spent the balance, so a retry of a
// full-balance cash-out would be refused with "that's more than your available
// balance" and the caller would never learn the payout id. This record is what
// makes such a retry return the original result: same `requestId` ⇒ hand back
// the stored outcome, no Stripe call, no balance check.
//
// ONLY THE LAST ONE is kept, a retry of an OLDER requestId falls through to
// the ordinary path, where the balance check (or Stripe's own key replay) still
// makes a second payout impossible. Retries happen seconds after the original,
// which is exactly the window "last" covers.
export interface PayoutRequestRecord {
  requestId: string;
  payoutId: string;
  method: "standard" | "instant";
  amountCents: number;                     // gross, what left the balance in total
  feeCents: number;                        // instant fee (0 for standard)
  netCents: number;                        // what the payout itself moved
  at: number;
}

// profiles/{profileId}/private/stripe, members + admins read, server-write.
// One profile can hold both halves (a curator that also performs).
export interface StripeProfileDoc {
  customerId: string | null;               // curator half
  defaultPaymentMethodId: string | null; cardBrand: string | null; cardLast4: string | null;
  accountId: string | null;                // musician half (Express)
  transfersEnabled: boolean; payoutsEnabled: boolean; instantEligible: boolean;
  onboardingStartedAt: number | null; onboardedAt: number | null;
  delinquent: boolean; delinquentSince: number | null;
  // Optional/backward-compatible: every pre-Task-13 doc omits it, and a
  // profile that has never cashed out never gets it.
  lastPayout?: PayoutRequestRecord | null;
  // Owner ruling (M3): epoch ms until which INSTANT payouts are held on this
  // profile because self-deal-funded money landed in its balance. null/absent =
  // no hold. Set by the forfeit/earnings transfer sites for a `selfDeal`
  // booking; requestPayout refuses an instant payout while `now < instantHoldUntil`.
  // Standard payouts are unaffected.
  instantHoldUntil?: number | null;
  updatedAt: number;
}

// adminAlerts/{alertId}, SP5 Task 9, extended through Task 11. The money
// paths have ABSORBING states: conditions they deliberately refuse to act on
// (a charge that must not be replayed on an expired idempotency key, a marker
// that must not be cleared, an intent that might still capture) and can only
// escalate. A console.error alone is not an escalation, nobody is reading logs
// at 3am, so each one also upserts a doc here, which is the durable "a human
// has to look at this" queue. Server-written only; admins read it. Cleared by
// an operator tool (releaseStuckSaga) setting resolvedAt.
//
// RAISED BY (the kinds below, and where from):
//   paymentsSweep.ts    step 1 -> stuck_saga_marker / stale_accept_saga
//                       step 2 -> stale_pending_deposit
//                       step 3 -> deposit_pending_stuck
//                       step 7 -> expired_booking_saga_marker
//   paymentsSettlement.ts  chargeSettlement           -> settlement_pending_stuck
//                          finalizeSettlementSuccess  -> settlement_raced,
//                                                        settlement_payout_blocked
//                          finalizeDepositPayDue's
//                            webhook caller           -> deposit_raced
//   paymentsPayouts.ts     requestPayout              -> payout_fee_uncollected
//
// Ids are DETERMINISTIC per underlying problem and are built ONLY by
// paymentsCore.ts's id vocabulary (`stuckSagaAlertId` and friends), so an
// hourly sweep updates one row rather than minting 24 a day. TWO ids are
// deliberately SHARED by more than one kind, `stuck-saga:{bookingId}` covers
// all three saga kinds, and `settlement-raced:{...}` covers both shapes of
// "money moved and no state records it", because each shared set is one
// problem for one operator. recordAdminAlert re-logs whenever the KIND changes
// on an existing row, so a condition changing shape is still visible.
export type AdminAlertKind =
  | "stuck_saga_marker"            // marker set on a booking that is no longer `open`
  | "stale_accept_saga"            // staged >24h, its charge key can no longer be replayed
  | "expired_booking_saga_marker"  // an expired booking whose deposits are still a live saga's
  | "stale_pending_deposit"        // `*_pending` >24h, its refund/transfer key can no longer be re-issued
  // SP5 Task 10: a settlement's money moved (charge and/or earnings transfer)
  // but its terminal write lost a race to a concurrent waive, a post-transfer
  // reportNoShow is the one path that can do this. Nothing automatic can
  // decide whether to refund it or re-settle it, so it is escalated.
  | "settlement_raced"
  // SP5 Task 10: a settlement charge whose fate is unknown and which is
  // therefore NEVER re-charged. Two shapes: an intent left `processing` that
  // never resolved, and (Task 10 review, I2) a pre-charge claim older than
  // Stripe's 24h key window that never recorded an intent at all. Either way
  // a "retry" past that window would mint a real SECOND charge, so the row
  // sits here until the webhook finalizes it or an operator resolves it in
  // Stripe.
  | "settlement_pending_stuck"
  // SP5 Task 10 review (M1): the settlement is fully priced and the curator's
  // side is done, but the MUSICIAN has no Stripe payout account, so the
  // earnings transfer cannot be made and the doc is left unsettled. Distinct
  // from the two above because nothing is stuck in Stripe and no money is at
  // risk of moving twice, the fix is the musician finishing (or repairing)
  // Express onboarding, after which the ordinary sweep settles it.
  | "settlement_payout_blocked"
  // SP5 Task 9/11: a BIRTH deposit left `unpaid` while carrying an intent, a
  // charge that came back `processing` and never resolved, or an on-session
  // pay-now intent the curator never confirmed. The deposit twin of
  // `settlement_pending_stuck`, and refused for the identical reason: that
  // intent can still succeed, so a fresh-key retry past Stripe's 24h window
  // would be a real second charge. Sits here until an operator resolves the
  // intent in Stripe (there is no birth-deposit webhook finalizer).
  | "deposit_pending_stuck"
  // SP5 Task 11: a pay-now deposit whose intent Stripe confirmed AFTER a racer
  // (a cancellation, a waive) had already claimed the doc, money captured,
  // escrow that does not exist. The deposit twin of `settlement_raced`: the
  // ledger row is written from Stripe's own attested amount so the charge is
  // never invisible, and the unwind (refund it) is an operator's call.
  | "deposit_raced"
  // SP5 Task 12: the post-transfer no-show CLAWBACK could not complete. Three
  // shapes, one ticket, because an operator resolves them the same way (look at
  // what Stripe actually holds for this occurrence, then finish the unwind by
  // hand): the transfer reversal or one of the two refunds threw; the terminal
  // write lost its race after the money had already come back; or the reported
  // occurrence is `paid` with NO transfer to reverse, so the automatic unwind
  // has no handle on it at all. The curator has been charged for a date they
  // report never happened, so this is never merely logged.
  | "clawback_failed"
  // SP5 Task 13: an INSTANT payout was made but the platform's 4% fee could
  // not be pulled back off the connected account (the account debit threw).
  // The payout is NEVER unwound for this, the musician has their money and
  // reversing a paid-out instant payout is not a thing, so the fee is simply
  // uncollected revenue until an operator recovers it (debit the account by
  // hand, or net it off a future payout). The ONE alert kind in SP5 that is
  // profile-scoped rather than booking-scoped: its row carries a null
  // bookingId/gigId and names the profile in `detail`.
  | "payout_fee_uncollected"
  // SP6 Task 6: an event cancellation's order-level money move (the full
  // refund of a paid order, or the PaymentIntent cancel + expiry of a pending
  // one) failed. Covers both cases with one kind, the same way stuck-saga's
  // three kinds share one operator remedy: either way, this order is not yet
  // resolved for its cancelled event and the sweep's retry step will try it
  // again next hour. bookingId/gigId are always null (ticket orders are not
  // booking-scoped); the order and event ids are named in `detail`.
  | "ticket_cancel_refund_failed"
  // SP6 Task 7: a T+1 ticket settlement transfer could not be made because
  // the curator has no payout-ready Stripe account (no connected account, or
  // one that has not finished onboarding). bookingId/gigId are always null
  // (event-scoped, like ticket_cancel_refund_failed above); the event is
  // named in `detail` and left "published" so the sweep retries it every
  // pass until the curator finishes onboarding.
  | "ticket_settlement_blocked"
  // SP6 Task 7 fix round 1 (money review, Critical 1d): a T+1 ticket
  // settlement transfer was attempted (the curator IS payout-ready) but
  // Stripe returned an unexpected error. bookingId/gigId are always null
  // (event-scoped, like the two kinds above); the event and the failure are
  // named in `detail`. Distinct from ticket_settlement_blocked, which never
  // reaches Stripe at all: this kind means the call was made and refused, not
  // that it was withheld.
  | "ticket_settlement_failed"
  // SP6 Task 8 fix round 1 (security review, Important, silent money drift):
  // refundTicket's Stripe refund succeeded, but the ticket it was refunding
  // had (raced) become "transferred" out from under it, AND the CURRENT
  // live descendant ticket could not be automatically torn down to match
  // (it was already refunded, already checked in, missing, or ambiguous).
  // bookingId/gigId are always null (ticket-scoped, like the two kinds
  // above); the ticket id, order id, and amount are named in `detail`.
  // Never a silent no-op: refundTicket THROWS after raising this, so the
  // caller (and the curator) sees the refund did not cleanly resolve.
  | "ticket_refund_convergence_failed"
  // SP10 hardening: a Stripe dispute was opened against a platform charge;
  // reversing the money for a lost dispute failed and needs an operator; a
  // refund was issued outside the normal flows and needs reconciling; a
  // ticket order has sat unresolved (pending, unpaid) past its stuck window.
  | "dispute_opened" | "dispute_reversal_failed" | "external_refund" | "ticket_order_stuck"
  // SP10 Task 10 fix round 1: an event whose moderation cancel-and-refund
  // keeps failing; ticket holders may be unrefunded, resolve manually.
  | "event_cascade_stuck";
export interface AdminAlertDoc {
  kind: AdminAlertKind;
  detail: string;
  // Null ONLY for `payout_fee_uncollected` (see above), every other kind is
  // raised about a specific occurrence of a specific booking.
  bookingId: string | null; gigId: string | null;
  // The start of the ORIGINAL episode, preserved across reopens: a sweep that
  // observes this condition again after an operator set `resolvedAt` clears
  // that field but never re-stamps this one, so "how long has this money been
  // stuck" keeps measuring from when it first got stuck, not from the last
  // time someone tried to close the ticket. A genuinely new episode gets a new
  // row only when the underlying problem is a different (bookingId, gigId).
  firstSeenAt: number;
  lastSeenAt: number;
  // How many times this condition has been OBSERVED, not how many runs it has
  // survived, and not a sweep-only counter: one sweep run can observe the same
  // stuck booking from two different steps (step 1's marker guard and step 7's)
  // and both count, and the callable/webhook raisers (a raced settlement, a
  // raced pay-now deposit) increment it the same way.
  runCount: number;
  resolvedAt: number | null;
}

export type LedgerKind = "deposit_charged" | "settlement_charged" | "refund"
  | "forfeit_transfer" | "earnings_transfer" | "late_fee" | "payout_standard"
  | "payout_instant" | "transfer_reversal" | "account_debit"
  // SP5 Task 13: a payout Stripe later BOUNCED (`payout.failed`, a closed
  // bank account, a rejected debit card). The `payout_standard`/`payout_instant`
  // row is written when the payout is REQUESTED, so this is the row that
  // records the money coming back to the connected account's balance; without
  // it a failed payout would be indistinguishable in the ledger from a paid
  // one. Keyed off the payout's own id, so it can never collide with the
  // request-time row (different kind, same object).
  | "payout_failed"
  // SP6 Task 5: a completed ticket order (paid or free). Keyed deterministically
  // off the order's own id (writeLedger's `{kind}:{stripeId}` doc-id discipline,
  // stripeId set to orderId here since a free order has no PaymentIntent at all),
  // so a redelivered webhook and a racing finalize/webhook pair can never double
  // count the same order.
  | "ticket_sale"
  // SP6 Task 6: an event cancellation's automatic full refund of one order's
  // remaining balance. Keyed off the order id (same discipline as ticket_sale
  // above), so a cancelEvent retry (the callable called twice, or the sweep's
  // retry step re-driving the same loop) never double-counts one order's row.
  | "ticket_cancel_refund"
  // SP6 Task 6: a curator's per-ticket grace refund. Keyed off the ticket id
  // (not the order id: one order can carry several of these rows, one per
  // refunded ticket), so a duplicate refundTicket call for the same ticket
  // never double-counts.
  | "ticket_grace_refund"
  // SP6 Task 7: the T+1 post-event payout of ticket face value to the
  // curator's connected account. Keyed off the transfer id (writeLedger's
  // `{kind}:{stripeId}` doc-id discipline), so a sweep retry that reissues
  // the same idempotency key and gets back the same transfer never
  // double-counts the payout.
  | "ticket_settlement"
  // SP10 hardening: a Stripe dispute (chargeback) was opened against a
  // charge this platform made, and its two possible resolutions; and a
  // refund issued outside the normal cancellation/refund flows (an operator
  // acting directly in Stripe, reconciled back into the ledger).
  | "dispute_opened" | "dispute_lost" | "dispute_won" | "external_refund";
export interface LedgerEntry {
  kind: LedgerKind;
  amountCents: number;                     // ALWAYS positive/absolute, direction (in vs out, curator vs musician) comes from `kind`, never from sign
  bookingId: string | null; gigId: string | null; profileId: string | null;
  stripeId: string | null;                 // PaymentIntent/transfer/payout/refund id
  detail: string; at: number;
  // SP6 ticketing rows only (eventId/buyerUid have no SP5 booking-money
  // equivalent, so every SP5 entry simply omits them). Optional so every
  // existing SP5 call site keeps compiling unchanged.
  eventId?: string | null; buyerUid?: string | null;
  // SP10 hardening: true when this row's money was sourced from a specific
  // upstream charge/transfer this platform can point to (as opposed to a
  // manual/reconciliation entry). Optional so every pre-SP10 ledger row and
  // write site stays valid; absent is treated as false.
  sourced?: boolean;
}

export interface DisputeRecord {
  chargeId: string; intentId: string;
  purpose: "deposit" | "settlement" | "paydue" | "paydue_deposit" | "tickets";
  bookingId?: string; gigId?: string; orderId?: string;
  curatorProfileId: string | null;      // null for a ticket order (the fan paid)
  amountCents: number; feeCents: number; reason: string;
  status: "open" | "won" | "lost";
  reversalTransferId?: string;
  openedAt: number; closedAt?: number;
}
export interface PosterUploadDoc { path: string; createdAt: number; }

// ---------- Sub-project 6: events & ticketing ----------

export type EventStatus = "draft" | "published" | "completed" | "cancelled";
export type EventAct =
  | { kind: "booking"; bookingId: string; musicianProfileId: string; name: string }
  | { kind: "external"; name: string };
export interface EventDoc {
  curatorProfileId: string; title: string; description: string;
  location: GigPublicLocation;             // reuses SP3's public-precision location type
  startsAt: number; endsAt: number;
  posterPath: string | null;               // a processed "poster" photo path belonging to the curator profile
  status: EventStatus;
  maxTicketsPerBuyer: number;              // default 8
  lineup: EventAct[];
  // Server-maintained projection of lineup's "booking" acts' musicianProfileId
  // values, kept in sync wherever lineup is written. Task 9's musician public
  // page query (array-contains on this field) needs a flat array rather than
  // scanning lineup's discriminated-union entries per read.
  lineupMusicianProfileIds: string[];
  gigId: string | null;                    // set when promoted from a filled gig
  createdAt: number; updatedAt: number;
  cancelledAt?: number; completedAt?: number;
  // SP6 Task 7: epoch ms the "starts within 24h" reminder was sent, stamped
  // once by the daily sweep so a second run never re-notifies the same
  // event's attendees. Absent means "not yet reminded" (every pre-Task-7
  // event, and every event whose startsAt is still more than 24h out).
  reminderSentAt?: number;
  // SP6 Task 7 fix round 1 (money review, Critical 1 / Important 2): epoch ms
  // the T+1 ticket settlement transfer was first claimed, stamped exactly
  // once (transactionally, iff unset) immediately before paymentsSweep.ts
  // calls Stripe. Two jobs: it is the CAS a retried sweep pass reads to
  // replay the SAME transfer call rather than starting a fresh one, and it is
  // the guard cancelEventCore checks to refuse a cancellation once settlement
  // has begun, closing the window where a cancel would refund every buyer on
  // top of a transfer the curator already received. Absent means settlement
  // has never started for this event (every pre-fix-round-1 event, and every
  // event not yet past its T+1 window).
  settlementStartedAt?: number;
  // SP7: server-derived discovery projections. Absent on pre-SP7 docs: readers
  // treat absence as [] / null / false. genres = curatorGenres when set, else
  // the union of lineup booking acts' portfolio.genres (max 5).
  genres?: string[];
  curatorGenres?: string[];
  priceFromCents?: number | null;
  hasFreeTier?: boolean;
  // SP10 hardening: epoch ms a settlement/takedown-adjacent claim was made
  // against this event (distinct from settlementStartedAt's Stripe-transfer
  // CAS above), used by the hardening sweep's own claim discipline. Optional;
  // absent means "no claim in flight".
  settlementClaimedAt?: number;
}
export interface TicketTierDoc {
  name: string; priceCents: number;        // 0 = free RSVP
  capacity: number; soldCount: number;     // server-maintained
  saleStartsAt: number | null; saleEndsAt: number | null;
  sortOrder: number;
}
export interface TicketFeePolicy { ticketFeePct: number; ticketFeeFixedCents: number; ticketFeeCapCents: number; }
// "cancelled": released by the buyer through cancelTicketOrder (SP10 Task 21);
// nothing was charged. "expired": released by the expiry sweep.
export type TicketOrderStatus = "pending" | "paid" | "expired" | "cancelled" | "cancelled_refunded";
export interface TicketOrderItem { tierId: string; quantity: number; unitPriceCents: number; tierName: string; }
export interface TicketOrderDoc {
  buyerUid: string; eventId: string; curatorProfileId: string;
  items: TicketOrderItem[];
  faceTotalCents: number; serviceFeeCents: number;
  feePolicy: TicketFeePolicy;              // snapshotted at order creation, mirrors SP5's FeePolicy discipline
  paymentIntentId: string | null;          // null for free orders
  status: TicketOrderStatus;
  refundedTicketIds: string[]; refundedCents: number;
  // Face-value portion of refundedCents only (excludes any refunded service
  // fee). Initialized 0 wherever an order is born; Task 6 maintains it on
  // every refund, Task 7 reads it to compute the curator's T+1 payout base
  // (100% of face value of paid, non-refunded tickets).
  refundedFaceCents: number;
  createdAt: number; expiresAt: number; paidAt?: number;
  // SP10 hardening: set when a buyer disputes (charges back) this order's
  // PaymentIntent; mirrors DisputeRecord's status for a quick read off the
  // order itself. Optional; absent means "no dispute".
  disputeId?: string;
  disputeStatus?: "open" | "won" | "lost";
}
export type TicketStatus = "valid" | "checked_in" | "refunded" | "transferred";
export interface TicketDoc {
  eventId: string; tierId: string; tierName: string; orderId: string;
  curatorProfileId: string;
  qrSecret: string;                        // server-minted, owner-readable, possession = door proof
  status: TicketStatus;
  createdAt: number; checkedInAt?: number; transferredTo?: string;
}
export interface AttendeeDoc {             // events/{eventId}/attendees/{ticketId}, server-written projection
  ownerUid: string; ownerName: string; tierId: string; tierName: string;
  status: TicketStatus; checkedInAt?: number;
}
// Task 8 fix round 1 (security review, money drift): "voided" is a distinct
// terminal status from "declined": the recipient never chose anything here.
// A curator's grace refund on the underlying ticket, run BEFORE the Stripe
// call, transactionally flips any still-"offered" transfer for that ticket
// to "voided" so no accept can complete against a ticket about to be
// refunded out from under it. Both "declined" and "voided" are equally
// terminal to respondToTransfer/offerTransfer (either simply fails the
// `status === "offered"` check), so nothing downstream needs to distinguish
// the two beyond the audit trail this value preserves.
export type TicketTransferStatus = "offered" | "accepted" | "declined" | "expired" | "voided";
export interface TicketTransferDoc {
  ticketId: string; eventId: string; fromUid: string; toUid: string;
  status: TicketTransferStatus; createdAt: number; expiresAt: number; resolvedAt?: number;
}
// users/{uid}/ticketIndex/{eventId}: the valid-ticket proof firestore.rules
// reads to prove a caller holds a ticket for THIS event, without a rules
// read against the tickets collection itself. Server-written only.
export interface TicketIndexDoc { count: number }

// ---------- Sub-project 7: fan discovery ----------

export type FollowTargetType = "musician" | "curator" | "genre";
export interface FollowDoc {
  uid: string;
  targetId: string;                 // profileId, or "genre:<name>" (name from GENRES)
  targetType: FollowTargetType;
  createdAt: number;
}
export const MAX_FOLLOWS_PER_USER = 500;

export type ShowPostStatus = "live" | "removed";
export interface ShowPostDoc {
  eventId: string;
  musicianProfileId: string;
  authorUid: string;
  text: string;                     // 1..SHOW_POST_MAX_CHARS after trim
  createdAt: number;
  status: ShowPostStatus;
  removedBy?: "author" | "admin";
  removedAt?: number;
}
export const SHOW_POST_MAX_CHARS = 280;
export const SHOW_POST_MAX_PER_EVENT = 3;
export const SHOW_POST_MIN_INTERVAL_MS = 10 * 60 * 1000;

export const DECK_PAGE_SIZE = 20;
export const DECK_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
export const DECK_MAX_EXCLUDE_IDS = 200;
export type DeckPreview = { trackPath: string; startSec: number; durationSec: number; artistName: string } | null;
export type DeckNextShow = { eventId: string; title: string; venueName: string; startsAt: number } | null;
export type DeckCard =
  | { kind: "show"; id: string; eventId: string; title: string; startsAt: number; endsAt: number;
      venueName: string; neighborhood: string | null; distanceMeters: number | null; posterPath: string | null;
      lineupNames: string[]; curatorProfileId: string; curatorHandle: string | null;
      priceFromCents: number | null; hasFreeTier: boolean;
      latestPost: { text: string; artistName: string } | null; genres: string[]; preview: DeckPreview }
  | { kind: "artist"; id: string; profileId: string; handle: string; name: string; subtype: MusicianSubtype;
      genres: string[]; coverPhotoPath: string | null; avatarPhotoPath: string | null;
      nextShow: DeckNextShow; preview: DeckPreview }
  | { kind: "venue"; id: string; profileId: string; handle: string; name: string; neighborhood: string | null;
      distanceMeters: number | null; photoPath: string | null; genres: string[];
      nextShow: DeckNextShow; preview: DeckPreview };
export interface GetDiscoverDeckInput {
  location?: { lat: number; lng: number };
  excludeIds?: string[];
  seed?: number;
}
export interface GetDiscoverDeckResult { cards: DeckCard[]; seed: number; }
