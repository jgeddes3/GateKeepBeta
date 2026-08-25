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
    | "track_approved" | "track_rejected";
  targetId: string;          // profileId or uid
  detail: string;
  at: number;
}

export interface NotificationDoc {
  title: string;
  body: string;
  kind: "profile_review" | "track_review" | "system";
  read: boolean;
  createdAt: number;
}

export interface ProfileDraftInput {
  type: ProfileType;
  subtype: string;
  name: string;
  handle: string;
}

// ---------- Sub-project 2: musician portfolio ----------

export type TrackStatus = "processing" | "pending_review" | "approved" | "rejected" | "failed";

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
export type ActSize = "solo" | "duo" | "band";
export type AvailabilityPattern = "weekends" | "weeknights" | "anytime" | "limited";
export interface BookingPreferences {
  gigTypes: string[];            // subset of GIG_TYPES
  travelRadiusKm: number | null;
  actSize: ActSize | null;
  typicalSetMinutes: number | null;
  bringsOwnPA: boolean | null;
  availabilityPattern: AvailabilityPattern | null;
}
// profiles/{profileId}/private/booking — members + admins only (sub-3 widens to curators)
export interface BookingDoc { rates: BookingRates; preferences: BookingPreferences; updatedAt: number; }

export interface PortfolioUpdateInput {
  profileId: string;
  bio?: string;
  genres?: string[];
  externalLinks?: ExternalLink[];
}
export interface BookingUpdateInput { profileId: string; rates: BookingRates; preferences: BookingPreferences; }
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
