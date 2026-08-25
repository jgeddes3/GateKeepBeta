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
  status: "pending" | "accepted" | "declined";
  createdAt: number;
}

export interface AuditLogDoc {
  actorUid: string;
  action: "profile_approved" | "profile_rejected" | "admin_granted";
  targetId: string;          // profileId or uid
  detail: string;
  at: number;
}

export interface NotificationDoc {
  title: string;
  body: string;
  kind: "profile_review" | "system";
  read: boolean;
  createdAt: number;
}

export interface ProfileDraftInput {
  type: ProfileType;
  subtype: string;
  name: string;
  handle: string;
}
