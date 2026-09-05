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

type MessageRow = MessageDoc & { id: string };
type MessagesState = MessageRow[] | "loading" | "error";
type OtherProfile = { profileId: string; name: string; handle: string; type: "musician" | "curator" };

function parsePairId(conversationId: string): { musicianProfileId: string; curatorProfileId: string } | null {
  const parts = conversationId.split("__");
  if (parts.length !== 2) return null;
  const [musicianProfileId, curatorProfileId] = parts;
  if (!isValidDocId(musicianProfileId) || !isValidDocId(curatorProfileId)) return null;
  if (conversationPairId(musicianProfileId, curatorProfileId) !== conversationId) return null;
  return { musicianProfileId, curatorProfileId };
}

function useMessages(conversationId: string): { state: MessagesState; retry: () => void } {
  const [state, setState] = useState<MessagesState>("loading");
  const [token, setToken] = useState(0);
  useEffect(() => {
    let cancelled = false;
    const { db } = getFirebase();
    const unsub = onSnapshot(
      query(collection(db, `conversations/${conversationId}/messages`), orderBy("at", "asc"), limit(200)),
      (snap) => { if (!cancelled) setState(snap.docs.map((d) => ({ id: d.id, ...(d.data() as MessageDoc) }))); },
      () => { if (!cancelled) setState("error"); });
    return () => { cancelled = true; unsub(); };
  }, [conversationId, token]);
  // A plain event-handler setState, not inside the effect body (no
  // react-hooks/set-state-in-effect exception needed): it only fires from a
  // user's Retry press.
  return { state, retry: () => { setState("loading"); setToken((n) => n + 1); } };
}

// This profile's own mirror, live: the ONLY place `blockedByMe` is visible
// to a client at all. A missing mirror (should not happen once a
// conversation exists) or a failed subscription both read as "not blocked"
// rather than hanging forever, matching web's own useMirror fallback.
function useBlockedByMe(profileId: string, conversationId: string): boolean | "loading" | "error" {
  const [state, setState] = useState<boolean | "loading" | "error">("loading");
  useEffect(() => {
    let cancelled = false;
    const { db } = getFirebase();
    const unsub = onSnapshot(doc(db, `profiles/${profileId}/conversations/${conversationId}`),
      (s) => { if (!cancelled) setState(s.exists() ? Boolean((s.data() as ConversationRefDoc).blockedByMe) : false); },
      () => { if (!cancelled) setState("error"); });
    return () => { cancelled = true; unsub(); };
  }, [profileId, conversationId]);
  return state;
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
  const invalid = !pair || (pair.musicianProfileId !== profileId && pair.curatorProfileId !== profileId);
  const otherProfileId = pair && !invalid
    ? (pair.musicianProfileId === profileId ? pair.curatorProfileId : pair.musicianProfileId)
    : null;

  // Hooks run unconditionally, every render (same discipline BookingThread
  // follows); the early returns below happen AFTER all of these are called.
  const otherProfile = useOtherProfile(otherProfileId);
  const messagesQ = useMessages(conversationId);
  const blockedState = useBlockedByMe(profileId, conversationId);

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
  // worth an error banner.
  const isFocusedRef = useRef(true);
  const markedCountRef = useRef(0);
  const markRead = useCallback(() => {
    if (messagesQ.state === "loading" || messagesQ.state === "error") return;
    markedCountRef.current = messagesQ.state.length;
    void callFn("markConversationRead", { profileId, conversationId }).catch(() => {});
  }, [messagesQ.state, profileId, conversationId]);

  useFocusEffect(useCallback(() => {
    isFocusedRef.current = true;
    markRead();
    return () => { isFocusedRef.current = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- markRead is refreshed every render via useCallback above; only the focus transition itself should re-run this
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
  if (otherProfile === "loading" || blockedState === "loading") {
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

  const blockedByMe = blockedState === "error" ? false : blockedState;
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
      {messages === "loading" ? (
        <View style={{ flex: 1, padding: tokens.space.lg, gap: tokens.space.md }}>
          <SkeletonCard />
          <SkeletonCard />
        </View>
      ) : messages === "error" ? (
        <View style={{ flex: 1, padding: tokens.space.lg, gap: tokens.space.md }}>
          <ErrorBanner message="Couldn't load these messages." />
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
