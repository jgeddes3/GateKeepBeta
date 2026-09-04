import * as Notifications from "expo-notifications";
import * as Device from "expo-device";
import Constants from "expo-constants";
import { Platform } from "react-native";
import type { Href } from "expo-router";
import { doc, setDoc, deleteDoc } from "firebase/firestore";
import { notificationHref, type NotificationKind } from "@gatekeep/shared";
import { getFirebase } from "../lib/firebase";

// Foreground presentation (sp1 audit finding 8): without a handler,
// expo-notifications shows nothing while the app is open. Registered at
// module scope, per the expo-notifications docs, so it exists before any
// push can arrive; ProfileContext imports this module on every launch.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true, shouldShowList: true, shouldPlaySound: false, shouldSetBadge: false,
  }),
});

// Android displays nothing without a channel (iOS ignores this call).
export async function ensureAndroidChannel(): Promise<void> {
  if (Platform.OS !== "android") return;
  await Notifications.setNotificationChannelAsync("default", {
    name: "GateKeep", importance: Notifications.AndroidImportance.DEFAULT,
  });
}

// The route a tapped push opens: the same map the in-app inbox rows use, read
// off the data: { kind, refId } payload notifyUser attaches (section B3).
// Null for a kind with no destination or a legacy push without data, in
// which case the tap just foregrounds the app, exactly as before.
export function pushHref(response: Notifications.NotificationResponse | null | undefined): Href | null {
  const data = response?.notification.request.content.data as { kind?: unknown; refId?: unknown } | undefined;
  if (!data || typeof data.kind !== "string") return null;
  const refId = typeof data.refId === "string" ? data.refId : null;
  return notificationHref(data.kind as NotificationKind, refId, "mobile") as Href | null;
}

// The token registered by this app session, so sign-out can delete exactly
// the doc it wrote without asking Expo for the token again (which can prompt).
let registeredToken: string | null = null;

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
  registeredToken = token;
}

// SP10 Task 15 (sp1 #6, cross #10): the Expo token identifies the device,
// not the person. Deleting the doc before signOut keeps the next account on
// this phone from receiving the previous one's pushes. Best-effort: a
// failed delete must never block signing out; notifyUser's
// DeviceNotRegistered pruning is the server-side backstop.
export async function unregisterPush(uid: string): Promise<void> {
  const token = registeredToken;
  if (!token) return;
  registeredToken = null;
  try {
    await deleteDoc(doc(getFirebase().db, `users/${uid}/pushTokens/${token}`));
  } catch (e) {
    console.warn("push token cleanup failed", e);
  }
}
