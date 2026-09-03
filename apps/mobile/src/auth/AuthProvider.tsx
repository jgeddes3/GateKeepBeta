import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { onAuthStateChanged, signOut, type User } from "firebase/auth";
import { getFirebase } from "../lib/firebase";
import { unregisterPush } from "../notifications/push";

type AuthState = { user: User | null; loading: boolean; signOutUser: () => Promise<void> };
const AuthContext = createContext<AuthState>({ user: null, loading: true, signOutUser: async () => {} });

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const { auth } = getFirebase();
    return onAuthStateChanged(auth, (u) => { setUser(u); setLoading(false); });
  }, []);
  const signOutUser = async () => {
    const { auth } = getFirebase();
    const uid = auth.currentUser?.uid;
    if (uid) await unregisterPush(uid); // must run while the token is still valid for the rules' isOwner check
    await signOut(auth);
  };
  return <AuthContext.Provider value={{ user, loading, signOutUser }}>{children}</AuthContext.Provider>;
}

export const useAuth = () => useContext(AuthContext);
