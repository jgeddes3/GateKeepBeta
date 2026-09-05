import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, FlatList, KeyboardAvoidingView, Platform, View } from "react-native";
import { useFocusEffect, useNavigation, useRouter } from "expo-router";
import { collection, doc, getDoc, limit, onSnapshot, orderBy, query } from "firebase/firestore";
import { getFirebase } from "../lib/firebase";
import { callFn } from "../lib/callable";
import { useAuth } from "../auth/AuthProvider";
import { useProfileRole } from "../payments/useProfileRole";
import {
  MESSAGE_MAX_CHARS, MESSAGE_SEND_LABEL, MESSAGE_COMPOSER_PLACEHOLDER,
  CONVERSATION_BLOCKED_MESSAGE, CONVERSATION_EMPTY_MESSAGE,
  UNBLOCK_LABEL, BLOCK_LABEL, REPORT_LABEL,
  REPORT_REASON_PROMPT, REPORT_REASON_MAX_CHARS, REPORT_REASON_MESSAGE,
  REPORT_SENT_MESSAGE, REPORT_DUPLICATE_MESSAGE,
  type ConversationDoc, type ConversationRefDoc, type MessageDoc, type ProfileDoc,
} from "@gatekeep/shared";
import { Text, Button, TextArea, Sheet, ErrorBanner, Callout, SkeletonCard } from "../ui";
import { useTokens } from "../theme/ThemeProvider";
import { tokens } from "../theme/tokens";
import { formatConversationTime } from "./useConversations";

// RN twin of the web thread (Task 6), reading exactly what spec section 4
// (amended) says the thread reads: conversations/{pairId} BY ID (shared
// truth only, no unread, no blockedBy) and its messages subcollection
// ordered by `at`. The acting profile's own block state comes from ITS
// mirror (profiles/{profileId}/conversations/{conversationId}.blockedByMe),
// the only client-readable surface for a block: the private state doc has
// no rule and is closed to every client, admins included.

type MessageRow = MessageDoc & { id: string };
type ConversationState = ConversationDoc | "loading" | "error" | "notFound";
type MessagesState = MessageRow[] | "loading" | "error";
type OtherProfile = { profileId: string; name: string; handle: string; type: "musician" | "curator" };

function useConversationDoc(conversationId: string): { state: ConversationState; retry: () => void } {
  const [state, setState] = useState<ConversationState>("loading");
  const [token, setToken] = useState(0);
  useEffect(() => {
    let cancelled = false;
    const { db } = getFirebase();
    const unsub = onSnapshot(doc(db, "conversations", conversationId),
      (s) => { if (!cancelled) setState(s.exists() ? (s.data() as ConversationDoc) : "notFound"); },
      () => { if (!cancelled) setState("error"); });
    return () => { cancelled = true; unsub(); };
  }, [conversationId, token]);
  return { state, retry: () => { setState("loading"); setToken((n) => n + 1); } };
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
  return { state, retry: () => { setState("loading"); setToken((n) => n + 1); } };
}

// A missing mirror (should not happen once a conversation exists, but
// tolerated the same n+1-permission-tolerant way the rest of this codebase
// treats an absent doc) reads as "not blocked" rather than hanging on
// "loading" forever.
function useBlockedByMe(profileId: string, conversationId: string): { state: boolean | "error"; retry: () => void } {
  const [state, setState] = useState<boolean | "error">(false);
  const [token, setToken] = useState(0);
  useEffect(() => {
    let cancelled = false;
    const { db } = getFirebase();
    const unsub = onSnapshot(doc(db, `profiles/${profileId}/conversations/${conversationId}`),
      (s) => { if (!cancelled) setState(s.exists() ? Boolean((s.data() as ConversationRefDoc).blockedByMe) : false); },
      () => { if (!cancelled) setState("error"); });
    return () => { cancelled = true; unsub(); };
  }, [profileId, conversationId, token]);
  return { state, retry: () => { setState(false); setToken((n) => n + 1); } };
}

// One-shot lookup of the other side's public profile: its name (the header
// title), handle (the "View profile" link target) and type (which route
// that link pushes). Permission-tolerant like BookingInbox's own row
// lookups: a load failure just leaves the header title generic.
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

function MessageBubble({ item, mine }: { item: MessageRow; mine: boolean }) {
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
        <Text variant="meta" muted style={{ marginTop: 4 }}>{formatConversationTime(item.at)}</Text>
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

  // Hooks run unconditionally, every render (same discipline BookingThread
  // follows); the early returns for loading/error/notFound below happen
  // AFTER all of these are called.
  const conversationQ = useConversationDoc(conversationId);
  const messagesQ = useMessages(conversationId);
  const blockedQ = useBlockedByMe(profileId, conversationId);

  const conversation = conversationQ.state;
  const otherProfileId = (conversation !== "loading" && conversation !== "error" && conversation !== "notFound")
    ? (conversation.musicianProfileId === profileId ? conversation.curatorProfileId : conversation.musicianProfileId)
    : null;
  const otherProfile = useOtherProfile(otherProfileId);

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
  // worth an error banner over.
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

  if (conversation === "loading" || role === "loading") {
    return (
      <View style={{ flex: 1, padding: tokens.space.lg, gap: tokens.space.md }}>
        <SkeletonCard />
        <SkeletonCard />
      </View>
    );
  }
  if (conversation === "error") {
    return (
      <View style={{ flex: 1, padding: tokens.space.lg, gap: tokens.space.md }}>
        <ErrorBanner message="Couldn't load this conversation." />
        <Button title="Retry" onPress={conversationQ.retry} style={{ alignSelf: "flex-start" }} />
      </View>
    );
  }
  if (conversation === "notFound") {
    return (
      <View style={{ flex: 1, padding: tokens.space.lg }}>
        <Text muted>You don&apos;t have access to this conversation, or it doesn&apos;t exist.</Text>
      </View>
    );
  }

  const blockedByMe = blockedQ.state === "error" ? false : blockedQ.state;
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
    if (otherProfile === "loading" || otherProfile === "error") return;
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
    if (!trimmed || !otherProfileId) return;
    setSending(true); setSendError(null);
    try {
      await callFn("sendMessage", { fromProfileId: profileId, toProfileId: otherProfileId, text: trimmed });
      setText("");
    } catch (e) {
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
          <Button title="Retry" onPress={messagesQ.retry} style={{ alignSelf: "flex-start" }} />
        </View>
      ) : (
        <FlatList
          style={{ flex: 1 }}
          inverted
          data={[...messages].reverse()}
          keyExtractor={(m) => m.id}
          contentContainerStyle={{ padding: tokens.space.lg, flexGrow: 1 }}
          renderItem={({ item }) => <MessageBubble item={item} mine={item.senderProfileId === profileId} />}
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
