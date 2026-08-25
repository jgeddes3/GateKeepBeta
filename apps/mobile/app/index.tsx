import { Text, View } from "react-native";
import { getFirebase } from "../src/lib/firebase";

export default function Index() {
  const { app } = getFirebase();
  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
      <Text>GateKeep — connected to {app.options.projectId}</Text>
    </View>
  );
}
