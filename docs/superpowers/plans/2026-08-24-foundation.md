# GateKeep Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A running GateKeep app on iOS, Android, and web where people sign in, create musician/curator profiles that go through team approval, switch contexts, and receive notifications, with the monorepo, Firebase backend, security rules, and admin dashboard that every later sub-project builds on.

**Architecture:** pnpm monorepo: Expo mobile app + Next.js web app sharing one Firebase backend (Auth, Firestore, Cloud Functions, App Check) and one `@gatekeep/shared` types/validation package. All privileged mutations (profile status, memberships, admin claims) go through Cloud Functions; Firestore rules are default-deny. Everything is developed and tested against the Firebase Emulator Suite.

**Tech Stack:** TypeScript (strict) everywhere · pnpm workspaces · Expo SDK 53+ with expo-router and expo-dev-client · Next.js 15+ App Router · Firebase (Auth, Firestore, Cloud Functions v2 callables, App Check, Emulator Suite) · vitest · @firebase/rules-unit-testing

**Spec:** `docs/superpowers/specs/2026-08-24-foundation-design.md`

## Global Constraints

- Node 20+, pnpm 9+. TypeScript `strict: true` in every package.
- Firebase region: `us-central1`. Dev project id: `gatekeep-dev` (create at Task 2; if the console assigns a different id, use that id everywhere `gatekeep-dev` appears).
- Sign-in methods: email/password, Google, Apple, a user picks exactly ONE; no account linking (spec §4).
- Clients may NEVER write: `profiles.status`, any `members` doc, `handles`, `auditLogs`, `admin` claims. These change only via Cloud Functions (spec §7, §8).
- Firestore rules are default-deny. Every rules change must pass the `firebase-security-rules-auditor` skill before deploy (spec §8).
- Run the `security-review` skill on the branch before final merge (spec §8).
- All tests run against the Firebase Emulator Suite, never against a live project.
- Expo: use a dev build (`expo-dev-client`); Expo Go cannot do Google/Apple native sign-in.
- Reserved handles list must include at minimum: `admin`, `gatekeep`, `support`, `help`, `api`, `www` (spec §8).
- Commit at the end of every task (and at any green-test checkpoint inside a task).

## File Structure

```
GateKeepBeta/
├── package.json                  # workspace root, scripts
├── pnpm-workspace.yaml
├── tsconfig.base.json            # shared strict TS config
├── firebase.json                 # emulators, functions, firestore, hosting targets
├── .firebaserc
├── firestore.rules               # default-deny + narrow allows
├── firestore.indexes.json
├── packages/shared/
│   ├── src/types.ts              # UserDoc, ProfileDoc, MemberDoc, InviteDoc, ... (single source of truth)
│   ├── src/validation.ts         # validateHandle, RESERVED_HANDLES, validateProfileDraft
│   └── src/index.ts              # re-exports
├── functions/
│   ├── src/index.ts              # exports all functions
│   ├── src/authTriggers.ts       # onUserCreated → users doc
│   ├── src/profiles.ts           # createProfileDraft, submitProfileForReview
│   ├── src/review.ts             # reviewProfile, grantAdmin, audit logging
│   ├── src/members.ts            # inviteMember, respondToInvite, removeMember, transferAdmin
│   ├── src/account.ts            # deleteAccount
│   ├── src/notifications.ts      # push token helpers, notifyUser, approval trigger
│   └── test/*.test.ts            # emulator integration tests
├── apps/mobile/                  # Expo: app/ (expo-router), src/lib/firebase.ts, src/auth/, src/shell/
└── apps/web/                     # Next.js: app/ (App Router), src/lib/firebase.ts
    └── app/admin/                # team dashboard (claim-gated)
```

Responsibilities: `packages/shared` owns every cross-boundary type and validation rule, functions and both apps import from it, nothing redefines a shape locally. `functions` owns every privileged mutation. Apps own UI and only ever read Firestore directly or call callables.

---

### Task 1: Monorepo scaffold + shared package

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `.gitignore`
- Create: `packages/shared/package.json`, `packages/shared/tsconfig.json`, `packages/shared/src/types.ts`, `packages/shared/src/validation.ts`, `packages/shared/src/index.ts`
- Test: `packages/shared/test/validation.test.ts`

**Interfaces:**
- Consumes: nothing (first task)
- Produces: package `@gatekeep/shared` exporting the types below and `validateHandle(handle: string): { ok: true } | { ok: false; reason: string }`, `RESERVED_HANDLES: readonly string[]`, `validateProfileDraft(input: ProfileDraftInput): { ok: true } | { ok: false; reason: string }`. Later tasks import these exact names.

- [ ] **Step 1: Root workspace files**

`pnpm-workspace.yaml`:
```yaml
packages:
  - "packages/*"
  - "apps/*"
  - "functions"
```

`package.json` (root):
```json
{
  "name": "gatekeep",
  "private": true,
  "engines": { "node": ">=20" },
  "scripts": {
    "test": "pnpm -r test",
    "typecheck": "pnpm -r typecheck"
  }
}
```

`tsconfig.base.json`:
```json
{
  "compilerOptions": {
    "strict": true,
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true
  }
}
```

`.gitignore`: `node_modules/`, `dist/`, `.env*`, `*.log`, `.firebase/`, `.expo/`, `.next/`

- [ ] **Step 2: Shared package skeleton**

`packages/shared/package.json`:
```json
{
  "name": "@gatekeep/shared",
  "version": "0.0.1",
  "type": "module",
  "main": "src/index.ts",
  "types": "src/index.ts",
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": { "typescript": "^5.6.0", "vitest": "^2.0.0" }
}
```

`packages/shared/tsconfig.json`:
```json
{ "extends": "../../tsconfig.base.json", "include": ["src", "test"] }
```

- [ ] **Step 3: Write the types (spec §3 verbatim)**

`packages/shared/src/types.ts`:
```typescript
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
```

- [ ] **Step 4: Write failing validation tests**

`packages/shared/test/validation.test.ts`:
```typescript
import { describe, it, expect } from "vitest";
import { validateHandle, validateProfileDraft, RESERVED_HANDLES } from "../src/index";

describe("validateHandle", () => {
  it("accepts lowercase letters, digits, underscores, 3-30 chars", () => {
    expect(validateHandle("midnight_owls9")).toEqual({ ok: true });
  });
  it("rejects reserved handles", () => {
    expect(validateHandle("admin").ok).toBe(false);
    expect(RESERVED_HANDLES).toContain("gatekeep");
  });
  it("rejects uppercase, spaces, symbols, short, long", () => {
    for (const bad of ["Ab", "has space", "sym!bol", "ab", "a".repeat(31)]) {
      expect(validateHandle(bad).ok).toBe(false);
    }
  });
});

describe("validateProfileDraft", () => {
  it("accepts a valid musician band draft", () => {
    expect(
      validateProfileDraft({ type: "musician", subtype: "band", name: "The Midnight Owls", handle: "midnight_owls" })
    ).toEqual({ ok: true });
  });
  it("rejects subtype not belonging to type", () => {
    expect(validateProfileDraft({ type: "musician", subtype: "venue", name: "X", handle: "xxx" }).ok).toBe(false);
  });
  it("rejects empty or >80 char names", () => {
    expect(validateProfileDraft({ type: "curator", subtype: "venue", name: "", handle: "abc" }).ok).toBe(false);
    expect(validateProfileDraft({ type: "curator", subtype: "venue", name: "a".repeat(81), handle: "abc" }).ok).toBe(false);
  });
});
```

- [ ] **Step 5: Run tests, verify they fail**

Run: `pnpm install && pnpm --filter @gatekeep/shared test`
Expected: FAIL, `validateHandle` is not exported.

- [ ] **Step 6: Implement validation**

`packages/shared/src/validation.ts`:
```typescript
import type { ProfileDraftInput } from "./types";

export const RESERVED_HANDLES = [
  "admin", "gatekeep", "support", "help", "api", "www",
] as const;

const HANDLE_RE = /^[a-z0-9_]{3,30}$/;

export function validateHandle(handle: string): { ok: true } | { ok: false; reason: string } {
  if (!HANDLE_RE.test(handle)) {
    return { ok: false, reason: "Handles are 3-30 lowercase letters, digits, or underscores." };
  }
  if ((RESERVED_HANDLES as readonly string[]).includes(handle)) {
    return { ok: false, reason: "That handle is reserved." };
  }
  return { ok: true };
}

const SUBTYPES: Record<string, string[]> = {
  musician: ["solo", "band"],
  curator: ["venue", "planner", "individual_host"],
};

export function validateProfileDraft(input: ProfileDraftInput): { ok: true } | { ok: false; reason: string } {
  if (!SUBTYPES[input.type]?.includes(input.subtype)) {
    return { ok: false, reason: "Invalid profile type/subtype." };
  }
  if (input.name.trim().length < 1 || input.name.length > 80) {
    return { ok: false, reason: "Name must be 1-80 characters." };
  }
  return validateHandle(input.handle);
}
```

`packages/shared/src/index.ts`:
```typescript
export * from "./types";
export * from "./validation";
```

- [ ] **Step 7: Run tests, verify pass; typecheck**

Run: `pnpm --filter @gatekeep/shared test && pnpm --filter @gatekeep/shared typecheck`
Expected: all PASS.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: monorepo scaffold + @gatekeep/shared types and validation"
```

---

### Task 2: Firebase project + Emulator Suite

**Files:**
- Create: `firebase.json`, `.firebaserc`, `firestore.rules` (deny-all placeholder), `firestore.indexes.json`
- Create: `functions/package.json`, `functions/tsconfig.json`, `functions/src/index.ts` (empty export)

**Interfaces:**
- Consumes: nothing
- Produces: `pnpm emu` (root script) boots Auth/Firestore/Functions emulators on ports 9099/8080/5001 with UI on 4000. Every later task's tests assume these ports.

- [ ] **Step 1: Create the Firebase project (interactive, needs the user's Google account)**

Run: `npx -y firebase-tools@latest login` (skip if already logged in), then:
```bash
npx -y firebase-tools@latest projects:create gatekeep-dev --display-name "GateKeep Dev"
```
If the id is taken, accept the suggested alternative and use it in `.firebaserc` and everywhere this plan says `gatekeep-dev`.
Then in the [Firebase console](https://console.firebase.google.com) for the project: **Build → Authentication → Get started → enable Email/Password, Google, and Apple providers.** (Apple provider config completes fully only when the Apple Developer account exists; enabling it now is fine.)

- [ ] **Step 2: Create the Firestore instance**

Per the firebase-firestore skill: list locations, then create with the default (Enterprise) edition unless the CLI rejects it for this project type, in that case create Standard and note it in the commit message.
```bash
npx -y firebase-tools@latest firestore:locations --project gatekeep-dev
npx -y firebase-tools@latest firestore:databases:create "(default)" --location nam5 --project gatekeep-dev
```

- [ ] **Step 3: Config files**

`.firebaserc`:
```json
{ "projects": { "default": "gatekeep-dev" } }
```

`firebase.json`:
```json
{
  "firestore": { "rules": "firestore.rules", "indexes": "firestore.indexes.json" },
  "functions": { "source": "functions", "runtime": "nodejs20" },
  "emulators": {
    "auth": { "port": 9099 },
    "firestore": { "port": 8080 },
    "functions": { "port": 5001 },
    "ui": { "enabled": true, "port": 4000 }
  }
}
```

`firestore.rules` (placeholder until Task 4, deny everything):
```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} { allow read, write: if false; }
  }
}
```

`firestore.indexes.json` (the collection-group index Task 10's "my profiles" query needs):
```json
{ "indexes": [], "fieldOverrides": [
  { "collectionGroup": "members", "fieldPath": "uid",
    "indexes": [ { "queryScope": "COLLECTION_GROUP", "order": "ASCENDING" } ] } ] }
```

- [ ] **Step 4: Functions package skeleton**

`functions/package.json`:
```json
{
  "name": "functions",
  "type": "module",
  "main": "dist/index.js",
  "engines": { "node": "20" },
  "scripts": {
    "build": "tsc",
    "test": "vitest run --no-file-parallelism",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "firebase-admin": "^12.0.0",
    "firebase-functions": "^6.0.0",
    "@gatekeep/shared": "workspace:*"
  },
  "devDependencies": {
    "typescript": "^5.6.0",
    "vitest": "^2.0.0",
    "firebase": "^11.0.0"
  }
}
```

`functions/tsconfig.json`:
```json
{
  "extends": "../tsconfig.base.json",
  "compilerOptions": { "module": "NodeNext", "moduleResolution": "NodeNext", "outDir": "dist" },
  "include": ["src"]
}
```

`functions/src/index.ts`:
```typescript
// Functions are added task by task; this file re-exports them all.
export {};
```

Add to root `package.json` scripts:
```json
"emu": "firebase emulators:start",
"emu:test": "firebase emulators:exec --only auth,firestore,functions \"pnpm --filter functions test\""
```
Also add `firebase-tools` to root devDependencies: `pnpm add -w -D firebase-tools`.

- [ ] **Step 5: Verify emulators boot**

Run: `pnpm install && pnpm --filter functions build && pnpm emu` (then Ctrl-C after checking).
Expected: Emulator UI reachable at http://localhost:4000 with Auth, Firestore, Functions all green.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: firebase project config + emulator suite (deny-all rules placeholder)"
```

---

### Task 3: App scaffolds wired to the emulator

**Files:**
- Create: `apps/mobile/` (Expo app: `app/_layout.tsx`, `app/index.tsx`, `src/lib/firebase.ts`, `app.json`, `package.json`)
- Create: `apps/web/` (Next.js app: `app/layout.tsx`, `app/page.tsx`, `src/lib/firebase.ts`, `package.json`)

**Interfaces:**
- Consumes: emulator ports from Task 2.
- Produces: `getFirebase()` in each app's `src/lib/firebase.ts` returning `{ app, auth, db, functions }`, emulator-connected when `__DEV__`/`NODE_ENV !== "production"`. All later UI tasks import `getFirebase()` from this exact path.

- [ ] **Step 1: Scaffold Expo app**

```bash
cd apps && npx -y create-expo-app@latest mobile --template default && cd mobile
npx expo install expo-dev-client firebase @react-native-async-storage/async-storage
```
Set in `apps/mobile/package.json`: `"name": "@gatekeep/mobile"`, add `"@gatekeep/shared": "workspace:*"` to dependencies, and scripts `"typecheck": "tsc --noEmit"`, `"test": "echo no unit tests in mobile yet"`.
In `app.json` set `"scheme": "gatekeep"`, `"name": "GateKeep"`, `"slug": "gatekeep"`.

- [ ] **Step 2: Mobile firebase lib**

`apps/mobile/src/lib/firebase.ts`:
```typescript
import { initializeApp, getApps, type FirebaseApp } from "firebase/app";
// initializeAuth + AsyncStorage persistence: without this, RN sessions do NOT survive app restarts.
import {
  initializeAuth, getReactNativePersistence, connectAuthEmulator, type Auth,
} from "firebase/auth";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { getFirestore, connectFirestoreEmulator, type Firestore } from "firebase/firestore";
import { getFunctions, connectFunctionsEmulator, type Functions } from "firebase/functions";

// Public web-app config from Firebase console → Project settings → Your apps.
// These values are NOT secrets; security comes from rules + App Check.
const firebaseConfig = {
  apiKey: "REPLACE_FROM_CONSOLE",
  authDomain: "gatekeep-dev.firebaseapp.com",
  projectId: "gatekeep-dev",
  storageBucket: "gatekeep-dev.appspot.com",
  appId: "REPLACE_FROM_CONSOLE",
};

// Android emulator reaches the host machine at 10.0.2.2, not localhost.
import { Platform } from "react-native";
const EMU_HOST = Platform.OS === "android" ? "10.0.2.2" : "localhost";

let cached: { app: FirebaseApp; auth: Auth; db: Firestore; functions: Functions } | null = null;

export function getFirebase() {
  if (cached) return cached;
  const app = getApps()[0] ?? initializeApp(firebaseConfig);
  const auth = initializeAuth(app, { persistence: getReactNativePersistence(AsyncStorage) });
  const db = getFirestore(app);
  const functions = getFunctions(app, "us-central1");
  if (__DEV__) {
    connectAuthEmulator(auth, `http://${EMU_HOST}:9099`, { disableWarnings: true });
    connectFirestoreEmulator(db, EMU_HOST, 8080);
    connectFunctionsEmulator(functions, EMU_HOST, 5001);
  }
  cached = { app, auth, db, functions };
  return cached;
}
```

`app/index.tsx` (smoke screen):
```tsx
import { Text, View } from "react-native";
import { getFirebase } from "../src/lib/firebase";

export default function Index() {
  const { app } = getFirebase();
  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
      <Text>GateKeep, connected to {app.options.projectId}</Text>
    </View>
  );
}
```

- [ ] **Step 3: Scaffold Next.js app**

```bash
cd apps && npx -y create-next-app@latest web --typescript --app --no-tailwind --eslint --src-dir=false --import-alias "@/*" && cd web
pnpm add firebase && pnpm add -D vitest
```
Set `"name": "@gatekeep/web"`, add `"@gatekeep/shared": "workspace:*"`, script `"typecheck": "tsc --noEmit"`.

`apps/web/src/lib/firebase.ts`: same shape as mobile's, with three differences, use plain `getAuth(app)` (browser persistence is built in; no AsyncStorage/initializeAuth), the emulator guard is `process.env.NODE_ENV !== "production"`, and the host is always `localhost` (no Platform import). Config object identical.

`apps/web/app/page.tsx`:
```tsx
export default function Home() {
  return <main><h1>GateKeep</h1><p>Find the music. Book the night.</p></main>;
}
```

- [ ] **Step 4: Verify both apps run**

Run: `pnpm install`, then in parallel terminals: `pnpm emu`, `pnpm --filter @gatekeep/web dev` (http://localhost:3000 renders the landing line), `pnpm --filter @gatekeep/mobile exec expo start` (web preview or device shows "connected to gatekeep-dev").
Expected: both render; no red screens; emulator UI shows no errors.

- [ ] **Step 5: Typecheck everything and commit**

Run: `pnpm typecheck`
Expected: PASS across all packages.

```bash
git add -A
git commit -m "feat: expo + next.js scaffolds wired to firebase emulators"
```

---

### Task 4: Firestore security rules v1 + rules tests

**Files:**
- Modify: `firestore.rules` (replace deny-all placeholder)
- Create: `tests-rules/package.json`, `tests-rules/rules.test.ts`

**Interfaces:**
- Consumes: collection shapes from `@gatekeep/shared` (Task 1).
- Produces: the rules every later task operates under. Key facts for later tasks: clients can read their own `users/{uid}` and its subcollections; anyone can read `approved` profiles; members can read their own profile at any status; ALL writes to `profiles`, `members`, `handles`, `auditLogs`, `invites` are denied to clients (functions use the Admin SDK, which bypasses rules).

- [ ] **Step 1: Rules test harness**

`tests-rules/package.json`:
```json
{
  "name": "@gatekeep/tests-rules",
  "type": "module",
  "scripts": { "test": "vitest run --no-file-parallelism" },
  "devDependencies": {
    "@firebase/rules-unit-testing": "^4.0.0",
    "firebase": "^11.0.0",
    "vitest": "^2.0.0",
    "typescript": "^5.6.0"
  }
}
```
Add `tests-rules` to `pnpm-workspace.yaml` packages list. Add root script:
```json
"emu:rules": "firebase emulators:exec --only firestore \"pnpm --filter @gatekeep/tests-rules test\""
```

- [ ] **Step 2: Write failing rules tests**

`tests-rules/rules.test.ts`:
```typescript
import { describe, it, beforeAll, afterAll, beforeEach } from "vitest";
import {
  initializeTestEnvironment, assertSucceeds, assertFails, type RulesTestEnvironment,
} from "@firebase/rules-unit-testing";
import { readFileSync } from "node:fs";
import { doc, getDoc, setDoc, updateDoc } from "firebase/firestore";

let env: RulesTestEnvironment;

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: "gatekeep-dev",
    firestore: { rules: readFileSync("../firestore.rules", "utf8"), host: "localhost", port: 8080 },
  });
});
afterAll(async () => { await env.cleanup(); });
beforeEach(async () => { await env.clearFirestore(); });

const seed = async (path: string, data: object) => {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), path), data);
  });
};

describe("users", () => {
  it("owner reads and updates own doc; strangers cannot", async () => {
    await seed("users/alice", { displayName: "Alice", email: "a@x.com" });
    const alice = env.authenticatedContext("alice").firestore();
    const bob = env.authenticatedContext("bob").firestore();
    await assertSucceeds(getDoc(doc(alice, "users/alice")));
    await assertSucceeds(updateDoc(doc(alice, "users/alice"), { displayName: "Alice L" }));
    await assertFails(getDoc(doc(bob, "users/alice")));
    await assertFails(updateDoc(doc(bob, "users/alice"), { displayName: "hacked" }));
  });
  it("clients cannot create users docs (functions do)", async () => {
    const alice = env.authenticatedContext("alice").firestore();
    await assertFails(setDoc(doc(alice, "users/alice"), { displayName: "Alice" }));
  });
});

describe("profiles", () => {
  it("anyone (even signed out) reads approved; only members read pending", async () => {
    await seed("profiles/p1", { name: "Owls", status: "approved" });
    await seed("profiles/p2", { name: "Secret", status: "pending_review" });
    await seed("profiles/p2/members/alice", { uid: "alice", role: "admin" });
    const anon = env.unauthenticatedContext().firestore();
    const alice = env.authenticatedContext("alice").firestore();
    const bob = env.authenticatedContext("bob").firestore();
    await assertSucceeds(getDoc(doc(anon, "profiles/p1")));
    await assertSucceeds(getDoc(doc(alice, "profiles/p2")));
    await assertFails(getDoc(doc(bob, "profiles/p2")));
  });
  it("no client may write profiles, members, handles, auditLogs, invites", async () => {
    await seed("profiles/p1", { name: "Owls", status: "approved" });
    const alice = env.authenticatedContext("alice").firestore();
    await assertFails(updateDoc(doc(alice, "profiles/p1"), { status: "approved" }));
    await assertFails(setDoc(doc(alice, "profiles/p1/members/alice"), { role: "admin" }));
    await assertFails(setDoc(doc(alice, "handles/owls"), { profileId: "p1" }));
    await assertFails(setDoc(doc(alice, "auditLogs/x"), { action: "profile_approved" }));
    await assertFails(setDoc(doc(alice, "invites/i1"), { invitedUid: "alice" }));
  });
  it("members are readable by profile members and by anyone for approved profiles", async () => {
    await seed("profiles/p1", { name: "Owls", status: "approved" });
    await seed("profiles/p1/members/alice", { uid: "alice", role: "admin", label: "vocals" });
    const anon = env.unauthenticatedContext().firestore();
    await assertSucceeds(getDoc(doc(anon, "profiles/p1/members/alice")));
  });
});

describe("invites and notifications", () => {
  it("invitee reads own invite; others cannot", async () => {
    await seed("invites/i1", { invitedUid: "bob", profileId: "p1", status: "pending" });
    const bob = env.authenticatedContext("bob").firestore();
    const carol = env.authenticatedContext("carol").firestore();
    await assertSucceeds(getDoc(doc(bob, "invites/i1")));
    await assertFails(getDoc(doc(carol, "invites/i1")));
  });
  it("owner reads own notifications and may mark read, not create", async () => {
    await seed("users/alice", { displayName: "Alice" });
    await seed("users/alice/notifications/n1", { title: "Approved!", read: false });
    const alice = env.authenticatedContext("alice").firestore();
    const bob = env.authenticatedContext("bob").firestore();
    await assertSucceeds(updateDoc(doc(alice, "users/alice/notifications/n1"), { read: true }));
    await assertFails(getDoc(doc(bob, "users/alice/notifications/n1")));
    await assertFails(setDoc(doc(alice, "users/alice/notifications/n2"), { title: "fake" }));
  });
});
```

- [ ] **Step 3: Run tests, verify they fail**

Run: `pnpm install && pnpm emu:rules`
Expected: FAIL, deny-all rules reject the owner reads the tests assert succeed.

- [ ] **Step 4: Write the rules**

`firestore.rules`:
```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {

    function signedIn() { return request.auth != null; }
    function isOwner(uid) { return signedIn() && request.auth.uid == uid; }
    function isMember(profileId) {
      return signedIn()
        && exists(/databases/$(database)/documents/profiles/$(profileId)/members/$(request.auth.uid));
    }
    function profileApproved(profileId) {
      return get(/databases/$(database)/documents/profiles/$(profileId)).data.status == 'approved';
    }

    match /users/{uid} {
      allow read: if isOwner(uid);
      // Created by Cloud Functions; owner may update editable fields only.
      allow update: if isOwner(uid)
        && request.resource.data.diff(resource.data).affectedKeys()
             .hasOnly(['displayName', 'photoUrl', 'homeCity']);
      allow create, delete: if false;

      match /notifications/{noteId} {
        allow read: if isOwner(uid);
        allow update: if isOwner(uid)
          && request.resource.data.diff(resource.data).affectedKeys().hasOnly(['read']);
        allow create, delete: if false;
      }
      match /pushTokens/{tokenId} {
        allow read, write: if isOwner(uid);
      }
    }

    match /profiles/{profileId} {
      allow read: if resource.data.status == 'approved' || isMember(profileId);
      allow write: if false; // Cloud Functions only

      match /members/{memberUid} {
        // self-read clause serves the collection-group "my profiles" query
        allow read: if profileApproved(profileId) || isMember(profileId)
          || (signedIn() && request.auth.uid == resource.data.uid);
        allow write: if false; // Cloud Functions only
      }
    }

    match /invites/{inviteId} {
      allow read: if signedIn()
        && (request.auth.uid == resource.data.invitedUid
            || request.auth.uid == resource.data.invitedByUid);
      allow write: if false; // Cloud Functions only
    }

    match /handles/{handle}   { allow read: if true; allow write: if false; }
    match /auditLogs/{logId}  { allow read, write: if false; } // admin dashboard reads via Admin SDK API
    match /{document=**}      { allow read, write: if false; }
  }
}
```

- [ ] **Step 5: Run tests, verify pass**

Run: `pnpm emu:rules`
Expected: all PASS.

- [ ] **Step 6: Audit the rules**

Invoke the `firebase-security-rules-auditor` skill on `firestore.rules`. Fix anything it flags, re-run `pnpm emu:rules`, repeat until clean.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: default-deny firestore rules with tested narrow allows"
```

---

### Task 5: Auth trigger, users doc on signup

**Files:**
- Create: `functions/src/authTriggers.ts`
- Modify: `functions/src/index.ts`
- Test: `functions/test/authTriggers.test.ts`, `functions/test/helpers.ts`

**Interfaces:**
- Consumes: `UserDoc` from `@gatekeep/shared`.
- Produces: Auth `onCreate` trigger `onUserCreated` writing `users/{uid}` per `UserDoc`. Test helper `signUpTestUser(email: string): Promise<{ uid: string; idToken: string; user: User }>` and `callFn<T, R>(name: string, data: T, asUser?: User): Promise<R>` in `functions/test/helpers.ts`, reused by Tasks 6-8, 13, 14.

- [ ] **Step 1: Test helpers (client SDK pointed at emulators)**

`functions/test/helpers.ts`:
```typescript
import { initializeApp, getApps } from "firebase/app";
import {
  getAuth, connectAuthEmulator, createUserWithEmailAndPassword, type User,
} from "firebase/auth";
import { getFirestore, connectFirestoreEmulator } from "firebase/firestore";
import { getFunctions, connectFunctionsEmulator, httpsCallable } from "firebase/functions";

const app = getApps()[0] ?? initializeApp({ projectId: "gatekeep-dev", apiKey: "fake-key", appId: "fake" });
export const auth = getAuth(app);
export const db = getFirestore(app);
const fns = getFunctions(app, "us-central1");
connectAuthEmulator(auth, "http://localhost:9099", { disableWarnings: true });
connectFirestoreEmulator(db, "localhost", 8080);
connectFunctionsEmulator(fns, "localhost", 5001);

export async function signUpTestUser(email: string) {
  const cred = await createUserWithEmailAndPassword(auth, email, "test-password-1");
  return { uid: cred.user.uid, idToken: await cred.user.getIdToken(), user: cred.user };
}

export async function callFn<T, R>(name: string, data: T, asUser?: User): Promise<R> {
  if (asUser) await auth.updateCurrentUser(asUser);
  const res = await httpsCallable<T, R>(fns, name)(data);
  return res.data;
}

export const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
```

- [ ] **Step 2: Write failing test**

`functions/test/authTriggers.test.ts`:
```typescript
import { describe, it, expect } from "vitest";
import { doc, getDoc } from "firebase/firestore";
import { signUpTestUser, db, wait } from "./helpers";
import * as adminApp from "firebase-admin/app";
import { getFirestore as adminFirestore } from "firebase-admin/firestore";

// Admin SDK against emulator to read users docs regardless of rules.
process.env.FIRESTORE_EMULATOR_HOST = "localhost:8080";
const admin = adminApp.getApps()[0] ?? adminApp.initializeApp({ projectId: "gatekeep-dev" });

describe("onUserCreated", () => {
  it("creates users/{uid} with email and defaults", async () => {
    const { uid } = await signUpTestUser(`alice-${Date.now()}@test.com`);
    await wait(1500); // trigger is async
    const snap = await adminFirestore(admin).doc(`users/${uid}`).get();
    expect(snap.exists).toBe(true);
    expect(snap.data()?.email).toContain("@test.com");
    expect(snap.data()?.photoUrl).toBeNull();
    expect(typeof snap.data()?.createdAt).toBe("number");
  });
});
```

- [ ] **Step 3: Run, verify fail**

Run: `pnpm --filter functions build && pnpm emu:test`
Expected: FAIL, users doc never appears (trigger not implemented).

- [ ] **Step 4: Implement trigger**

`functions/src/authTriggers.ts`:
```typescript
import * as functionsV1 from "firebase-functions/v1";
import { getFirestore } from "firebase-admin/firestore";
import type { UserDoc } from "@gatekeep/shared";

// v1 API: auth onCreate has no v2 equivalent yet.
export const onUserCreated = functionsV1.auth.user().onCreate(async (user) => {
  const docData: UserDoc = {
    displayName: user.displayName ?? user.email?.split("@")[0] ?? "New user",
    email: user.email ?? "",
    photoUrl: user.photoURL ?? null,
    homeCity: null,
    createdAt: Date.now(),
  };
  await getFirestore().doc(`users/${user.uid}`).set(docData);
});
```

`functions/src/index.ts`:
```typescript
import { initializeApp } from "firebase-admin/app";
initializeApp();

export { onUserCreated } from "./authTriggers.js";
```

- [ ] **Step 5: Run, verify pass; commit**

Run: `pnpm --filter functions build && pnpm emu:test`
Expected: PASS.

```bash
git add -A
git commit -m "feat: auth onCreate trigger creates users doc"
```

---

### Task 6: Profile creation + submission callables

**Files:**
- Create: `functions/src/profiles.ts`
- Modify: `functions/src/index.ts`
- Test: `functions/test/profiles.test.ts`

**Interfaces:**
- Consumes: `validateProfileDraft`, `ProfileDoc`, `MemberDoc` from `@gatekeep/shared`; test helpers from Task 5.
- Produces: callables `createProfileDraft(data: ProfileDraftInput) → { profileId: string }` and `submitProfileForReview(data: { profileId: string }) → { ok: true }`. Handle ledger: `handles/{handle} = { profileId }` claimed transactionally at draft creation. Creator becomes members admin with label "owner".

- [ ] **Step 1: Write failing tests**

`functions/test/profiles.test.ts`:
```typescript
import { describe, it, expect } from "vitest";
import { signUpTestUser, callFn, wait } from "./helpers";
import * as adminApp from "firebase-admin/app";
import { getFirestore as adminFirestore } from "firebase-admin/firestore";
import type { ProfileDraftInput } from "@gatekeep/shared";

process.env.FIRESTORE_EMULATOR_HOST = "localhost:8080";
const admin = adminApp.getApps()[0] ?? adminApp.initializeApp({ projectId: "gatekeep-dev" });
const adb = adminFirestore(admin);

const draft = (handle: string): ProfileDraftInput =>
  ({ type: "musician", subtype: "band", name: "The Midnight Owls", handle });

describe("createProfileDraft", () => {
  it("creates draft profile, claims handle, adds creator as admin member", async () => {
    const { user, uid } = await signUpTestUser(`m1-${Date.now()}@test.com`);
    const handle = `owls_${Date.now()}`;
    const { profileId } = await callFn<ProfileDraftInput, { profileId: string }>(
      "createProfileDraft", draft(handle), user);
    const p = await adb.doc(`profiles/${profileId}`).get();
    expect(p.data()?.status).toBe("draft");
    expect((await adb.doc(`handles/${handle}`).get()).data()?.profileId).toBe(profileId);
    const m = await adb.doc(`profiles/${profileId}/members/${uid}`).get();
    expect(m.data()?.role).toBe("admin");
  });
  it("rejects a taken handle and a reserved handle", async () => {
    const { user } = await signUpTestUser(`m2-${Date.now()}@test.com`);
    const handle = `dupe_${Date.now()}`;
    await callFn("createProfileDraft", draft(handle), user);
    await expect(callFn("createProfileDraft", draft(handle), user)).rejects.toThrow(/taken/i);
    await expect(callFn("createProfileDraft", draft("admin"), user)).rejects.toThrow(/reserved/i);
  });
  it("rejects unauthenticated calls", async () => {
    await expect(callFn("createProfileDraft", draft(`x_${Date.now()}`))).rejects.toThrow();
  });
});

describe("submitProfileForReview", () => {
  it("moves draft to pending_review; only member admins may submit", async () => {
    const { user } = await signUpTestUser(`m3-${Date.now()}@test.com`);
    const { profileId } = await callFn<ProfileDraftInput, { profileId: string }>(
      "createProfileDraft", draft(`sub_${Date.now()}`), user);
    await callFn("submitProfileForReview", { profileId }, user);
    expect((await adb.doc(`profiles/${profileId}`).get()).data()?.status).toBe("pending_review");
    const { user: outsider } = await signUpTestUser(`m4-${Date.now()}@test.com`);
    await expect(callFn("submitProfileForReview", { profileId }, outsider)).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run, verify fail**

Run: `pnpm --filter functions build && pnpm emu:test`
Expected: FAIL, callables not found.

- [ ] **Step 3: Implement**

`functions/src/profiles.ts`:
```typescript
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { validateProfileDraft, type ProfileDraftInput, type ProfileDoc, type MemberDoc } from "@gatekeep/shared";

function requireAuth(uid: string | undefined): string {
  if (!uid) throw new HttpsError("unauthenticated", "Sign in first.");
  return uid;
}

export async function requireProfileAdmin(profileId: string, uid: string) {
  const m = await getFirestore().doc(`profiles/${profileId}/members/${uid}`).get();
  if (!m.exists || m.data()?.role !== "admin") {
    throw new HttpsError("permission-denied", "Only profile admins can do that.");
  }
}

export const createProfileDraft = onCall<ProfileDraftInput>({ region: "us-central1" }, async (req) => {
  const uid = requireAuth(req.auth?.uid);
  const input = req.data;
  const v = validateProfileDraft(input);
  if (!v.ok) throw new HttpsError("invalid-argument", v.reason);

  const db = getFirestore();
  const profileRef = db.collection("profiles").doc();
  const handleRef = db.doc(`handles/${input.handle}`);

  await db.runTransaction(async (tx) => {
    if ((await tx.get(handleRef)).exists) {
      throw new HttpsError("already-exists", "That handle is taken.");
    }
    const now = Date.now();
    const profile: ProfileDoc = {
      type: input.type, subtype: input.subtype as ProfileDoc["subtype"],
      name: input.name.trim(), handle: input.handle,
      status: "draft", rejectionReason: null, createdAt: now, updatedAt: now,
    };
    const member: MemberDoc = { uid, role: "admin", label: "owner", joinedAt: now };
    tx.set(profileRef, profile);
    tx.set(handleRef, { profileId: profileRef.id });
    tx.set(profileRef.collection("members").doc(uid), member);
  });
  return { profileId: profileRef.id };
});

export const submitProfileForReview = onCall<{ profileId: string }>({ region: "us-central1" }, async (req) => {
  const uid = requireAuth(req.auth?.uid);
  const { profileId } = req.data;
  await requireProfileAdmin(profileId, uid);
  const ref = getFirestore().doc(`profiles/${profileId}`);
  const snap = await ref.get();
  const status = snap.data()?.status;
  if (status !== "draft" && status !== "rejected") {
    throw new HttpsError("failed-precondition", `Cannot submit a profile in status "${status}".`);
  }
  await ref.update({ status: "pending_review", rejectionReason: null, updatedAt: Date.now() });
  return { ok: true };
});
```

Add to `functions/src/index.ts`:
```typescript
export { createProfileDraft, submitProfileForReview } from "./profiles.js";
```

- [ ] **Step 4: Run, verify pass; commit**

Run: `pnpm --filter functions build && pnpm emu:test`
Expected: PASS.

```bash
git add -A
git commit -m "feat: profile draft creation with handle ledger + submit for review"
```

---

### Task 7: Review, admin claims, audit log

**Files:**
- Create: `functions/src/review.ts`, `scripts/seed-admin.ts`
- Modify: `functions/src/index.ts`
- Test: `functions/test/review.test.ts`

**Interfaces:**
- Consumes: helpers + profile callables from Tasks 5-6; `AuditLogDoc` from `@gatekeep/shared`.
- Produces: callables `reviewProfile(data: { profileId: string; decision: "approved" | "rejected"; reason?: string }) → { ok: true }` (admin-claim only; writes `auditLogs`) and `grantAdmin(data: { uid: string }) → { ok: true }` (admin-claim only; writes `auditLogs`). Test helper pattern for minting an admin user via the Auth emulator Admin SDK, reused by Task 12's manual verification.

- [ ] **Step 1: Write failing tests**

`functions/test/review.test.ts`:
```typescript
import { describe, it, expect } from "vitest";
import { signUpTestUser, callFn } from "./helpers";
import * as adminApp from "firebase-admin/app";
import { getFirestore as adminFirestore } from "firebase-admin/firestore";
import { getAuth as adminAuth } from "firebase-admin/auth";
import type { ProfileDraftInput } from "@gatekeep/shared";

process.env.FIRESTORE_EMULATOR_HOST = "localhost:8080";
process.env.FIREBASE_AUTH_EMULATOR_HOST = "localhost:9099";
const admin = adminApp.getApps()[0] ?? adminApp.initializeApp({ projectId: "gatekeep-dev" });
const adb = adminFirestore(admin);

async function makeAdminUser() {
  const t = await signUpTestUser(`admin-${Date.now()}@test.com`);
  await adminAuth(admin).setCustomUserClaims(t.uid, { admin: true });
  await t.user.getIdToken(true); // refresh claims
  return t;
}

async function pendingProfile(ownerEmailPrefix: string) {
  const owner = await signUpTestUser(`${ownerEmailPrefix}-${Date.now()}@test.com`);
  const { profileId } = await callFn<ProfileDraftInput, { profileId: string }>(
    "createProfileDraft",
    { type: "curator", subtype: "venue", name: "Rooftop 21", handle: `roof_${Date.now()}` },
    owner.user);
  await callFn("submitProfileForReview", { profileId }, owner.user);
  return { owner, profileId };
}

describe("reviewProfile", () => {
  it("admin approves; status flips; audit log written", async () => {
    const { profileId } = await pendingProfile("v1");
    const adminUser = await makeAdminUser();
    await callFn("reviewProfile", { profileId, decision: "approved" }, adminUser.user);
    expect((await adb.doc(`profiles/${profileId}`).get()).data()?.status).toBe("approved");
    const logs = await adb.collection("auditLogs")
      .where("targetId", "==", profileId).where("action", "==", "profile_approved").get();
    expect(logs.size).toBe(1);
    expect(logs.docs[0].data().actorUid).toBe(adminUser.uid);
  });
  it("rejection requires a reason and stores it", async () => {
    const { profileId } = await pendingProfile("v2");
    const adminUser = await makeAdminUser();
    await expect(callFn("reviewProfile", { profileId, decision: "rejected" }, adminUser.user))
      .rejects.toThrow(/reason/i);
    await callFn("reviewProfile", { profileId, decision: "rejected", reason: "No photos" }, adminUser.user);
    const p = (await adb.doc(`profiles/${profileId}`).get()).data();
    expect(p?.status).toBe("rejected");
    expect(p?.rejectionReason).toBe("No photos");
  });
  it("non-admin callers are denied", async () => {
    const { owner, profileId } = await pendingProfile("v3");
    await expect(callFn("reviewProfile", { profileId, decision: "approved" }, owner.user))
      .rejects.toThrow(/permission|denied/i);
  });
});

describe("grantAdmin", () => {
  it("admin grants claim + audit logged; non-admin denied", async () => {
    const adminUser = await makeAdminUser();
    const target = await signUpTestUser(`t-${Date.now()}@test.com`);
    await callFn("grantAdmin", { uid: target.uid }, adminUser.user);
    const rec = await adminAuth(admin).getUser(target.uid);
    expect(rec.customClaims?.admin).toBe(true);
    const stranger = await signUpTestUser(`s-${Date.now()}@test.com`);
    await expect(callFn("grantAdmin", { uid: stranger.uid }, stranger.user)).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run, verify fail**

Run: `pnpm --filter functions build && pnpm emu:test`
Expected: FAIL, callables not found.

- [ ] **Step 3: Implement**

`functions/src/review.ts`:
```typescript
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getFirestore } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";
import type { AuditLogDoc } from "@gatekeep/shared";

function requireAdmin(req: { auth?: { uid?: string; token?: Record<string, unknown> } }): string {
  const uid = req.auth?.uid;
  if (!uid || req.auth?.token?.admin !== true) {
    throw new HttpsError("permission-denied", "Admin access required.");
  }
  return uid;
}

export async function writeAudit(entry: Omit<AuditLogDoc, "at">) {
  const log: AuditLogDoc = { ...entry, at: Date.now() };
  await getFirestore().collection("auditLogs").add(log);
}

export const reviewProfile = onCall<{ profileId: string; decision: "approved" | "rejected"; reason?: string }>(
  { region: "us-central1" }, async (req) => {
    const actorUid = requireAdmin(req);
    const { profileId, decision, reason } = req.data;
    if (decision === "rejected" && !reason?.trim()) {
      throw new HttpsError("invalid-argument", "A rejection reason is required.");
    }
    const ref = getFirestore().doc(`profiles/${profileId}`);
    const snap = await ref.get();
    if (!snap.exists) throw new HttpsError("not-found", "Profile not found.");
    if (snap.data()?.status !== "pending_review") {
      throw new HttpsError("failed-precondition", "Profile is not pending review.");
    }
    await ref.update({
      status: decision,
      rejectionReason: decision === "rejected" ? reason!.trim() : null,
      updatedAt: Date.now(),
    });
    await writeAudit({
      actorUid,
      action: decision === "approved" ? "profile_approved" : "profile_rejected",
      targetId: profileId,
      detail: decision === "rejected" ? reason!.trim() : snap.data()?.name ?? "",
    });
    return { ok: true };
  });

export const grantAdmin = onCall<{ uid: string }>({ region: "us-central1" }, async (req) => {
  const actorUid = requireAdmin(req);
  const { uid } = req.data;
  await getAuth().setCustomUserClaims(uid, { admin: true });
  await writeAudit({ actorUid, action: "admin_granted", targetId: uid, detail: "" });
  return { ok: true };
});
```

Add to `functions/src/index.ts`:
```typescript
export { reviewProfile, grantAdmin } from "./review.js";
```

- [ ] **Step 4: First-admin seed script**

`scripts/seed-admin.ts` (run manually with Admin credentials; grants the claim to a user by email, used once per environment for you and your partner):
```typescript
// Usage: pnpm tsx scripts/seed-admin.ts someone@example.com
// Spec §8: admin accounts must be Google sign-in accounts (inherits Google 2FA).
// Only seed emails that signed up with "Continue with Google".
// Against emulator: FIREBASE_AUTH_EMULATOR_HOST=localhost:9099 pnpm tsx scripts/seed-admin.ts ...
// Against prod: GOOGLE_APPLICATION_CREDENTIALS=<service-account.json> pnpm tsx scripts/seed-admin.ts ...
import { initializeApp, getApps } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";

const email = process.argv[2];
if (!email) { console.error("Usage: seed-admin.ts <email>"); process.exit(1); }
const app = getApps()[0] ?? initializeApp({ projectId: "gatekeep-dev" });
const user = await getAuth(app).getUserByEmail(email);
await getAuth(app).setCustomUserClaims(user.uid, { admin: true });
console.log(`admin claim granted to ${email} (${user.uid})`);
```
Add root devDependency `tsx`: `pnpm add -w -D tsx`.

- [ ] **Step 5: Run, verify pass; commit**

Run: `pnpm --filter functions build && pnpm emu:test`
Expected: PASS.

```bash
git add -A
git commit -m "feat: profile review + admin claim granting with audit log"
```

---

### Task 8: Membership, invites, removal, admin transfer

**Files:**
- Create: `functions/src/members.ts`
- Modify: `functions/src/index.ts`
- Test: `functions/test/members.test.ts`

**Interfaces:**
- Consumes: `requireProfileAdmin` from Task 6, helpers from Task 5, `InviteDoc`/`MemberDoc` from shared.
- Produces: callables `inviteMember(data: { profileId: string; email: string; role: MemberRole; label: string }) → { inviteId: string }`, `respondToInvite(data: { inviteId: string; accept: boolean }) → { ok: true }`, `removeMember(data: { profileId: string; uid: string }) → { ok: true }`, `transferAdmin(data: { profileId: string; toUid: string }) → { ok: true }`. Invariant enforced everywhere: a profile never drops to zero admins. Task 14's deleteAccount relies on `removeMember`'s last-admin guard behavior.

- [ ] **Step 1: Write failing tests**

`functions/test/members.test.ts`:
```typescript
import { describe, it, expect } from "vitest";
import { signUpTestUser, callFn } from "./helpers";
import * as adminApp from "firebase-admin/app";
import { getFirestore as adminFirestore } from "firebase-admin/firestore";
import type { ProfileDraftInput, MemberRole } from "@gatekeep/shared";

process.env.FIRESTORE_EMULATOR_HOST = "localhost:8080";
const admin = adminApp.getApps()[0] ?? adminApp.initializeApp({ projectId: "gatekeep-dev" });
const adb = adminFirestore(admin);

async function bandWithOwner(prefix: string) {
  const owner = await signUpTestUser(`${prefix}-own-${Date.now()}@test.com`);
  const { profileId } = await callFn<ProfileDraftInput, { profileId: string }>(
    "createProfileDraft",
    { type: "musician", subtype: "band", name: "Band", handle: `${prefix}_${Date.now()}` },
    owner.user);
  return { owner, profileId };
}

describe("invites", () => {
  it("admin invites by email; invitee accepts and becomes member", async () => {
    const { owner, profileId } = await bandWithOwner("inv1");
    const drummerEmail = `drum-${Date.now()}@test.com`;
    const drummer = await signUpTestUser(drummerEmail);
    const { inviteId } = await callFn<object, { inviteId: string }>(
      "inviteMember", { profileId, email: drummerEmail, role: "member" as MemberRole, label: "drummer" }, owner.user);
    await callFn("respondToInvite", { inviteId, accept: true }, drummer.user);
    const m = await adb.doc(`profiles/${profileId}/members/${drummer.uid}`).get();
    expect(m.data()?.label).toBe("drummer");
  });
  it("declining creates no membership; only invitee may respond; non-admin cannot invite", async () => {
    const { owner, profileId } = await bandWithOwner("inv2");
    const email = `p-${Date.now()}@test.com`;
    const invitee = await signUpTestUser(email);
    const { inviteId } = await callFn<object, { inviteId: string }>(
      "inviteMember", { profileId, email, role: "member", label: "bass" }, owner.user);
    const stranger = await signUpTestUser(`s-${Date.now()}@test.com`);
    await expect(callFn("respondToInvite", { inviteId, accept: true }, stranger.user)).rejects.toThrow();
    await callFn("respondToInvite", { inviteId, accept: false }, invitee.user);
    expect((await adb.doc(`profiles/${profileId}/members/${invitee.uid}`).get()).exists).toBe(false);
    await expect(callFn("inviteMember", { profileId, email, role: "member", label: "x" }, stranger.user))
      .rejects.toThrow();
  });
});

describe("removal and admin transfer", () => {
  it("cannot remove the last admin; transfer then removal works", async () => {
    const { owner, profileId } = await bandWithOwner("rm1");
    await expect(callFn("removeMember", { profileId, uid: owner.uid }, owner.user))
      .rejects.toThrow(/last admin/i);
    const email = `co-${Date.now()}@test.com`;
    const co = await signUpTestUser(email);
    const { inviteId } = await callFn<object, { inviteId: string }>(
      "inviteMember", { profileId, email, role: "member", label: "keys" }, owner.user);
    await callFn("respondToInvite", { inviteId, accept: true }, co.user);
    await callFn("transferAdmin", { profileId, toUid: co.uid }, owner.user);
    expect((await adb.doc(`profiles/${profileId}/members/${co.uid}`).get()).data()?.role).toBe("admin");
    await callFn("removeMember", { profileId, uid: owner.uid }, co.user);
    expect((await adb.doc(`profiles/${profileId}/members/${owner.uid}`).get()).exists).toBe(false);
  });
});
```

- [ ] **Step 2: Run, verify fail**

Run: `pnpm --filter functions build && pnpm emu:test`
Expected: FAIL, callables not found.

- [ ] **Step 3: Implement**

`functions/src/members.ts`:
```typescript
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getFirestore } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";
import { requireProfileAdmin } from "./profiles.js";
import type { InviteDoc, MemberDoc, MemberRole } from "@gatekeep/shared";

function requireAuth(uid: string | undefined): string {
  if (!uid) throw new HttpsError("unauthenticated", "Sign in first.");
  return uid;
}

async function adminCount(profileId: string): Promise<number> {
  const admins = await getFirestore()
    .collection(`profiles/${profileId}/members`).where("role", "==", "admin").get();
  return admins.size;
}

export const inviteMember = onCall<{ profileId: string; email: string; role: MemberRole; label: string }>(
  { region: "us-central1" }, async (req) => {
    const uid = requireAuth(req.auth?.uid);
    const { profileId, email, role, label } = req.data;
    await requireProfileAdmin(profileId, uid);
    let invited;
    try { invited = await getAuth().getUserByEmail(email); }
    catch { throw new HttpsError("not-found", "No GateKeep account with that email."); }
    const db = getFirestore();
    const profile = await db.doc(`profiles/${profileId}`).get();
    const invite: InviteDoc = {
      profileId, profileName: profile.data()?.name ?? "", invitedUid: invited.uid,
      role, label: label.trim(), invitedByUid: uid, status: "pending", createdAt: Date.now(),
    };
    const ref = await db.collection("invites").add(invite);
    return { inviteId: ref.id };
  });

export const respondToInvite = onCall<{ inviteId: string; accept: boolean }>(
  { region: "us-central1" }, async (req) => {
    const uid = requireAuth(req.auth?.uid);
    const { inviteId, accept } = req.data;
    const db = getFirestore();
    const ref = db.doc(`invites/${inviteId}`);
    const snap = await ref.get();
    const inv = snap.data() as InviteDoc | undefined;
    if (!inv) throw new HttpsError("not-found", "Invite not found.");
    if (inv.invitedUid !== uid) throw new HttpsError("permission-denied", "Not your invite.");
    if (inv.status !== "pending") throw new HttpsError("failed-precondition", "Invite already handled.");
    if (accept) {
      const member: MemberDoc = { uid, role: inv.role, label: inv.label, joinedAt: Date.now() };
      await db.doc(`profiles/${inv.profileId}/members/${uid}`).set(member);
    }
    await ref.update({ status: accept ? "accepted" : "declined" });
    return { ok: true };
  });

export const removeMember = onCall<{ profileId: string; uid: string }>(
  { region: "us-central1" }, async (req) => {
    const actor = requireAuth(req.auth?.uid);
    const { profileId, uid } = req.data;
    // Members may remove themselves; otherwise admin required.
    if (actor !== uid) await requireProfileAdmin(profileId, actor);
    const db = getFirestore();
    const target = await db.doc(`profiles/${profileId}/members/${uid}`).get();
    if (!target.exists) throw new HttpsError("not-found", "Not a member.");
    if (target.data()?.role === "admin" && (await adminCount(profileId)) <= 1) {
      throw new HttpsError("failed-precondition",
        "Cannot remove the last admin. Transfer admin first or delete the profile.");
    }
    await db.doc(`profiles/${profileId}/members/${uid}`).delete();
    return { ok: true };
  });

export const transferAdmin = onCall<{ profileId: string; toUid: string }>(
  { region: "us-central1" }, async (req) => {
    const actor = requireAuth(req.auth?.uid);
    const { profileId, toUid } = req.data;
    await requireProfileAdmin(profileId, actor);
    const db = getFirestore();
    const target = await db.doc(`profiles/${profileId}/members/${toUid}`).get();
    if (!target.exists) throw new HttpsError("not-found", "Target is not a member of this profile.");
    await db.doc(`profiles/${profileId}/members/${toUid}`).update({ role: "admin" });
    return { ok: true };
  });
```

Add to `functions/src/index.ts`:
```typescript
export { inviteMember, respondToInvite, removeMember, transferAdmin } from "./members.js";
```

- [ ] **Step 4: Run, verify pass; commit**

Run: `pnpm --filter functions build && pnpm emu:test`
Expected: PASS.

```bash
git add -A
git commit -m "feat: membership invites with consent, removal, admin transfer"
```

---

### Task 9: Mobile auth UI

**Files:**
- Create: `apps/mobile/src/auth/AuthProvider.tsx`, `apps/mobile/app/(auth)/sign-in.tsx`, `apps/mobile/app/(auth)/sign-up.tsx`
- Modify: `apps/mobile/app/_layout.tsx`

**Interfaces:**
- Consumes: `getFirebase()` from Task 3.
- Produces: `useAuth(): { user: User | null; loading: boolean; signOutUser(): Promise<void> }` React context, every later mobile screen uses this. Route group `(auth)` shown when signed out; the rest of the app when signed in.

- [ ] **Step 1: Install auth dependencies**

```bash
cd apps/mobile
npx expo install expo-apple-authentication @react-native-google-signin/google-signin
```
In `app.json` add the plugins:
```json
"plugins": ["expo-apple-authentication", "@react-native-google-signin/google-signin"]
```
Google sign-in needs the OAuth client ids from Firebase console (Authentication → Google → Web SDK configuration). Record the web client id in `apps/mobile/src/auth/config.ts`:
```typescript
export const GOOGLE_WEB_CLIENT_ID = "REPLACE_FROM_FIREBASE_CONSOLE.apps.googleusercontent.com";
```

- [ ] **Step 2: AuthProvider**

`apps/mobile/src/auth/AuthProvider.tsx`:
```tsx
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { onAuthStateChanged, signOut, type User } from "firebase/auth";
import { getFirebase } from "../lib/firebase";

type AuthState = { user: User | null; loading: boolean; signOutUser: () => Promise<void> };
const AuthContext = createContext<AuthState>({ user: null, loading: true, signOutUser: async () => {} });

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const { auth } = getFirebase();
    return onAuthStateChanged(auth, (u) => { setUser(u); setLoading(false); });
  }, []);
  const signOutUser = async () => { await signOut(getFirebase().auth); };
  return <AuthContext.Provider value={{ user, loading, signOutUser }}>{children}</AuthContext.Provider>;
}

export const useAuth = () => useContext(AuthContext);
```

- [ ] **Step 3: Sign-in screen (three buttons, per spec §4)**

`apps/mobile/app/(auth)/sign-in.tsx`:
```tsx
import { useState } from "react";
import { View, Text, TextInput, Pressable, Platform, Alert } from "react-native";
import { Link } from "expo-router";
import {
  signInWithEmailAndPassword, GoogleAuthProvider, OAuthProvider, signInWithCredential,
} from "firebase/auth";
import { GoogleSignin } from "@react-native-google-signin/google-signin";
import * as AppleAuthentication from "expo-apple-authentication";
import { getFirebase } from "../../src/lib/firebase";
import { GOOGLE_WEB_CLIENT_ID } from "../../src/auth/config";

GoogleSignin.configure({ webClientId: GOOGLE_WEB_CLIENT_ID });

// Firebase auth error codes → human messages (spec §9: friendly auth errors).
function authMessage(code: string): string {
  switch (code) {
    case "auth/invalid-credential":
    case "auth/wrong-password": return "That email and password don't match.";
    case "auth/user-not-found": return "No account with that email. Did you sign up with Google or Apple?";
    case "auth/too-many-requests": return "Too many tries. Wait a minute and try again.";
    default: return "Couldn't sign you in. Check your connection and try again.";
  }
}

export default function SignIn() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const { auth } = getFirebase();

  const emailSignIn = async () => {
    try { await signInWithEmailAndPassword(auth, email.trim(), password); }
    catch (e: any) { Alert.alert("Sign in", authMessage(e?.code ?? "")); }
  };
  const googleSignIn = async () => {
    try {
      await GoogleSignin.hasPlayServices();
      const res = await GoogleSignin.signIn();
      const idToken = res.data?.idToken;
      if (!idToken) return;
      await signInWithCredential(auth, GoogleAuthProvider.credential(idToken));
    } catch { Alert.alert("Sign in", "Google sign-in didn't complete."); }
  };
  const appleSignIn = async () => {
    try {
      const cred = await AppleAuthentication.signInAsync({
        requestedScopes: [AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
                          AppleAuthentication.AppleAuthenticationScope.EMAIL],
      });
      if (!cred.identityToken) return;
      const provider = new OAuthProvider("apple.com");
      await signInWithCredential(auth, provider.credential({ idToken: cred.identityToken }));
    } catch { Alert.alert("Sign in", "Apple sign-in didn't complete."); }
  };

  return (
    <View style={{ flex: 1, justifyContent: "center", padding: 24, gap: 12 }}>
      <Text style={{ fontSize: 28, fontWeight: "700" }}>GateKeep</Text>
      <TextInput placeholder="Email" autoCapitalize="none" keyboardType="email-address"
        value={email} onChangeText={setEmail} style={{ borderWidth: 1, padding: 12, borderRadius: 8 }} />
      <TextInput placeholder="Password" secureTextEntry
        value={password} onChangeText={setPassword} style={{ borderWidth: 1, padding: 12, borderRadius: 8 }} />
      <Pressable onPress={emailSignIn} style={{ backgroundColor: "#111", padding: 14, borderRadius: 8 }}>
        <Text style={{ color: "#fff", textAlign: "center" }}>Sign in</Text>
      </Pressable>
      <Pressable onPress={googleSignIn} style={{ borderWidth: 1, padding: 14, borderRadius: 8 }}>
        <Text style={{ textAlign: "center" }}>Continue with Google</Text>
      </Pressable>
      {Platform.OS === "ios" && (
        <Pressable onPress={appleSignIn} style={{ borderWidth: 1, padding: 14, borderRadius: 8 }}>
          <Text style={{ textAlign: "center" }}>Continue with Apple</Text>
        </Pressable>
      )}
      <Pressable onPress={async () => {
        if (!email.trim()) { Alert.alert("Reset password", "Enter your email above first."); return; }
        const { sendPasswordResetEmail } = await import("firebase/auth");
        try { await sendPasswordResetEmail(auth, email.trim());
              Alert.alert("Reset password", "Reset link sent, check your email."); }
        catch { Alert.alert("Reset password", "Couldn't send the reset email."); }
      }}><Text>Forgot password?</Text></Pressable>
      <Link href="/(auth)/sign-up"><Text>New here? Create an account</Text></Link>
    </View>
  );
}
```

- [ ] **Step 4: Sign-up screen (email path + verification email)**

`apps/mobile/app/(auth)/sign-up.tsx`:
```tsx
import { useState } from "react";
import { View, Text, TextInput, Pressable, Alert } from "react-native";
import { createUserWithEmailAndPassword, sendEmailVerification } from "firebase/auth";
import { getFirebase } from "../../src/lib/firebase";

export default function SignUp() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const create = async () => {
    try {
      const cred = await createUserWithEmailAndPassword(getFirebase().auth, email.trim(), password);
      await sendEmailVerification(cred.user);
      Alert.alert("Welcome!", "We sent a verification link to your email.");
    } catch (e: any) {
      const msg = e?.code === "auth/email-already-in-use"
        ? "That email already has an account, try signing in instead."
        : e?.code === "auth/weak-password" ? "Password must be at least 6 characters."
        : "Couldn't create the account. Try again.";
      Alert.alert("Sign up", msg);
    }
  };
  return (
    <View style={{ flex: 1, justifyContent: "center", padding: 24, gap: 12 }}>
      <Text style={{ fontSize: 24, fontWeight: "700" }}>Create your account</Text>
      <TextInput placeholder="Email" autoCapitalize="none" keyboardType="email-address"
        value={email} onChangeText={setEmail} style={{ borderWidth: 1, padding: 12, borderRadius: 8 }} />
      <TextInput placeholder="Password" secureTextEntry
        value={password} onChangeText={setPassword} style={{ borderWidth: 1, padding: 12, borderRadius: 8 }} />
      <Pressable onPress={create} style={{ backgroundColor: "#111", padding: 14, borderRadius: 8 }}>
        <Text style={{ color: "#fff", textAlign: "center" }}>Create account</Text>
      </Pressable>
    </View>
  );
}
```
(Google/Apple sign-up IS the sign-in flow, the buttons on the sign-in screen create the account on first use; spec's one-method rule holds because Firebase keys accounts by provider.)

- [ ] **Step 5: Gate routes in the root layout**

`apps/mobile/app/_layout.tsx`:
```tsx
import { Stack, useRouter, useSegments } from "expo-router";
import { useEffect } from "react";
import { AuthProvider, useAuth } from "../src/auth/AuthProvider";

function Gate() {
  const { user, loading } = useAuth();
  const segments = useSegments();
  const router = useRouter();
  useEffect(() => {
    if (loading) return;
    const inAuthGroup = segments[0] === "(auth)";
    if (!user && !inAuthGroup) router.replace("/(auth)/sign-in");
    if (user && inAuthGroup) router.replace("/");
  }, [user, loading, segments]);
  return <Stack screenOptions={{ headerShown: false }} />;
}

export default function RootLayout() {
  return <AuthProvider><Gate /></AuthProvider>;
}
```

- [ ] **Step 6: Manual verification against emulator**

Run: `pnpm emu` + `pnpm --filter @gatekeep/mobile exec expo start`.
Verify: signed-out state shows sign-in; email sign-up creates a user (visible in emulator Auth UI at :4000) AND a `users/{uid}` doc appears in emulator Firestore (Task 5's trigger); sign-out returns to sign-in. (Google/Apple buttons need a dev build + real credentials, verify email path now; native providers get verified in Task 15's device pass.)

- [ ] **Step 7: Typecheck + commit**

Run: `pnpm --filter @gatekeep/mobile typecheck`
Expected: PASS.

```bash
git add -A
git commit -m "feat: mobile auth, email/google/apple sign-in, route gating"
```

---

### Task 10: Mobile app shell, context switcher + tabs + join flow

**Files:**
- Create: `apps/mobile/src/shell/ProfileContext.tsx`, `apps/mobile/src/shell/ContextSwitcher.tsx`
- Create: `apps/mobile/app/(fan)/_layout.tsx` with tab screens `index.tsx` (Discover), `tickets.tsx`, `search.tsx`, `account.tsx`
- Create: `apps/mobile/app/(musician)/_layout.tsx` with `dashboard.tsx`, `gigs.tsx`, `portfolio.tsx`, `messages.tsx`, `account.tsx`
- Create: `apps/mobile/app/(curator)/_layout.tsx` with `dashboard.tsx`, `events.tsx`, `talent.tsx`, `messages.tsx`, `account.tsx`
- Create: `apps/mobile/app/join.tsx` (join-as-musician/curator wizard)
- Modify: `apps/mobile/app/_layout.tsx`, `apps/mobile/app/index.tsx`

**Interfaces:**
- Consumes: `useAuth` (Task 9), callables `createProfileDraft`/`submitProfileForReview` (Task 6), members collection-group reads under Task 4's rules.
- Produces: `useProfileContext(): { activeContext: "fan" | { profileId: string; type: ProfileType; name: string; status: ProfileStatus }; myProfiles: ProfileSummary[]; switchTo(ctx): void }` where `ProfileSummary = { profileId: string; type: ProfileType; name: string; status: ProfileStatus }`. Later sub-projects render into the tab placeholders created here.

- [ ] **Step 1: ProfileContext, load my profiles via collection-group query**

`apps/mobile/src/shell/ProfileContext.tsx`:
```tsx
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { collectionGroup, query, where, onSnapshot, doc, getDoc, documentId } from "firebase/firestore";
import { getFirebase } from "../lib/firebase";
import { useAuth } from "../auth/AuthProvider";
import type { ProfileType, ProfileStatus } from "@gatekeep/shared";

export type ProfileSummary = { profileId: string; type: ProfileType; name: string; status: ProfileStatus };
export type ActiveContext = "fan" | ProfileSummary;

type Ctx = { activeContext: ActiveContext; myProfiles: ProfileSummary[]; switchTo: (c: ActiveContext) => void };
const ProfileCtx = createContext<Ctx>({ activeContext: "fan", myProfiles: [], switchTo: () => {} });

export function ProfileProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [myProfiles, setMyProfiles] = useState<ProfileSummary[]>([]);
  const [activeContext, setActiveContext] = useState<ActiveContext>("fan");

  useEffect(() => {
    if (!user) { setMyProfiles([]); setActiveContext("fan"); return; }
    const { db } = getFirebase();
    return onSnapshot(query(collectionGroup(db, "members"), where("uid", "==", user.uid)), async (snap) => {
      const results: ProfileSummary[] = [];
      for (const m of snap.docs) {
        const profileRef = m.ref.parent.parent!;
        const p = await getDoc(doc(db, "profiles", profileRef.id));
        if (p.exists()) {
          const d = p.data();
          results.push({ profileId: p.id, type: d.type, name: d.name, status: d.status });
        }
      }
      setMyProfiles(results);
    });
  }, [user?.uid]);

  return (
    <ProfileCtx.Provider value={{ activeContext, myProfiles, switchTo: setActiveContext }}>
      {children}
    </ProfileCtx.Provider>
  );
}
export const useProfileContext = () => useContext(ProfileCtx);
```
(The `uid` field on member docs, the self-read rules clause, and the collection-group index this query relies on were all built in Tasks 1, 2, and 4.)

- [ ] **Step 2: ContextSwitcher component**

`apps/mobile/src/shell/ContextSwitcher.tsx`:
```tsx
import { View, Text, Pressable, Modal } from "react-native";
import { useState } from "react";
import { useRouter } from "expo-router";
import { useProfileContext } from "./ProfileContext";

export function ContextSwitcher() {
  const { activeContext, myProfiles, switchTo } = useProfileContext();
  const [open, setOpen] = useState(false);
  const router = useRouter();
  const label = activeContext === "fan" ? "Me (fan)" : activeContext.name;
  return (
    <>
      <Pressable onPress={() => setOpen(true)} style={{ padding: 8 }}>
        <Text style={{ fontWeight: "600" }}>{label} ▾</Text>
      </Pressable>
      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable style={{ flex: 1, backgroundColor: "#0006" }} onPress={() => setOpen(false)}>
          <View style={{ marginTop: 80, marginHorizontal: 24, backgroundColor: "#fff", borderRadius: 12, padding: 8 }}>
            <Pressable onPress={() => { switchTo("fan"); setOpen(false); router.replace("/(fan)"); }} style={{ padding: 12 }}>
              <Text>Me (fan)</Text>
            </Pressable>
            {myProfiles.map((p) => (
              <Pressable key={p.profileId} style={{ padding: 12 }}
                onPress={() => { switchTo(p); setOpen(false);
                  router.replace(p.type === "musician" ? "/(musician)/dashboard" : "/(curator)/dashboard"); }}>
                <Text>{p.name} ({p.type}){p.status !== "approved" ? `, ${p.status.replace("_", " ")}` : ""}</Text>
              </Pressable>
            ))}
            <Pressable onPress={() => { setOpen(false); router.push("/join"); }} style={{ padding: 12 }}>
              <Text style={{ color: "#2563eb" }}>+ Join as musician or curator</Text>
            </Pressable>
          </View>
        </Pressable>
      </Modal>
    </>
  );
}
```

- [ ] **Step 3: Tab layouts**

`apps/mobile/app/(fan)/_layout.tsx`:
```tsx
import { Tabs } from "expo-router";
import { ContextSwitcher } from "../../src/shell/ContextSwitcher";

export default function FanTabs() {
  return (
    <Tabs screenOptions={{ headerRight: () => <ContextSwitcher /> }}>
      <Tabs.Screen name="index" options={{ title: "Discover" }} />
      <Tabs.Screen name="tickets" options={{ title: "Tickets" }} />
      <Tabs.Screen name="search" options={{ title: "Search" }} />
      <Tabs.Screen name="account" options={{ title: "Account" }} />
    </Tabs>
  );
}
```
`(musician)/_layout.tsx` and `(curator)/_layout.tsx` follow the identical pattern with their tab lists from spec §5 (musician: Dashboard/Gigs/Portfolio/Messages/Account; curator: Dashboard/My Events/Find Talent/Messages/Account). Every screen file is a placeholder:
```tsx
import { View, Text } from "react-native";
export default function Screen() {
  return <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
    <Text>Coming in a later phase</Text></View>;
}
```
Exception, each `account.tsx` shows real actions:
```tsx
import { View, Text, Pressable } from "react-native";
import { useAuth } from "../../src/auth/AuthProvider";
export default function Account() {
  const { user, signOutUser } = useAuth();
  return (
    <View style={{ flex: 1, padding: 24, gap: 16 }}>
      <Text style={{ fontSize: 20 }}>{user?.email}</Text>
      <Pressable onPress={signOutUser}><Text style={{ color: "#dc2626" }}>Sign out</Text></Pressable>
    </View>
  );
}
```
Wrap the app in `ProfileProvider` inside `app/_layout.tsx` (inside `AuthProvider`), and change `app/index.tsx` to `import { Redirect } from "expo-router"; export default () => <Redirect href="/(fan)" />;`

- [ ] **Step 4: Join wizard (minimal per spec, full wizards are sub-projects 2-3)**

`apps/mobile/app/join.tsx`:
```tsx
import { useState } from "react";
import { View, Text, TextInput, Pressable, Alert, ScrollView } from "react-native";
import { httpsCallable } from "firebase/functions";
import { useRouter } from "expo-router";
import { getFirebase } from "../src/lib/firebase";
import { validateProfileDraft, type ProfileType } from "@gatekeep/shared";

const SUBTYPES: Record<ProfileType, { value: string; label: string }[]> = {
  musician: [{ value: "solo", label: "Solo act" }, { value: "band", label: "Band" }],
  curator: [{ value: "venue", label: "Venue" }, { value: "planner", label: "Event planner" },
            { value: "individual_host", label: "Individual host" }],
};

export default function Join() {
  const [type, setType] = useState<ProfileType>("musician");
  const [subtype, setSubtype] = useState("solo");
  const [name, setName] = useState("");
  const [handle, setHandle] = useState("");
  const router = useRouter();

  const submit = async () => {
    const input = { type, subtype, name, handle: handle.toLowerCase() };
    const v = validateProfileDraft(input);
    if (!v.ok) { Alert.alert("Check your info", v.reason); return; }
    try {
      const { functions } = getFirebase();
      const { data } = await httpsCallable<typeof input, { profileId: string }>(
        functions, "createProfileDraft")(input);
      await httpsCallable(functions, "submitProfileForReview")({ profileId: data.profileId });
      Alert.alert("Submitted!", "Our team will review your profile. We'll notify you.");
      router.back();
    } catch (e: any) {
      Alert.alert("Couldn't submit", e?.message ?? "Try again.");
    }
  };

  return (
    <ScrollView contentContainerStyle={{ padding: 24, gap: 12 }}>
      <Text style={{ fontSize: 24, fontWeight: "700" }}>Join GateKeep</Text>
      <View style={{ flexDirection: "row", gap: 8 }}>
        {(["musician", "curator"] as const).map((t) => (
          <Pressable key={t} onPress={() => { setType(t); setSubtype(SUBTYPES[t][0].value); }}
            style={{ borderWidth: 1, padding: 10, borderRadius: 8, backgroundColor: type === t ? "#111" : "#fff" }}>
            <Text style={{ color: type === t ? "#fff" : "#111" }}>{t}</Text>
          </Pressable>
        ))}
      </View>
      <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
        {SUBTYPES[type].map((s) => (
          <Pressable key={s.value} onPress={() => setSubtype(s.value)}
            style={{ borderWidth: 1, padding: 10, borderRadius: 8, backgroundColor: subtype === s.value ? "#111" : "#fff" }}>
            <Text style={{ color: subtype === s.value ? "#fff" : "#111" }}>{s.label}</Text>
          </Pressable>
        ))}
      </View>
      <TextInput placeholder="Name (band, venue, or your stage name)" value={name} onChangeText={setName}
        style={{ borderWidth: 1, padding: 12, borderRadius: 8 }} />
      <TextInput placeholder="Handle (yourname, lowercase, no spaces)" autoCapitalize="none"
        value={handle} onChangeText={setHandle} style={{ borderWidth: 1, padding: 12, borderRadius: 8 }} />
      <Pressable onPress={submit} style={{ backgroundColor: "#111", padding: 14, borderRadius: 8 }}>
        <Text style={{ color: "#fff", textAlign: "center" }}>Submit for review</Text>
      </Pressable>
    </ScrollView>
  );
}
```

- [ ] **Step 5: Manual verification**

Run: emulators + expo. Verify end-to-end: sign in → fan tabs render → switcher → "+ Join" → submit a band → switcher now lists it ", pending review" → emulator UI shows the profile with `status: pending_review`, member doc with your uid and `uid` field, handle doc claimed.

- [ ] **Step 6: Typecheck + commit**

Run: `pnpm typecheck && pnpm emu:test && pnpm emu:rules`
Expected: PASS (including the `uid`-field schema change ripple from Step 1).

```bash
git add -A
git commit -m "feat: mobile shell, context switcher, role tabs, join-as flow"
```

---

### Task 11: Web app, auth, public pages, dashboard shell

**Files:**
- Create: `apps/web/src/auth/AuthProvider.tsx` (client), `apps/web/app/sign-in/page.tsx`
- Create: `apps/web/app/u/[handle]/page.tsx` (public profile), `apps/web/app/dashboard/page.tsx`
- Modify: `apps/web/app/layout.tsx`, `apps/web/app/page.tsx`

**Interfaces:**
- Consumes: `getFirebase()` web (Task 3), rules (Task 4), same Firestore shapes.
- Produces: web `useAuth()` with the same signature as mobile's (Task 9). Public profile route `/u/[handle]`, later sub-projects extend this page with portfolio content. (`gatekeep.app/@handle` vanity URLs arrive with real hosting config; `/u/[handle]` is the canonical route.)

- [ ] **Step 1: Web AuthProvider + sign-in page**

`apps/web/src/auth/AuthProvider.tsx`: same file as mobile's `AuthProvider.tsx` (Task 9 Step 2) with `"use client";` as the first line and the import path `../lib/firebase`.

`apps/web/app/sign-in/page.tsx`:
```tsx
"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  signInWithEmailAndPassword, createUserWithEmailAndPassword, sendEmailVerification,
  signInWithPopup, GoogleAuthProvider, OAuthProvider,
} from "firebase/auth";
import { getFirebase } from "../../src/lib/firebase";

export default function SignInPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mode, setMode] = useState<"in" | "up">("in");
  const [error, setError] = useState("");
  const router = useRouter();
  const { auth } = getFirebase();

  const emailAuth = async () => {
    setError("");
    try {
      if (mode === "in") await signInWithEmailAndPassword(auth, email.trim(), password);
      else {
        const cred = await createUserWithEmailAndPassword(auth, email.trim(), password);
        await sendEmailVerification(cred.user);
      }
      router.push("/dashboard");
    } catch { setError(mode === "in" ? "That email and password don't match." : "Couldn't create the account."); }
  };
  const social = async (provider: "google" | "apple") => {
    setError("");
    try {
      await signInWithPopup(auth, provider === "google" ? new GoogleAuthProvider() : new OAuthProvider("apple.com"));
      router.push("/dashboard");
    } catch { setError("Sign-in didn't complete."); }
  };

  return (
    <main style={{ maxWidth: 380, margin: "80px auto", display: "grid", gap: 12 }}>
      <h1>GateKeep</h1>
      <input placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} />
      <input placeholder="Password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
      <button onClick={emailAuth}>{mode === "in" ? "Sign in" : "Create account"}</button>
      <button onClick={() => social("google")}>Continue with Google</button>
      <button onClick={() => social("apple")}>Continue with Apple</button>
      <button onClick={() => setMode(mode === "in" ? "up" : "in")}>
        {mode === "in" ? "New here? Create an account" : "Have an account? Sign in"}
      </button>
      <button onClick={async () => {
        if (!email.trim()) { setError("Enter your email above, then press Forgot password."); return; }
        const { sendPasswordResetEmail } = await import("firebase/auth");
        try { await sendPasswordResetEmail(auth, email.trim()); setError("Reset link sent, check your email."); }
        catch { setError("Couldn't send the reset email."); }
      }}>Forgot password?</button>
      {error && <p style={{ color: "#dc2626" }}>{error}</p>}
    </main>
  );
}
```
Wrap `app/layout.tsx`'s body content in `<AuthProvider>`.

- [ ] **Step 2: Public profile page (reads only approved, rules enforce it)**

`apps/web/app/u/[handle]/page.tsx`:
```tsx
"use client";
import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { doc, getDoc } from "firebase/firestore";
import { getFirebase } from "../../../src/lib/firebase";
import type { ProfileDoc } from "@gatekeep/shared";

export default function PublicProfile() {
  const { handle } = useParams<{ handle: string }>();
  const [profile, setProfile] = useState<ProfileDoc | null | "loading">("loading");
  useEffect(() => {
    (async () => {
      const { db } = getFirebase();
      const h = await getDoc(doc(db, "handles", handle));
      if (!h.exists()) { setProfile(null); return; }
      try {
        const p = await getDoc(doc(db, "profiles", h.data().profileId));
        setProfile(p.exists() ? (p.data() as ProfileDoc) : null);
      } catch { setProfile(null); } // permission-denied = not approved = treat as not found
    })();
  }, [handle]);
  if (profile === "loading") return <main><p>Loading…</p></main>;
  if (!profile) return <main><h1>Not found</h1><p>No profile at @{handle}.</p></main>;
  return (
    <main style={{ maxWidth: 640, margin: "40px auto" }}>
      <h1>{profile.name}</h1>
      <p>@{profile.handle} · {profile.type} ({profile.subtype})</p>
      <p><em>Portfolio content arrives in the next phase.</em></p>
    </main>
  );
}
```
(Server-rendered SEO version of this page comes with sub-project 2 when there is real content to render; the route and data path are what foundation locks in.)

- [ ] **Step 3: Dashboard shell with the same switcher pattern**

`apps/web/app/dashboard/page.tsx`:
```tsx
"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { collectionGroup, query, where, onSnapshot, doc, getDoc } from "firebase/firestore";
import { getFirebase } from "../../src/lib/firebase";
import { useAuth } from "../../src/auth/AuthProvider";
import type { ProfileType, ProfileStatus } from "@gatekeep/shared";

type ProfileSummary = { profileId: string; type: ProfileType; name: string; status: ProfileStatus };

export default function Dashboard() {
  const { user, loading, signOutUser } = useAuth();
  const [profiles, setProfiles] = useState<ProfileSummary[]>([]);
  const router = useRouter();
  useEffect(() => { if (!loading && !user) router.replace("/sign-in"); }, [user, loading]);
  useEffect(() => {
    if (!user) return;
    const { db } = getFirebase();
    return onSnapshot(query(collectionGroup(db, "members"), where("uid", "==", user.uid)), async (snap) => {
      const out: ProfileSummary[] = [];
      for (const m of snap.docs) {
        const p = await getDoc(doc(db, "profiles", m.ref.parent.parent!.id));
        if (p.exists()) out.push({ profileId: p.id, ...(p.data() as any) });
      }
      setProfiles(out);
    });
  }, [user?.uid]);
  if (loading || !user) return null;
  return (
    <main style={{ maxWidth: 760, margin: "40px auto" }}>
      <h1>Dashboard</h1>
      <p>{user.email} · <button onClick={signOutUser}>Sign out</button></p>
      <h2>Your profiles</h2>
      {profiles.length === 0 && <p>None yet, join as a musician or curator from the mobile app, or right here once wizards land in the next phase.</p>}
      <ul>{profiles.map((p) => (
        <li key={p.profileId}>{p.name}, {p.type}, {p.status.replace("_", " ")}</li>
      ))}</ul>
    </main>
  );
}
```

- [ ] **Step 4: Landing page links**

`apps/web/app/page.tsx`:
```tsx
import Link from "next/link";
export default function Home() {
  return (
    <main style={{ maxWidth: 640, margin: "80px auto" }}>
      <h1>GateKeep</h1>
      <p>Find the music. Book the night.</p>
      <p><Link href="/sign-in">Sign in</Link> · <Link href="/dashboard">Dashboard</Link></p>
    </main>
  );
}
```

- [ ] **Step 5: Manual verification + typecheck + commit**

Run: emulators + `pnpm --filter @gatekeep/web dev`. Verify: email sign-up works, dashboard lists the profile created in Task 10 with its status, `/u/<that-handle>` shows "Not found" while pending (rules deny), signed-out `/dashboard` redirects to `/sign-in`.
Run: `pnpm --filter @gatekeep/web typecheck` → PASS.

```bash
git add -A
git commit -m "feat: web auth, public profile route, dashboard shell"
```

---

### Task 12: Admin dashboard v1

**Files:**
- Create: `apps/web/app/admin/page.tsx`, `apps/web/app/admin/AdminGate.tsx`
- Modify: `firestore.rules` (admin read access), `tests-rules/rules.test.ts`

**Interfaces:**
- Consumes: `reviewProfile`, `grantAdmin` callables (Task 7); admin custom claim; rules.
- Produces: `/admin` with approvals queue + user lookup + audit log view. Rules addition: admin-claim holders can read `profiles` (any status), `members`, `auditLogs`, and `users` (for lookup).

- [ ] **Step 1: Extend rules for admin reads + failing rules tests**

Add tests to `tests-rules/rules.test.ts`:
```typescript
describe("admin reads", () => {
  it("admin token reads pending profiles, auditLogs, any user; non-admin cannot", async () => {
    await seed("profiles/p9", { name: "Pending", status: "pending_review" });
    await seed("auditLogs/l1", { action: "profile_approved", actorUid: "x" });
    await seed("users/target", { displayName: "T", email: "t@x.com" });
    const adminCtx = env.authenticatedContext("root", { admin: true }).firestore();
    const normal = env.authenticatedContext("norm").firestore();
    await assertSucceeds(getDoc(doc(adminCtx, "profiles/p9")));
    await assertSucceeds(getDoc(doc(adminCtx, "auditLogs/l1")));
    await assertSucceeds(getDoc(doc(adminCtx, "users/target")));
    await assertFails(getDoc(doc(normal, "auditLogs/l1")));
  });
});
```
Run `pnpm emu:rules` → the new tests FAIL. Then in `firestore.rules` add helper and allowances:
```
    function isAdmin() { return signedIn() && request.auth.token.admin == true; }
```
- `users/{uid}`: `allow read: if isOwner(uid) || isAdmin();`
- `profiles/{profileId}`: `allow read: if resource.data.status == 'approved' || isMember(profileId) || isAdmin();`
- members: append `|| isAdmin()` to the read rule
- `auditLogs`: `allow read: if isAdmin(); allow write: if false;`

Run `pnpm emu:rules` → PASS. Run the `firebase-security-rules-auditor` skill again on the changed rules.

- [ ] **Step 2: Admin gate component**

`apps/web/app/admin/AdminGate.tsx`:
```tsx
"use client";
import { useEffect, useState, type ReactNode } from "react";
import { useAuth } from "../../src/auth/AuthProvider";

export function AdminGate({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);
  useEffect(() => {
    if (!user) { if (!loading) setIsAdmin(false); return; }
    user.getIdTokenResult().then((t) => setIsAdmin(t.claims.admin === true));
  }, [user, loading]);
  if (isAdmin === null) return null;
  if (!isAdmin) return <main><h1>Not found</h1></main>; // invisible to non-admins, per spec §5
  return <>{children}</>;
}
```

- [ ] **Step 3: Admin page, queue, lookup, audit log**

`apps/web/app/admin/page.tsx`:
```tsx
"use client";
import { useEffect, useState } from "react";
import {
  collection, query, where, onSnapshot, orderBy, limit, getDocs,
} from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { getFirebase } from "../../src/lib/firebase";
import { AdminGate } from "./AdminGate";
import type { ProfileDoc, AuditLogDoc, UserDoc } from "@gatekeep/shared";

type Row<T> = T & { id: string };

function Queue() {
  const [pending, setPending] = useState<Row<ProfileDoc>[]>([]);
  const { db, functions } = getFirebase();
  useEffect(() => onSnapshot(
    query(collection(db, "profiles"), where("status", "==", "pending_review")),
    (s) => setPending(s.docs.map((d) => ({ id: d.id, ...(d.data() as ProfileDoc) })))), []);
  const review = async (profileId: string, decision: "approved" | "rejected") => {
    const reason = decision === "rejected"
      ? window.prompt("Rejection reason (shown to the applicant):") ?? "" : undefined;
    if (decision === "rejected" && !reason) return;
    await httpsCallable(functions, "reviewProfile")({ profileId, decision, reason });
  };
  return (
    <section>
      <h2>Approvals queue ({pending.length})</h2>
      {/* Review checklist per spec §6: verify identity, is this really them? */}
      {pending.map((p) => (
        <div key={p.id} style={{ border: "1px solid #ddd", padding: 12, marginBottom: 8 }}>
          <strong>{p.name}</strong> @{p.handle}, {p.type} ({p.subtype})
          <div>
            <button onClick={() => review(p.id, "approved")}>Approve</button>{" "}
            <button onClick={() => review(p.id, "rejected")}>Reject…</button>
          </div>
        </div>
      ))}
      {pending.length === 0 && <p>Nothing waiting.</p>}
    </section>
  );
}

function UserLookup() {
  const [term, setTerm] = useState("");
  const [results, setResults] = useState<Row<UserDoc>[]>([]);
  const { db } = getFirebase();
  const search = async () => {
    const s = await getDocs(query(collection(db, "users"), where("email", "==", term.trim())));
    setResults(s.docs.map((d) => ({ id: d.id, ...(d.data() as UserDoc) })));
  };
  return (
    <section>
      <h2>User lookup</h2>
      <input placeholder="exact email" value={term} onChange={(e) => setTerm(e.target.value)} />
      <button onClick={search}>Search</button>
      {results.map((u) => <p key={u.id}>{u.displayName} · {u.email} · uid {u.id}</p>)}
    </section>
  );
}

function AuditLog() {
  const [logs, setLogs] = useState<Row<AuditLogDoc>[]>([]);
  const { db } = getFirebase();
  useEffect(() => onSnapshot(
    query(collection(db, "auditLogs"), orderBy("at", "desc"), limit(50)),
    (s) => setLogs(s.docs.map((d) => ({ id: d.id, ...(d.data() as AuditLogDoc) })))), []);
  return (
    <section>
      <h2>Audit log</h2>
      {logs.map((l) => (
        <p key={l.id}>{new Date(l.at).toLocaleString()}, {l.action}, target {l.targetId}, by {l.actorUid} {l.detail && `, ${l.detail}`}</p>
      ))}
    </section>
  );
}

export default function AdminPage() {
  return (
    <AdminGate>
      <main style={{ maxWidth: 860, margin: "40px auto", display: "grid", gap: 32 }}>
        <h1>GateKeep Admin</h1>
        <Queue /><UserLookup /><AuditLog />
      </main>
    </AdminGate>
  );
}
```

- [ ] **Step 4: Manual verification**

Run: emulators + web dev server. Seed an admin: `FIREBASE_AUTH_EMULATOR_HOST=localhost:9099 pnpm tsx scripts/seed-admin.ts <your-test-email>` (after signing that user up). Verify: non-admin sees "Not found" at `/admin`; admin sees the Task 10 pending profile; Approve flips it (switcher on mobile now shows it approved; `/u/<handle>` now renders); Reject requires a reason; audit log lists both actions.

- [ ] **Step 5: Typecheck + commit**

Run: `pnpm typecheck && pnpm emu:rules`
Expected: PASS.

```bash
git add -A
git commit -m "feat: admin dashboard, approvals queue, user lookup, audit log"
```

---

### Task 13: Notifications plumbing

**Files:**
- Create: `functions/src/notifications.ts`, `apps/mobile/src/notifications/push.ts`, `apps/mobile/src/shell/NotificationsList.tsx` (rendered inside each Account screen, see Step 4)
- Modify: `functions/src/review.ts`, `functions/src/index.ts`
- Test: `functions/test/notifications.test.ts`

**Interfaces:**
- Consumes: `reviewProfile` (Task 7), `NotificationDoc` from shared, `pushTokens` rules (Task 4).
- Produces: `notifyUser(uid: string, note: Omit<NotificationDoc, "read" | "createdAt">): Promise<void>` in `functions/src/notifications.ts`, every later trigger (bookings, tickets) calls this exact function. It writes the inbox doc AND sends Expo push to all of the user's registered tokens. Mobile: `registerForPush(uid: string)` stores the Expo token at `users/{uid}/pushTokens/{token}`.

- [ ] **Step 1: Write failing test, approval notifies all profile members**

`functions/test/notifications.test.ts`:
```typescript
import { describe, it, expect } from "vitest";
import { signUpTestUser, callFn, wait } from "./helpers";
import * as adminApp from "firebase-admin/app";
import { getFirestore as adminFirestore } from "firebase-admin/firestore";
import { getAuth as adminAuth } from "firebase-admin/auth";
import type { ProfileDraftInput } from "@gatekeep/shared";

process.env.FIRESTORE_EMULATOR_HOST = "localhost:8080";
process.env.FIREBASE_AUTH_EMULATOR_HOST = "localhost:9099";
const admin = adminApp.getApps()[0] ?? adminApp.initializeApp({ projectId: "gatekeep-dev" });
const adb = adminFirestore(admin);

describe("review notifications", () => {
  it("approving a profile writes an inbox notification for each member", async () => {
    const owner = await signUpTestUser(`n1-${Date.now()}@test.com`);
    const { profileId } = await callFn<ProfileDraftInput, { profileId: string }>(
      "createProfileDraft",
      { type: "musician", subtype: "solo", name: "Nova", handle: `nova_${Date.now()}` }, owner.user);
    await callFn("submitProfileForReview", { profileId }, owner.user);
    const adminUser = await signUpTestUser(`na-${Date.now()}@test.com`);
    await adminAuth(admin).setCustomUserClaims(adminUser.uid, { admin: true });
    await adminUser.user.getIdToken(true);
    await callFn("reviewProfile", { profileId, decision: "approved" }, adminUser.user);
    await wait(500);
    const notes = await adb.collection(`users/${owner.uid}/notifications`).get();
    expect(notes.size).toBe(1);
    expect(notes.docs[0].data().kind).toBe("profile_review");
    expect(notes.docs[0].data().read).toBe(false);
    expect(notes.docs[0].data().title).toMatch(/approved/i);
  });
});
```

- [ ] **Step 2: Run, verify fail**

Run: `pnpm --filter functions build && pnpm emu:test`
Expected: the new test FAILS (no notification written).

- [ ] **Step 3: Implement notifyUser + wire into reviewProfile**

`functions/src/notifications.ts`:
```typescript
import { getFirestore } from "firebase-admin/firestore";
import type { NotificationDoc } from "@gatekeep/shared";

export async function notifyUser(uid: string, note: Omit<NotificationDoc, "read" | "createdAt">): Promise<void> {
  const db = getFirestore();
  const full: NotificationDoc = { ...note, read: false, createdAt: Date.now() };
  await db.collection(`users/${uid}/notifications`).add(full);

  const tokens = await db.collection(`users/${uid}/pushTokens`).get();
  if (tokens.empty) return;
  const messages = tokens.docs.map((t) => ({ to: t.id, title: note.title, body: note.body }));
  try {
    await fetch("https://exp.host/--/api/v2/push/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(messages),
    });
  } catch (e) {
    console.error("expo push failed", e); // inbox write already succeeded; push is best-effort
  }
}

export async function notifyProfileMembers(profileId: string, note: Omit<NotificationDoc, "read" | "createdAt">) {
  const members = await getFirestore().collection(`profiles/${profileId}/members`).get();
  await Promise.all(members.docs.map((m) => notifyUser(m.id, note)));
}
```

In `functions/src/review.ts`, after the audit write in `reviewProfile`, add:
```typescript
    const profileName = snap.data()?.name ?? "Your profile";
    await notifyProfileMembers(profileId, {
      kind: "profile_review",
      title: decision === "approved" ? `${profileName} is approved!` : `${profileName} needs changes`,
      body: decision === "approved"
        ? "Your profile is live on GateKeep."
        : `Reviewer note: ${reason!.trim()}, update and resubmit anytime.`,
    });
```
with `import { notifyProfileMembers } from "./notifications.js";`

- [ ] **Step 4: Mobile, token registration + inbox list**

```bash
cd apps/mobile && npx expo install expo-notifications expo-device expo-constants
```

`apps/mobile/src/notifications/push.ts`:
```typescript
import * as Notifications from "expo-notifications";
import * as Device from "expo-device";
import Constants from "expo-constants";
import { doc, setDoc } from "firebase/firestore";
import { getFirebase } from "../lib/firebase";

export async function registerForPush(uid: string): Promise<void> {
  if (!Device.isDevice) return; // simulators can't receive push
  const { status: existing } = await Notifications.getPermissionsAsync();
  const status = existing === "granted"
    ? existing
    : (await Notifications.requestPermissionsAsync()).status;
  if (status !== "granted") return;
  const projectId = Constants.expoConfig?.extra?.eas?.projectId;
  const token = (await Notifications.getExpoPushTokenAsync({ projectId })).data;
  await setDoc(doc(getFirebase().db, `users/${uid}/pushTokens/${token}`), { createdAt: Date.now() });
}
```
Call `registerForPush(user.uid)` from a `useEffect` in `ProfileProvider` (Task 10) when `user` becomes non-null.

Add a Notifications section to each `account.tsx` (fan/musician/curator, same component, extract to `apps/mobile/src/shell/NotificationsList.tsx`):
```tsx
import { View, Text, Pressable, FlatList } from "react-native";
import { useEffect, useState } from "react";
import { collection, query, orderBy, limit, onSnapshot, doc, updateDoc } from "firebase/firestore";
import { getFirebase } from "../lib/firebase";
import { useAuth } from "../auth/AuthProvider";
import type { NotificationDoc } from "@gatekeep/shared";

export function NotificationsList() {
  const { user } = useAuth();
  const [notes, setNotes] = useState<({ id: string } & NotificationDoc)[]>([]);
  useEffect(() => {
    if (!user) return;
    const { db } = getFirebase();
    return onSnapshot(
      query(collection(db, `users/${user.uid}/notifications`), orderBy("createdAt", "desc"), limit(30)),
      (s) => setNotes(s.docs.map((d) => ({ id: d.id, ...(d.data() as NotificationDoc) }))));
  }, [user?.uid]);
  const markRead = (id: string) =>
    updateDoc(doc(getFirebase().db, `users/${user!.uid}/notifications/${id}`), { read: true });
  return (
    <FlatList data={notes} keyExtractor={(n) => n.id}
      ListHeaderComponent={<Text style={{ fontSize: 18, fontWeight: "600" }}>Notifications</Text>}
      renderItem={({ item }) => (
        <Pressable onPress={() => markRead(item.id)}
          style={{ padding: 12, opacity: item.read ? 0.5 : 1 }}>
          <Text style={{ fontWeight: "600" }}>{item.title}</Text>
          <Text>{item.body}</Text>
        </Pressable>
      )} />
  );
}
```
Web: add the same list (JSX-adapted with `div`/`p`) to `apps/web/app/dashboard/page.tsx` below the profiles list.

**Deliberate deferral:** background web push (FCM service worker + VAPID keys) is NOT in foundation, on web, notifications appear in the realtime dashboard inbox only. Background web push ships with sub-project 7 (fan discovery), where fan-facing notifications actually matter. This narrows spec §7's "web push/FCM (web)" line for v1 foundation, flagged to the user at plan review.

- [ ] **Step 5: Run tests + manual verification**

Run: `pnpm --filter functions build && pnpm emu:test` → PASS.
Manual: approve a pending profile in `/admin` → notification appears in the mobile Account tab and web dashboard, unread; tapping marks it read.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: notification plumbing, inbox, expo push tokens, review notifications"
```

---

### Task 14: Account deletion

**Files:**
- Create: `functions/src/account.ts`
- Modify: `functions/src/index.ts`, mobile `account.tsx` screens (via shared component), `apps/web/app/dashboard/page.tsx`
- Test: `functions/test/account.test.ts`

**Interfaces:**
- Consumes: membership invariants (Task 8), helpers (Task 5).
- Produces: callable `deleteAccount(data: Record<string, never>) → { ok: true }`, deletes auth user, `users/{uid}` + subcollections, and removes their memberships; refuses (`failed-precondition`) if they are the sole admin of any profile, naming the profiles in the error message (spec §4).

- [ ] **Step 1: Write failing tests**

`functions/test/account.test.ts`:
```typescript
import { describe, it, expect } from "vitest";
import { signUpTestUser, callFn, wait } from "./helpers";
import * as adminApp from "firebase-admin/app";
import { getFirestore as adminFirestore } from "firebase-admin/firestore";
import { getAuth as adminAuth } from "firebase-admin/auth";
import type { ProfileDraftInput } from "@gatekeep/shared";

process.env.FIRESTORE_EMULATOR_HOST = "localhost:8080";
process.env.FIREBASE_AUTH_EMULATOR_HOST = "localhost:9099";
const admin = adminApp.getApps()[0] ?? adminApp.initializeApp({ projectId: "gatekeep-dev" });
const adb = adminFirestore(admin);

describe("deleteAccount", () => {
  it("deletes a plain fan account: auth user, users doc, subcollections", async () => {
    const fan = await signUpTestUser(`d1-${Date.now()}@test.com`);
    await wait(1500); // let onUserCreated land
    await adb.doc(`users/${fan.uid}/notifications/n1`).set({ title: "x", read: false });
    await callFn("deleteAccount", {}, fan.user);
    expect((await adb.doc(`users/${fan.uid}`).get()).exists).toBe(false);
    expect((await adb.doc(`users/${fan.uid}/notifications/n1`).get()).exists).toBe(false);
    await expect(adminAuth(admin).getUser(fan.uid)).rejects.toThrow();
  });
  it("refuses while sole admin of a profile, naming it", async () => {
    const owner = await signUpTestUser(`d2-${Date.now()}@test.com`);
    await callFn<ProfileDraftInput, { profileId: string }>(
      "createProfileDraft",
      { type: "musician", subtype: "solo", name: "Solo Act", handle: `del_${Date.now()}` }, owner.user);
    await expect(callFn("deleteAccount", {}, owner.user)).rejects.toThrow(/Solo Act/);
  });
  it("succeeds after admin transfer; membership removed", async () => {
    const owner = await signUpTestUser(`d3-${Date.now()}@test.com`);
    const { profileId } = await callFn<ProfileDraftInput, { profileId: string }>(
      "createProfileDraft",
      { type: "curator", subtype: "venue", name: "Loft", handle: `loft_${Date.now()}` }, owner.user);
    const email = `d4-${Date.now()}@test.com`;
    const co = await signUpTestUser(email);
    const { inviteId } = await callFn<object, { inviteId: string }>(
      "inviteMember", { profileId, email, role: "member", label: "manager" }, owner.user);
    await callFn("respondToInvite", { inviteId, accept: true }, co.user);
    await callFn("transferAdmin", { profileId, toUid: co.uid }, owner.user);
    await callFn("deleteAccount", {}, owner.user);
    expect((await adb.doc(`profiles/${profileId}/members/${owner.uid}`).get()).exists).toBe(false);
    expect((await adb.doc(`profiles/${profileId}/members/${co.uid}`).get()).exists).toBe(true);
  });
});
```

- [ ] **Step 2: Run, verify fail**

Run: `pnpm --filter functions build && pnpm emu:test`
Expected: FAIL, callable not found.

- [ ] **Step 3: Implement**

`functions/src/account.ts`:
```typescript
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getFirestore } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";

export const deleteAccount = onCall({ region: "us-central1" }, async (req) => {
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Sign in first.");
  const db = getFirestore();

  // Block deletion while sole admin anywhere (spec §4).
  const memberships = await db.collectionGroup("members").where("uid", "==", uid).get();
  const soleAdminOf: string[] = [];
  for (const m of memberships.docs) {
    if (m.data().role !== "admin") continue;
    const profileRef = m.ref.parent.parent!;
    const admins = await profileRef.collection("members").where("role", "==", "admin").get();
    if (admins.size <= 1) {
      const p = await profileRef.get();
      soleAdminOf.push(p.data()?.name ?? profileRef.id);
    }
  }
  if (soleAdminOf.length > 0) {
    throw new HttpsError("failed-precondition",
      `You are the only admin of: ${soleAdminOf.join(", ")}. Transfer admin or delete those profiles first.`);
  }

  // Remove memberships, then the user doc tree, then the auth account.
  await Promise.all(memberships.docs.map((m) => m.ref.delete()));
  await db.recursiveDelete(db.doc(`users/${uid}`));
  await getAuth().deleteUser(uid);
  return { ok: true };
});
```
Add to `functions/src/index.ts`: `export { deleteAccount } from "./account.js";`

- [ ] **Step 4: UI entry points**

Mobile, add to the shared account screen component, below Sign out:
```tsx
<Pressable onPress={() => {
  Alert.alert("Delete account", "This permanently deletes your account and data. Continue?",
    [{ text: "Cancel", style: "cancel" },
     { text: "Delete", style: "destructive", onPress: async () => {
        try { await httpsCallable(getFirebase().functions, "deleteAccount")({}); }
        catch (e: any) { Alert.alert("Can't delete yet", e?.message ?? ""); }
     } }]);
}}>
  <Text style={{ color: "#dc2626" }}>Delete account</Text>
</Pressable>
```
Web, same action with `window.confirm` in the dashboard, then `router.push("/")`.

- [ ] **Step 5: Run, verify pass; commit**

Run: `pnpm --filter functions build && pnpm emu:test && pnpm typecheck`
Expected: PASS.

```bash
git add -A
git commit -m "feat: in-app account deletion with sole-admin guard"
```

---

### Task 15: App Check, crash reporting, final security pass

**Files:**
- Modify: `apps/mobile/src/lib/firebase.ts`, `apps/web/src/lib/firebase.ts`, `apps/mobile/app.json`
- Create: `README.md`

**Interfaces:**
- Consumes: everything.
- Produces: the audited, documented foundation branch ready for merge.

- [ ] **Step 1: App Check (spec §8)**

Console: Firebase → App Check → register the web app with **reCAPTCHA v3** and the mobile apps with **Play Integrity** (Android) / **App Attest** (iOS). Keep enforcement in "monitor" mode until both stores' builds exist, flip to "enforce" for Firestore + Functions as a launch-checklist item.

Web (`apps/web/src/lib/firebase.ts`, inside `getFirebase()` before returning, browser-only):
```typescript
import { initializeAppCheck, ReCaptchaV3Provider } from "firebase/app-check";
if (typeof window !== "undefined" && process.env.NODE_ENV === "production") {
  initializeAppCheck(app, {
    provider: new ReCaptchaV3Provider("REPLACE_RECAPTCHA_SITE_KEY"),
    isTokenAutoRefreshEnabled: true,
  });
}
```
Mobile: `npx expo install @react-native-firebase/app @react-native-firebase/app-check` is the native path, but mixing `@react-native-firebase` with the JS SDK is a real architecture decision. **Decision recorded:** v1 mobile ships with App Check in monitor mode via the console only (no client change); native App Check attestation lands with the EAS production build task in sub-project 2, where the dev-build pipeline already exists. This keeps foundation unblocked and is why enforcement stays in monitor mode.

- [ ] **Step 2: Crash reporting, Sentry (works on Expo AND Next.js; one vendor for both)**

```bash
cd apps/mobile && npx expo install @sentry/react-native
cd ../web && pnpm add @sentry/nextjs
```
Mobile `app/_layout.tsx` top:
```typescript
import * as Sentry from "@sentry/react-native";
Sentry.init({ dsn: process.env.EXPO_PUBLIC_SENTRY_DSN ?? "", enabled: !__DEV__ });
```
Web: `npx @sentry/wizard@latest -i nextjs` (accept defaults; DSN from a free Sentry project). Both no-op in dev.

- [ ] **Step 3: README**

`README.md`: project one-liner, monorepo map (from this plan's File Structure), prerequisites (Node 20, pnpm, Java for Android builds, Xcode for iOS), and the four commands that matter: `pnpm install`, `pnpm emu`, `pnpm emu:test && pnpm emu:rules`, `pnpm --filter @gatekeep/web dev` / `expo start`. Point to `docs/superpowers/specs/` for design docs.

- [ ] **Step 4: Full verification sweep**

Run, in order:
```bash
pnpm install
pnpm typecheck
pnpm --filter @gatekeep/shared test
pnpm --filter functions build
pnpm emu:test
pnpm emu:rules
```
Expected: everything PASS. Then the manual loop once more end-to-end: sign up (mobile) → join as band → admin approves (web) → notification arrives → `/u/handle` public → invite a member → accept → delete a fan account.

- [ ] **Step 5: Security gates (Global Constraints)**

Invoke the `firebase-security-rules-auditor` skill on the final `firestore.rules`. Then invoke the `security-review` skill on the branch. Fix findings; re-run the sweep after any fix.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: app check config, sentry crash reporting, README + final security pass"
```

---

## Done means

All 15 tasks committed; `pnpm typecheck`, shared tests, functions emulator tests, and rules tests all green; the manual end-to-end loop (sign up → join → approve → notify → public page → invite → delete) verified on mobile + web against emulators; both security skills run clean. Foundation is then merged per the superpowers:finishing-a-development-branch skill, and sub-project 2 (musician portfolio) brainstorming begins.



