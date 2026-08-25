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
