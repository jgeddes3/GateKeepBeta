import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, FlatList, KeyboardAvoidingView, Platform, View } from "react-native";
import { useFocusEffect, useNavigation, useRouter } from "expo-router";
import { collection, doc, getDoc, limit, onSnapshot, orderBy, query } from "firebase/firestore";
import { getFirebase } from "../lib/firebase";
import { callFn } from "../lib/callable";
import { useAuth } from "../auth/AuthProvider";
import { useProfileRole } from "../payments/useProfileRole";
import {
  conversationPairId, isValidDocId,
  MESSAGE_MAX_CHARS, MESSAGE_SEND_LABEL, MESSAGE_COMPOSER_PLACEHOLDER,
  CONVERSATION_BLOCKED_MESSAGE, CONVERSATION_EMPTY_MESSAGE,
  UNBLOCK_LABEL, BLOCK_LABEL, REPORT_LABEL,
  REPORT_REASON_PROMPT, REPORT_REASON_MAX_CHARS, REPORT_REASON_MESSAGE,
  REPORT_SENT_MESSAGE, REPORT_DUPLICATE_MESSAGE,
  type ConversationRefDoc, type MessageDoc, type ProfileDoc,
} from "@gatekeep/shared";
import { Text, Button, TextArea, Sheet, ErrorBanner, Callout, SkeletonCard } from "../ui";
import { useTokens } from "../theme/ThemeProvider";
import { tokens } from "../theme/tokens";

// RN twin of the landed web thread (apps/web/src/messaging/
// ConversationThread.tsx): checked against it directly once it landed
// mid-task, so this follows the same architecture, not just the brief's
// paraphrase of it.
//
// Reads exactly what spec section 4 (amended) says the thread reads: the
// messages subcollection under conversations/{pairId}, and the acting
// profile's OWN mirror (profiles/{profileId}/conversations/{conversationId})
// for blockedByMe, the only client-readable surface for a block (the
// private state doc has no rule and is closed to every client, admins
// included). Unlike an earlier draft of this file, it does NOT subscribe to
// the shared conversations/{pairId} doc at all: the pairId format itself
// (conversationPairId's own "{musicianProfileId}__{curatorProfileId}"
// shape) already names the other participant, the same client-side parse
// web's own useOtherProfileForConversation uses, so the thread never needs
// an extra listener just to learn who the other side is.
//
// Fix round 2 (whole-branch fix wave): the mirror gates the messages
// subscription too, not just blockedByMe. A pair that has never been
// messaged has no conversations/{pairId} doc, so the messages subcollection
// rule's own get() on that missing parent denies the listen outright. The
// mirror doc is written in the SAME transaction as the first message, so
// "mirror missing" is a reliable, client-readable stand-in for "nothing
// sent yet" that needs no read of the (rules-closed-until-it-exists) parent
// itself. useMirror below returns "loading" | null (confirmed missing, not
// an error) | "error" | the doc, and the messages listener only attaches
// once the mirror is a CONFIRMED real doc; while the mirror is missing this
// renders the empty state with the composer enabled and never attaches the
// messages listener at all, so there is no errored, dead listener to
// survive past the first send.
//
// Fix round 2b (whole-branch fix wave, second pass): two more mirror-gating
// gaps. First, a deep-linked conversationId whose segment decodes to a "/"
// (or is otherwise not doc-id-shaped) used to reach useMirror's doc() call
// unguarded, which throws SYNCHRONOUSLY inside the effect, an RN error
// screen, even though the render below already has an "isn't available"
// path for exactly this case. Both useMirror and useMessages now stay
// disabled for an invalid pair (`pairValid`, the same parsePairId check the
// render's own `invalid` derivation already uses), so `doc()`/`collection()`
// are never called with an unsafe segment. Second, a genuine mirror-read
// failure ("error", not "missing") no longer falls back to attaching the
// messages listener: that fallback just reproduced the exact denied-listen
// bug this fix wave started with, only for a never-messaged pair. Instead
// the render shows its own error banner with a Retry that re-subscribes the
// mirror itself (a reload key, matching web's own retryMirror), and the
// messages listener stays unattached the whole time the mirror is in error.

type MessageRow = MessageDoc & { id: string };
type MessagesState = MessageRow[] | "loading" | "error";
type MirrorState = ConversationRefDoc | null | "loading" | "error";
type OtherProfile = { profileId: string; name: string; handle: string; type: "musician" | "curator" };

// Exported: both Messages tab group screens (app/(musician|curator)/
// messages/[conversationId].tsx) parse the same pair id to resolve the
// acting profile from myProfiles when the `acting` route param is absent
// or invalid, the same doc-id-shaped validation this function already does
// internally, kept in one place rather than duplicated per screen.
export function parsePairId(conversationId: string): { musicianProfileId: string; curatorProfileId: string } | null {
  const parts = conversationId.split("__");
  if (parts.length !== 2) return null;
  const [musicianProfileId, curatorProfileId] = parts;
  if (!isValidDocId(musicianProfileId) || !isValidDocId(curatorProfileId)) return null;
  if (conversationPairId(musicianProfileId, curatorProfileId) !== conversationId) return null;
  return { musicianProfileId, curatorProfileId };
}

// `enabled` gates the subscription itself: false while the mirror is still
// resolving, confirmed missing, in error, or the pair itself is invalid
// (see useMirror/mirrorReady below), so a never-messaged pair's rules-denied
// parent doc never gets a listen attempt at all, no errored/dead listener to
// survive past the first send. Fix round 2b: a genuine mirror-read failure
// no longer falls back to attaching this listener either, that fallback
// used to reproduce the exact same denied-listen error this fix wave
// started with; the render shows the mirror's own error+Retry instead.
// Skipping the subscribe inside the effect body when disabled (not a
// synchronous setState there) follows the same discipline BookingThread's
// own useGig uses for its `if (!gigId) return;` guard.
function useMessages(conversationId: string, enabled: boolean): { state: MessagesState; retry: () => void } {
  const [state, setState] = useState<MessagesState>("loading");
  const [token, setToken] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const { db } = getFirebase();
    const unsub = onSnapshot(
      query(collection(db, `conversations/${conversationId}/messages`), orderBy("at", "asc"), limit(200)),
      (snap) => { if (!cancelled) setState(snap.docs.map((d) => ({ id: d.id, ...(d.data() as MessageDoc) }))); },
      () => { if (!cancelled) setState("error"); });
    return () => { cancelled = true; unsub(); };
  }, [conversationId, token, enabled]);
  // A plain event-handler setState, not inside the effect body (no
  // react-hooks/set-state-in-effect exception needed): it only fires from a
  // user's Retry press.
  return { state, retry: () => { setState("loading"); setToken((n) => n + 1); } };
}

// This profile's own mirror, live: the ONLY place `blockedByMe` is visible
// to a client at all, AND (fix round 2) the sole client-readable signal for
// whether this pair has ever been messaged at all, since the shared
// conversations/{pairId} parent doc is unreadable (and unwritten) until the
// first send. Three states besides the doc itself: "loading" (not yet
// resolved, render the thread's own loading skeleton, don't decide
// anything yet), null (the doc read cleanly and does not exist, a real,
// expected "never messaged" outcome, NOT an error), and "error" (the
// subscription itself failed, kept distinct from null so callers can choose
// to fall back rather than treat a transient failure as "never messaged").
//
// `pairValid` (fix round 2b): the caller passes parsePairId(conversationId)
// !== null, the exact same check the render's own `invalid` derivation
// uses. Skipping the subscribe entirely when false (rather than trying and
// catching) matters because doc() itself throws SYNCHRONOUSLY on a
// malformed segment (a decoded "/" from a deep link, say), before onSnapshot
// ever gets a chance to turn that into a clean "error" state. `state` simply
// stays at its initial "loading" for an invalid pair, which is harmless:
// the render below already returns its "isn't available" path for an
// invalid pair before it ever looks at `mirror`.
//
// `retryMirror` (fix round 2b): re-subscribes via a reload key, matching
// web's own retryMirror/useMirror shape, so a genuine mirror read failure
// (as opposed to a confirmed-missing mirror) is recoverable from the
// render's own Retry button rather than requiring the whole screen to
// remount.
function useMirror(profileId: string, conversationId: string, pairValid: boolean): { mirror: MirrorState; retryMirror: () => void } {
  const [state, setState] = useState<MirrorState>("loading");
  const [reloadKey, setReloadKey] = useState(0);
  useEffect(() => {
    if (!pairValid) return;
    let cancelled = false;
    const { db } = getFirebase();
    const unsub = onSnapshot(doc(db, `profiles/${profileId}/conversations/${conversationId}`),
      (s) => { if (!cancelled) setState(s.exists() ? (s.data() as ConversationRefDoc) : null); },
      () => { if (!cancelled) setState("error"); });
    return () => { cancelled = true; unsub(); };
  }, [profileId, conversationId, pairValid, reloadKey]);
  // A plain event-handler setState, not inside the effect body, same
  // discipline as useMessages' own retry below: it only fires from a user's
  // Retry press.
  return { mirror: state, retryMirror: () => { setState("loading"); setReloadKey((n) => n + 1); } };
}

// One-shot lookup of the other side's public profile: its name (the header
// title and own bubbles' sender label), handle (the "View profile" link
// target) and type (which route that link pushes). Permission-tolerant like
// BookingInbox's own row lookups: a load failure just falls through to the
// screen's "not available" state.
function useOtherProfile(otherProfileId: string | null): OtherProfile | "loading" | "error" {
  const [state, setState] = useState<OtherProfile | "loading" | "error">("loading");
  useEffect(() => {
    if (!otherProfileId) return;
    let cancelled = false;
    getDoc(doc(getFirebase().db, "profiles", otherProfileId))
      .then((s) => {
        if (cancelled) return;
        if (!s.exists()) { setState("error"); return; }
        const d = s.data() as ProfileDoc;
        setState({ profileId: otherProfileId, name: d.name, handle: d.handle, type: d.type as "musician" | "curator" });
      })
      .catch(() => { if (!cancelled) setState("error"); });
    return () => { cancelled = true; };
  }, [otherProfileId]);
  return state;
}

function MessageBubble({ item, mine, label }: { item: MessageRow; mine: boolean; label: string }) {
  const t = useTokens();
  return (
    <View style={{ flexDirection: "row", justifyContent: mine ? "flex-end" : "flex-start", paddingVertical: tokens.space.xs }}>
      <View style={{
        maxWidth: "80%",
        borderWidth: 1,
        borderRadius: tokens.radius.card,
        padding: tokens.space.md,
        // Own side right in a soft accent tint, other side left on the
        // plain surface/border pairing, no ember anywhere else on this
        // screen (DESIGN.md accent dosage, audit item #42).
        backgroundColor: mine ? t.accent + "24" : t.surface,
        borderColor: mine ? t.accent + "80" : t.border,
      }}>
        <Text>{item.text}</Text>
        <Text variant="meta" muted style={{ marginTop: 4 }}>{label} · {new Date(item.at).toLocaleString()}</Text>
      </View>
    </View>
  );
}

export function ConversationThread({ profileId, conversationId }: { profileId: string; conversationId: string }) {
  const t = useTokens();
  const { user } = useAuth();
  const navigation = useNavigation();
  const router = useRouter();
  const role = useProfileRole(profileId, user?.uid);

  // The pair's two profile ids are IN the conversation id itself
  // (conversationPairId's own format), so the other side is a pure, sync
  // derivation, no read needed just to learn who it is.
  const pair = parsePairId(conversationId);
  const pairValid = pair !== null;
  const invalid = !pair || (pair.musicianProfileId !== profileId && pair.curatorProfileId !== profileId);
  const otherProfileId = pair && !invalid
    ? (pair.musicianProfileId === profileId ? pair.curatorProfileId : pair.musicianProfileId)
    : null;

  // Hooks run unconditionally, every render (same discipline BookingThread
  // follows); the early returns below happen AFTER all of these are called.
  const otherProfile = useOtherProfile(otherProfileId);
  const { mirror, retryMirror } = useMirror(profileId, conversationId, pairValid);
  // Confirmed missing (a real "never messaged" outcome, not an error) and
  // "ready" (a real doc, safe to read blockedByMe off of and to attach the
  // messages listener) are each their own boolean so the render below and
  // markRead's guard can check them without repeating the mirror comparison
  // every time. `pairValid` is checked again here too (belt-and-suspenders,
  // matching web): the mirror hook itself already stays stuck at "loading"
  // forever for an invalid pair, so this is never actually the thing that
  // decides it, but it keeps the intent explicit at the call site.
  const mirrorReady = pairValid && mirror !== "loading" && mirror !== "error" && mirror !== null;
  const mirrorMissing = pairValid && mirror === null;
  const messagesQ = useMessages(conversationId, mirrorReady);

  const [myProfileName, setMyProfileName] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    getDoc(doc(getFirebase().db, "profiles", profileId))
      .then((snap) => { if (!cancelled && snap.exists()) setMyProfileName((snap.data() as ProfileDoc).name); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [profileId]);

  const [moreOpen, setMoreOpen] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [reportReason, setReportReason] = useState("");
  const [reportBusy, setReportBusy] = useState(false);
  const [reportError, setReportError] = useState<string | null>(null);
  const [reportResult, setReportResult] = useState<"sent" | "duplicate" | null>(null);
  const [blockBusy, setBlockBusy] = useState(false);
  const [blockError, setBlockError] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  // Header title + the "More" action button. A plain useEffect (an
  // external-system sync, the native navigator's own header), not a
  // render-time reset: it fires once the other profile's name resolves and
  // again whenever it changes.
  useEffect(() => {
    navigation.setOptions({
      ...(otherProfile !== "loading" && otherProfile !== "error" ? { title: otherProfile.name } : {}),
      headerRight: () => (
        <Button variant="ghost" title="More" accessibilityLabel="Conversation actions" onPress={() => setMoreOpen(true)} />
      ),
    });
  }, [navigation, otherProfile]);

  // markConversationRead: once on open, and again whenever the message
  // count grows while this screen is focused (a new message arriving while
  // the thread is on screen is still something the viewer has now seen).
  // Best-effort: a failure here leaves the badge one message stale, not
  // worth an error banner. Never fires while the mirror is missing: there is
  // no conversation to mark read yet, and the callable's own doc reads would
  // just fail the same way the old unconditional messages listener did.
  const isFocusedRef = useRef(true);
  const markedCountRef = useRef(0);
  const markRead = useCallback(() => {
    if (mirrorMissing) return;
    if (messagesQ.state === "loading" || messagesQ.state === "error") return;
    markedCountRef.current = messagesQ.state.length;
    void callFn("markConversationRead", { profileId, conversationId }).catch(() => {});
  }, [mirrorMissing, messagesQ.state, profileId, conversationId]);

  // markReadRef always points at the CURRENT render's markRead (reassigned
  // every render, no deps array): the focus callback below is intentionally
  // stable across renders (deps []), so without this indirection it would
  // close over the very first render's markRead forever, whose guard sees
  // messagesQ.state === "loading" permanently and never actually marks
  // anything read on refocus.
  const markReadRef = useRef(markRead);
  useEffect(() => { markReadRef.current = markRead; });

  useFocusEffect(useCallback(() => {
    isFocusedRef.current = true;
    markReadRef.current();
    return () => { isFocusedRef.current = false; };
  }, []));

  useEffect(() => {
    if (messagesQ.state === "loading" || messagesQ.state === "error") return;
    if (!isFocusedRef.current) return;
    if (messagesQ.state.length === markedCountRef.current) return;
    markRead();
  }, [messagesQ.state, markRead]);

  if (invalid) {
    return (
      <View style={{ flex: 1, padding: tokens.space.lg }}>
        <Text muted>This conversation isn&apos;t available.</Text>
      </View>
    );
  }
  if (otherProfile === "loading" || mirror === "loading") {
    return (
      <View style={{ flex: 1, padding: tokens.space.lg, gap: tokens.space.md }}>
        <SkeletonCard />
        <SkeletonCard />
      </View>
    );
  }
  if (otherProfile === "error") {
    return (
      <View style={{ flex: 1, padding: tokens.space.lg }}>
        <Text muted>This conversation isn&apos;t available.</Text>
      </View>
    );
  }

  // A confirmed-missing or errored mirror both read as "not blocked" (the
  // errored case matches the previous fallback exactly); only a real mirror
  // doc with blockedByMe true renders the blocked state.
  const blockedByMe = mirror !== "error" && mirror ? mirror.blockedByMe : false;
  const isAdmin = role === "admin";

  const doSetBlock = async (blocked: boolean) => {
    setBlockBusy(true); setBlockError(null);
    try {
      await callFn("setConversationBlock", { profileId, conversationId, blocked });
    } catch (e) {
      setBlockError(e instanceof Error ? e.message : "Could not update the block.");
    } finally {
      setBlockBusy(false);
    }
  };
  const confirmBlock = () => {
    const next = !blockedByMe;
    Alert.alert(
      next ? "Block this profile?" : "Unblock this profile?",
      next ? "Neither side can message the other again until you unblock." : undefined,
      [
        { text: "Cancel", style: "cancel" },
        { text: next ? BLOCK_LABEL : UNBLOCK_LABEL, style: next ? "destructive" : "default", onPress: () => void doSetBlock(next) },
      ],
    );
  };

  const openOtherProfile = () => {
    router.push(otherProfile.type === "musician"
      ? { pathname: "/artist/[handle]", params: { handle: otherProfile.handle } }
      : { pathname: "/venue/[handle]", params: { handle: otherProfile.handle } });
  };

  const closeReportSheet = () => {
    if (reportBusy) return;
    setReportOpen(false);
    setReportReason("");
    setReportError(null);
    setReportResult(null);
  };
  const submitReport = async () => {
    const trimmed = reportReason.trim();
    if (trimmed.length < 1 || trimmed.length > REPORT_REASON_MAX_CHARS) {
      setReportError(REPORT_REASON_MESSAGE);
      return;
    }
    setReportBusy(true); setReportError(null);
    try {
      await callFn("reportConversation", { profileId, conversationId, reason: trimmed });
      setReportResult("sent");
    } catch (e) {
      // A duplicate report is a statement of fact, not a failure (the
      // shared constant's own comment): it renders in the same calm,
      // success-toned surface REPORT_SENT_MESSAGE gets, not an ErrorBanner.
      if (e instanceof Error && e.message === REPORT_DUPLICATE_MESSAGE) setReportResult("duplicate");
      else setReportError(e instanceof Error ? e.message : "Could not send this report.");
    } finally {
      setReportBusy(false);
    }
  };

  const send = async () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    setSending(true); setSendError(null);
    try {
      await callFn("sendMessage", { fromProfileId: profileId, toProfileId: otherProfile.profileId, text: trimmed });
      setText("");
    } catch (e) {
      // Both blocked directions land here verbatim off the server
      // (CONVERSATION_CLOSED_MESSAGE), same as every other callable
      // rejection this app surfaces as-is.
      setSendError(e instanceof Error ? e.message : "Could not send this message.");
    } finally {
      setSending(false);
    }
  };

  const messages = messagesQ.state;

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined} keyboardVerticalOffset={0}>
      {mirrorMissing ? (
        // Never messaged: the messages listener was never attached (its
        // rules-closed parent doc does not exist yet), so this renders the
        // same empty copy the FlatList's own ListEmptyComponent uses below,
        // straight off the mirror instead of an errored subscription. The
        // composer underneath stays enabled either way; the first send
        // writes the mirror and the message in one transaction, which flips
        // this branch off and attaches the real listener.
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
          <Text muted>{CONVERSATION_EMPTY_MESSAGE}</Text>
        </View>
      ) : mirror === "error" ? (
        // Fix round 2b: a genuine mirror-read failure, distinct from
        // "never messaged". The messages listener was never attached here
        // either (mirrorReady requires a confirmed real doc), so this gets
        // its OWN error banner and Retry, re-subscribing the mirror itself
        // rather than falling back to a messages listener that would just
        // reproduce the same denied-listen failure for a never-messaged
        // pair, or masking a real mirror outage for an existing one.
        <View style={{ flex: 1, padding: tokens.space.lg, gap: tokens.space.md }}>
          <ErrorBanner message="Couldn't load this conversation." />
          <Button variant="secondary" title="Retry" onPress={retryMirror} style={{ alignSelf: "flex-start" }} />
        </View>
      ) : messages === "loading" ? (
        <View style={{ flex: 1, padding: tokens.space.lg, gap: tokens.space.md }}>
          <SkeletonCard />
          <SkeletonCard />
        </View>
      ) : messages === "error" ? (
        <View style={{ flex: 1, padding: tokens.space.lg, gap: tokens.space.md }}>
          <ErrorBanner message="Couldn't load messages." />
          <Button variant="secondary" title="Retry" onPress={messagesQ.retry} style={{ alignSelf: "flex-start" }} />
        </View>
      ) : (
        <FlatList
          style={{ flex: 1 }}
          inverted
          data={[...messages].reverse()}
          keyExtractor={(m) => m.id}
          contentContainerStyle={{ padding: tokens.space.lg, flexGrow: 1 }}
          renderItem={({ item }) => {
            const mine = item.senderProfileId === profileId;
            // The spec's own bubble contract: the sender's profile name
            // under each bubble, plus the member's display name on the
            // viewer's OWN sends only (other accounts' user docs are not
            // readable, so that's the one case this name is ever known).
            const isViewerSend = mine && item.senderUid === user?.uid;
            const senderProfileName = mine ? (myProfileName ?? "You") : otherProfile.name;
            const label = isViewerSend && user?.displayName ? `${senderProfileName} · ${user.displayName}` : senderProfileName;
            return <MessageBubble item={item} mine={mine} label={label} />;
          }}
          ListEmptyComponent={(
            <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
              <Text muted>{CONVERSATION_EMPTY_MESSAGE}</Text>
            </View>
          )}
        />
      )}

      <View style={{ paddingHorizontal: tokens.space.lg, paddingBottom: tokens.space.lg, gap: tokens.space.sm }}>
        {blockedByMe ? (
          <View style={{ borderTopWidth: 1, borderTopColor: t.border, paddingTop: tokens.space.md, gap: tokens.space.sm }}>
            <Text muted>{CONVERSATION_BLOCKED_MESSAGE}</Text>
            {isAdmin && (
              <Button variant="secondary" title={UNBLOCK_LABEL} loading={blockBusy}
                onPress={() => void doSetBlock(false)} accessibilityLabel={UNBLOCK_LABEL} style={{ alignSelf: "flex-start" }} />
            )}
            {blockError && <ErrorBanner message={blockError} />}
          </View>
        ) : (
          <View style={{ borderTopWidth: 1, borderTopColor: t.border, paddingTop: tokens.space.md, gap: tokens.space.sm }}>
            <TextArea
              value={text}
              onChangeText={(v) => setText(v.slice(0, MESSAGE_MAX_CHARS))}
              maxLength={MESSAGE_MAX_CHARS}
              placeholder={MESSAGE_COMPOSER_PLACEHOLDER}
              accessibilityLabel={MESSAGE_COMPOSER_PLACEHOLDER}
              editable={!sending}
            />
            <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
              <Text variant="meta" muted>{text.length} / {MESSAGE_MAX_CHARS}</Text>
              <Button title={MESSAGE_SEND_LABEL} loading={sending} disabled={text.trim().length === 0}
                onPress={() => void send()} />
            </View>
            {sendError && <ErrorBanner message={sendError} />}
          </View>
        )}
      </View>

      <Sheet visible={moreOpen} onClose={() => setMoreOpen(false)}>
        <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} keyboardVerticalOffset={0}>
          <View style={{ gap: tokens.space.sm }}>
            <Text variant="title">Conversation actions</Text>
            {isAdmin && (
              <Button variant="secondary" title={blockedByMe ? UNBLOCK_LABEL : BLOCK_LABEL} loading={blockBusy}
                accessibilityLabel={blockedByMe ? UNBLOCK_LABEL : BLOCK_LABEL}
                onPress={() => { setMoreOpen(false); confirmBlock(); }} />
            )}
            <Button variant="secondary" title={REPORT_LABEL} accessibilityLabel={REPORT_LABEL}
              onPress={() => { setMoreOpen(false); setReportOpen(true); }} />
            <Button variant="secondary" title="View profile" accessibilityLabel="View profile"
              onPress={() => { setMoreOpen(false); openOtherProfile(); }} />
            {blockError && <ErrorBanner message={blockError} />}
          </View>
        </KeyboardAvoidingView>
      </Sheet>

      <Sheet visible={reportOpen} onClose={closeReportSheet}>
        <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} keyboardVerticalOffset={0}>
          <View style={{ gap: tokens.space.sm }}>
            <Text variant="title">{REPORT_REASON_PROMPT}</Text>
            {reportResult ? (
              <>
                <Callout tone="success">
                  <Text color={t.success}>{reportResult === "sent" ? REPORT_SENT_MESSAGE : REPORT_DUPLICATE_MESSAGE}</Text>
                </Callout>
                <Button variant="secondary" title="Close" onPress={closeReportSheet} style={{ alignSelf: "flex-start" }} />
              </>
            ) : (
              <>
                <TextArea
                  value={reportReason}
                  onChangeText={(v) => setReportReason(v.slice(0, REPORT_REASON_MAX_CHARS))}
                  maxLength={REPORT_REASON_MAX_CHARS}
                  placeholder={REPORT_REASON_PROMPT}
                  accessibilityLabel={REPORT_REASON_PROMPT}
                  editable={!reportBusy}
                />
                <Text variant="meta" muted>{reportReason.length} / {REPORT_REASON_MAX_CHARS}</Text>
                {reportError && <ErrorBanner message={reportError} />}
                <Button title={REPORT_LABEL} loading={reportBusy} disabled={reportReason.trim().length === 0}
                  onPress={() => void submitReport()} />
              </>
            )}
          </View>
        </KeyboardAvoidingView>
      </Sheet>
    </KeyboardAvoidingView>
  );
}
