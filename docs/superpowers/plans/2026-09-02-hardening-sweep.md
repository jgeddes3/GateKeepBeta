# Sub-project 10, Branch A: Sweep Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A behavior-free branch that removes every em dash from the repo, moves Cloud Functions to Node 22, repairs two Firestore field overrides, ignores local tooling files, and adds CI, so sub-project 7 and Branch B rebase onto a clean base.

**Architecture:** One worktree branch `worktree-sp10-sweep` off `main`. Five tasks, each its own commit, each ending with a gate that proves counts are identical to main (typecheck 5/5, shared 158, `emu:test` 704, `emu:rules` 103, lints 0 errors, web build). No source behavior changes: only string literals, comments, docs, config, and a new workflow file.

**Tech Stack:** Node 22, pnpm 11 via corepack, Firebase emulator suite (Java 21), GitHub Actions, a throwaway Node script for the sweep (not committed).

**Spec:** `docs/superpowers/specs/2026-09-02-hardening-design.md`, section 3 (Branch A).

## Global Constraints

- **No em dashes anywhere** after this branch: code, comments, copy, docs, commit messages. The character is U+2014. En dashes (U+2013) and middots are sanctioned range and separator glyphs and are left alone.
- **Zero behavior change.** Every gate count must equal main's: typecheck 5/5, shared 158, `pnpm emu:test` 704, `pnpm emu:rules` 103, web lint 0 errors, mobile lint 0 errors, `pnpm --filter @gatekeep/web build` green.
- Emulator suites need Java on PATH (`C:\Users\LeoArkos\.jre\jdk-21.0.12.1+1-jre\bin` on the dev box) and `FUNCTIONS_DISCOVERY_TIMEOUT=60`; run them as one blocking foreground call with a 600000 ms timeout, never backgrounded.
- Do not touch `.claude/worktrees/**` (the SP7 worktree), `node_modules`, `dist`, `.next`, `.expo`, or `pnpm-lock.yaml`.
- Byte-safe tools only on Windows: PowerShell 5.1 corrupts UTF-8 through `Get-Content`/`Set-Content` pipelines. Use Node scripts or Git Bash for every file rewrite in this plan.
- Commit messages end with the session attribution lines the harness prescribes.

---

## File map

- Task 1: every text file outside the excluded paths (sweep), `.gitignore` (adds `apps/web/AGENTS.md`), test assertions in `functions/test/*.test.ts` and `packages/shared/test/*.test.ts`, README quotes.
- Task 2: `functions/package.json`, `firebase.json`, `package.json` (root engines), `.nvmrc` (new).
- Task 3: `firestore.indexes.json`.
- Task 4: `.gitignore` (adds `.claude/settings.local.json`, `.claude/worktrees/`).
- Task 5: `.github/workflows/ci.yml` (new), `.github/dependabot.yml` (new).

---

### Task 0: Worktree

- [ ] **Step 1: Create the branch worktree**

```bash
cd /c/Users/LeoArkos/GateKeepBeta
git worktree add -b worktree-sp10-sweep .worktrees/sp10-sweep main
cd .worktrees/sp10-sweep
pnpm install
pnpm --filter @gatekeep/web exec next typegen
```

Expected: `pnpm install` finishes without changing `pnpm-lock.yaml` (`git status --short` shows nothing).

- [ ] **Step 2: Record the baseline counts**

```bash
export PATH="/c/Users/LeoArkos/.jre/jdk-21.0.12.1+1-jre/bin:$PATH"
export FUNCTIONS_DISCOVERY_TIMEOUT=60
pnpm typecheck 2>&1 | tail -3
pnpm --filter @gatekeep/shared test 2>&1 | grep -E "Tests|Test Files"
pnpm emu:rules 2>&1 | grep -E "Tests|Test Files"
pnpm emu:test 2>&1 | grep -E "Tests|Test Files"
```

Expected: 5 typecheck workspaces done, `158 passed`, `103 passed`, `704 passed`. These four numbers are the gate for every later task.

---

### Task 1: Em-dash sweep

**Files:**
- Modify: every file that `git grep -I -l $'\xe2\x80\x94'` lists (about 196 files: `README.md`, `DESIGN.md`, `docs/superpowers/**`, `functions/src/**`, `functions/test/**`, `packages/shared/src/**`, `packages/shared/test/**`, `firestore.rules`, `storage.rules`, `tests-rules/**`, `scripts/**`, `apps/web/src/**`, `apps/web/app/**`).
- Modify: `.gitignore` (add `apps/web/AGENTS.md`, then `git rm --cached apps/web/AGENTS.md`).
- Test: the existing suites; assertions that compare shipped strings are updated in the same commit.

**Interfaces:**
- Produces: a repo where `git grep -I -c $'\xe2\x80\x94'` prints nothing, which Task 5's CI step enforces.

- [ ] **Step 1: List the files and count the glyphs**

```bash
git grep -I -c $'\xe2\x80\x94' -- . ':!pnpm-lock.yaml' ':!.claude' | sort -t: -k2 -nr > /tmp/emdash-before.txt
wc -l /tmp/emdash-before.txt
awk -F: '{s+=$2} END {print s}' /tmp/emdash-before.txt
```

Expected: about 196 files and about 3,800 glyphs. Keep the file; Step 7 compares against it.

- [ ] **Step 2: Write the throwaway sweep script in the scratchpad (not in the repo)**

Save as `C:\Users\LeoArkos\AppData\Local\Temp\claude\sweep-emdash.mjs` (any path outside the repo works):

```js
// Usage: node sweep-emdash.mjs <repo-root> [--apply]
// Without --apply it only prints every replacement as "file:line: before => after".
import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";

const root = process.argv[2];
const apply = process.argv.includes("--apply");
const files = execSync("git grep -I -l $'\\xe2\\x80\\x94' -- . ':!pnpm-lock.yaml' ':!.claude'", { cwd: root, shell: "/usr/bin/bash" })
  .toString().split("\n").filter(Boolean);

// Context rules, applied in order to each occurrence:
//  1. "word U+2014 word" (spaced, mid-sentence)            => "word, word"
//  2. "wordU+2014word"   (unspaced)                         => "word, word"
//  3. "U+2014 " at the start of a line (list-ish dash)      => "" (drop the dash, keep the text)
//  4. " U+2014" at the end of a line (trailing)             => ","
// Anything a comma reads badly for is fixed by hand in Step 4 (string literals only).
function sweepLine(line) {
  return line
    .replace(/^(\s*)\u2014\s+/g, "$1")
    .replace(/\s+\u2014$/g, ",")
    .replace(/\s*\u2014\s*/g, ", ");
}

let total = 0;
for (const rel of files) {
  const path = join(root, rel);
  const original = readFileSync(path, "utf8");
  const eol = original.includes("\r\n") ? "\r\n" : "\n";
  const lines = original.split(eol);
  const out = lines.map((line, i) => {
    if (!line.includes("\u2014")) return line;
    const next = sweepLine(line);
    total += (line.match(/\u2014/g) ?? []).length;
    console.log(`${rel}:${i + 1}: ${line.trim()}\n    => ${next.trim()}`);
    return next;
  });
  if (apply) writeFileSync(path, out.join(eol), "utf8");
}
console.error(`${apply ? "replaced" : "would replace"} ${total} em dashes in ${files.length} files`);
```

- [ ] **Step 3: Dry-run and read the listing**

```bash
node "C:/Users/LeoArkos/AppData/Local/Temp/claude/sweep-emdash.mjs" "$(pwd)" > /tmp/emdash-dryrun.txt 2>&1
tail -1 /tmp/emdash-dryrun.txt
grep -c '=>' /tmp/emdash-dryrun.txt
```

Expected: the last line reports about 3,800 would-be replacements. Skim the listing; the comma default is fine for comments and docs.

- [ ] **Step 4: Apply, then hand-fix the shipped string literals**

```bash
node "C:/Users/LeoArkos/AppData/Local/Temp/claude/sweep-emdash.mjs" "$(pwd)" --apply
git grep -I -c $'\xe2\x80\x94' -- . ':!pnpm-lock.yaml' ':!.claude' ; echo "exit=$?"
```

Expected: no output and `exit=1` (git grep found nothing). Then open the files whose string literals users see and replace the comma with a colon or a period wherever the comma reads wrong. The exact set to review (every string literal the sweep touched in these files):

```bash
git diff -U0 -- packages/shared/src/messages.ts packages/shared/src/validation.ts \
  functions/src/account.ts functions/src/adminTools.ts functions/src/bookingLifecycle.ts \
  functions/src/bookings.ts functions/src/curator.ts functions/src/gigs.ts functions/src/media.ts \
  functions/src/payments.ts functions/src/paymentsCore.ts functions/src/paymentsPayouts.ts \
  functions/src/paymentsSettlement.ts functions/src/paymentsSweep.ts functions/src/profiles.ts \
  functions/src/review.ts functions/src/tracks.ts functions/src/scheduled.ts \
  | grep -E '^\+.*["`]' | grep -v '^\+\s*//'
```

House rule for the hand pass: two independent clauses get a period ("Your card was declined. Update your payment method and try again."); a clause that explains the one before it gets a colon ("Thread is full: accept, decline or withdraw."); a short aside stays a comma. Do not change wording, only punctuation.

- [ ] **Step 5: Update the tests and README quotes that assert on shipped strings**

```bash
pnpm --filter @gatekeep/shared test 2>&1 | grep -E "FAIL|✗|×|expected" | head -40
```

Every failing assertion names a string constant; the test compares against the literal, so update the literal in the test to the new punctuation (never the other way round). Then the README quotes:

```bash
grep -n 'Your card was declined\|overdue payment\|update your payment method' README.md docs/superpowers/sp5b-rulings.md
```

Update those quotes to the new punctuation (README lines near 802, 829, 848, 849 and the sp5b walkthrough summary near line 96).

- [ ] **Step 6: Gitignore the Next-generated AGENTS.md**

```bash
printf '\napps/web/AGENTS.md\n' >> .gitignore
git rm --cached -q apps/web/AGENTS.md
```

Expected: `git status --short` shows `D  apps/web/AGENTS.md` and the modified `.gitignore`; the file stays on disk.

- [ ] **Step 7: Run every gate and compare counts**

```bash
export PATH="/c/Users/LeoArkos/.jre/jdk-21.0.12.1+1-jre/bin:$PATH"
export FUNCTIONS_DISCOVERY_TIMEOUT=60
pnpm typecheck 2>&1 | tail -3
pnpm --filter @gatekeep/shared test 2>&1 | grep -E "Tests "
pnpm emu:rules 2>&1 | grep -E "Tests "
pnpm emu:test 2>&1 | grep -E "Tests "
pnpm --filter @gatekeep/web lint 2>&1 | tail -2
pnpm --filter @gatekeep/mobile lint 2>&1 | tail -2
pnpm --filter @gatekeep/web build 2>&1 | grep -E "Compiled|error" 
git grep -I -c $'\xe2\x80\x94' -- . ':!pnpm-lock.yaml' ':!.claude' ; echo "exit=$?"
```

Expected: 5 workspaces, `158 passed`, `103 passed`, `704 passed`, `0 errors` twice, `Compiled successfully`, and `exit=1` from the grep.

- [ ] **Step 8: Commit**

```bash
git add -A -- . ':!.claude'
git commit -m "chore: remove every em dash from the repo (rule enforced by CI from this branch)"
```

---

### Task 2: Node 22 runtime

**Files:**
- Modify: `functions/package.json:5-7` (`engines.node`), `firebase.json:4` (`runtime`), `package.json:5-8` (root `engines.node`).
- Create: `.nvmrc`.

**Interfaces:**
- Produces: the runtime string `nodejs22` that Task 5's CI and the README deploy notes rely on.

- [ ] **Step 1: Install Node 22 locally without admin rights**

Download the Windows x64 zip for the current Node 22 LTS from nodejs.org, unzip to `%USERPROFILE%\.nodes\node-v22`, then in Git Bash:

```bash
export PATH="/c/Users/LeoArkos/.nodes/node-v22:$PATH"
node --version
corepack enable --install-directory "/c/Users/LeoArkos/.nodes/node-v22"
pnpm --version
```

Expected: `v22.x.y` and `11.23.0` (the `packageManager` pin).

- [ ] **Step 2: Edit the three engine pins and add `.nvmrc`**

`functions/package.json`:

```json
  "engines": {
    "node": "22"
  },
```

`firebase.json`:

```json
  "functions": { "source": "functions", "runtime": "nodejs22", "predeploy": ["pnpm --filter functions build"] },
```

Root `package.json`:

```json
  "engines": {
    "node": ">=22",
    "pnpm": ">=9"
  },
```

`.nvmrc` (new, one line, no trailing text):

```
22
```

- [ ] **Step 3: Run the emulator suite under Node 22**

```bash
export PATH="/c/Users/LeoArkos/.nodes/node-v22:/c/Users/LeoArkos/.jre/jdk-21.0.12.1+1-jre/bin:$PATH"
export FUNCTIONS_DISCOVERY_TIMEOUT=60
node --version
pnpm install --frozen-lockfile
pnpm typecheck 2>&1 | tail -3
pnpm emu:test 2>&1 | grep -E "Tests |Unsupported engine"
pnpm emu:rules 2>&1 | grep -E "Tests "
```

Expected: `v22`, no `Unsupported engine` warning, `704 passed`, `103 passed`. (`sharp` and `ffmpeg-static` download their Node 22 prebuilt binaries during `pnpm install`; if `sharp` fails to load, run `pnpm rebuild sharp` inside `functions`.)

- [ ] **Step 4: Commit**

```bash
git add functions/package.json firebase.json package.json .nvmrc
git commit -m "chore(functions): move the Cloud Functions runtime to Node 22 (nodejs20 decommissions 2026-10-30)"
```

---

### Task 3: Field override repair

**Files:**
- Modify: `firestore.indexes.json:222-226` (the `members`/`uid` and `tickets`/`orderId` overrides) and the `gigs (bookedMusicianProfileId, startsAt)` composite at lines 60-64.
- Test: `pnpm emu:rules` and `pnpm emu:test` (the emulator ignores indexes, so the gate is JSON validity plus unchanged counts; the real proof is the console after deploy, recorded in the README launch checklist by Branch B).

**Interfaces:**
- Produces: the override shape Branch B's new `payments (musicianProfileId, settlement.status)` composite is added beside.

- [ ] **Step 1: Replace the two overrides**

Change the two entries so they read exactly:

```json
  { "collectionGroup": "members", "fieldPath": "uid",
    "indexes": [ { "queryScope": "COLLECTION", "order": "ASCENDING" },
                 { "queryScope": "COLLECTION", "order": "DESCENDING" },
                 { "queryScope": "COLLECTION_GROUP", "order": "ASCENDING" } ] },
  { "collectionGroup": "tickets", "fieldPath": "orderId",
    "indexes": [ { "queryScope": "COLLECTION", "order": "ASCENDING" },
                 { "queryScope": "COLLECTION", "order": "DESCENDING" },
                 { "queryScope": "COLLECTION_GROUP", "order": "ASCENDING" } ] },
```

- [ ] **Step 2: Delete the unused composite**

Remove this whole entry (verify first with `grep -rn "bookedMusicianProfileId" apps functions/src scripts | grep -v status` that no query uses the two-field form):

```json
  { "collectionGroup": "gigs", "queryScope": "COLLECTION",
    "fields": [
      { "fieldPath": "bookedMusicianProfileId", "order": "ASCENDING" },
      { "fieldPath": "startsAt", "order": "ASCENDING" }
    ] },
```

- [ ] **Step 3: Validate the JSON and run the emulator suites**

```bash
node -e "JSON.parse(require('fs').readFileSync('firestore.indexes.json','utf8')); console.log('ok')"
export PATH="/c/Users/LeoArkos/.jre/jdk-21.0.12.1+1-jre/bin:$PATH"; export FUNCTIONS_DISCOVERY_TIMEOUT=60
pnpm emu:rules 2>&1 | grep -E "Tests "
pnpm emu:test 2>&1 | grep -E "Tests "
```

Expected: `ok`, `103 passed`, `704 passed`.

- [ ] **Step 4: Commit**

```bash
git add firestore.indexes.json
git commit -m "fix(indexes): keep single-field indexes on tickets.orderId and members.uid; drop the unused gigs composite"
```

---

### Task 4: Ignore local tooling files

**Files:**
- Modify: `.gitignore`.

- [ ] **Step 1: Append the two entries**

```bash
printf '.claude/settings.local.json\n.claude/worktrees/\n' >> .gitignore
git status --short
```

Expected: `.claude/` no longer appears as untracked; only `.gitignore` is modified.

- [ ] **Step 2: Commit**

```bash
git add .gitignore
git commit -m "chore: ignore Claude Code local settings and worktrees"
```

---

### Task 5: CI

**Files:**
- Create: `.github/workflows/ci.yml`, `.github/dependabot.yml`.

**Interfaces:**
- Produces: the `ci` workflow every later branch must keep green; the em-dash step is the repo-wide enforcement the spec promises.

- [ ] **Step 1: Write the workflow**

`.github/workflows/ci.yml`:

```yaml
name: ci

on:
  push:
    branches: [main]
  pull_request:

jobs:
  gates:
    runs-on: ubuntu-latest
    timeout-minutes: 40
    env:
      FUNCTIONS_DISCOVERY_TIMEOUT: "60"
    steps:
      - uses: actions/checkout@v4

      - name: No em dashes (U+2014) anywhere in the repo
        run: |
          if git grep -I -n $'\xe2\x80\x94' -- . ':!pnpm-lock.yaml'; then
            echo "Em dash found. The project rule forbids U+2014 in code, comments, copy, and docs."
            exit 1
          fi

      - uses: actions/setup-node@v4
        with:
          node-version-file: .nvmrc

      - name: Enable pnpm via corepack
        run: corepack enable

      - uses: actions/setup-java@v4
        with:
          distribution: temurin
          java-version: "21"

      - name: Install
        run: pnpm install --frozen-lockfile

      - name: Next typegen
        run: pnpm --filter @gatekeep/web exec next typegen

      - name: Typecheck
        run: pnpm typecheck

      - name: Shared tests
        run: pnpm --filter @gatekeep/shared test

      - name: Firestore and Storage rules tests
        run: pnpm emu:rules

      - name: Functions emulator tests
        run: pnpm emu:test

      - name: Web lint
        run: pnpm --filter @gatekeep/web lint

      - name: Web build
        run: pnpm --filter @gatekeep/web build

      - name: Mobile lint
        run: pnpm --filter @gatekeep/mobile lint
```

`.github/dependabot.yml`:

```yaml
version: 2
updates:
  - package-ecosystem: npm
    directory: /
    schedule: { interval: weekly }
  - package-ecosystem: npm
    directory: /functions
    schedule: { interval: weekly }
  - package-ecosystem: npm
    directory: /apps/web
    schedule: { interval: weekly }
  - package-ecosystem: npm
    directory: /apps/mobile
    schedule: { interval: weekly }
  - package-ecosystem: github-actions
    directory: /
    schedule: { interval: weekly }
```

- [ ] **Step 2: Prove the em-dash step locally the way CI runs it**

```bash
bash -c 'if git grep -I -n $'"'"'\xe2\x80\x94'"'"' -- . ":!pnpm-lock.yaml"; then exit 1; fi; echo clean'
```

Expected: `clean`.

- [ ] **Step 3: Commit and push the branch so the workflow runs once**

```bash
git add .github
git commit -m "ci: run every merge gate and the em-dash check on push and pull request"
git push -u origin worktree-sp10-sweep
```

Expected: the `ci` run on GitHub finishes green (about 25 minutes; the emulator step is the long one). If the emulator step times out on the runner, raise `timeout-minutes` to 60 and re-push; do not skip the step.

---

### Task 6: Merge

- [ ] **Step 1: Final gate on the branch tip** (repeat Task 1 Step 7 verbatim; all counts identical).

- [ ] **Step 2: Merge to main and clean up**

```bash
cd /c/Users/LeoArkos/GateKeepBeta
git merge --no-ff worktree-sp10-sweep -m "Merge sub-project 10 branch A: em-dash sweep, Node 22, index overrides, CI"
git push origin main
git worktree remove .worktrees/sp10-sweep
git branch -d worktree-sp10-sweep
```

- [ ] **Step 3: Tell the SP7 session to rebase**

The SP7 worktree (`.claude/worktrees/sp6-events-ticketing`, branch `worktree-sp6-events-ticketing`) rebases onto the new main before it writes code: `git rebase main` from inside that worktree. Its only commits so far are two spec docs, so the rebase is trivial; note it in `docs/superpowers/HANDOFF.md` under the SP7 line when Branch B lands.
