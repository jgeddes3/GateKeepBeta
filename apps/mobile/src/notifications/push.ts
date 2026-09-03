import * as Notifications from "expo-notifications";
import * as Device from "expo-device";
import Constants from "expo-constants";
import { doc, setDoc, deleteDoc } from "firebase/firestore";
import { getFirebase } from "../lib/firebase";

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
