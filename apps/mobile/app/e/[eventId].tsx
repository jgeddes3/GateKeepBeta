import { Redirect, useLocalSearchParams } from "expo-router";

// SP11: the web URL shape is /e/{eventId}; the app's own screen lives at
// event/[eventId]. This route exists purely so an incoming universal link
// resolves, and it replaces itself rather than pushing, so Back does not
// return to an empty shim.
export default function EventLink() {
  const { eventId } = useLocalSearchParams<{ eventId: string }>();
  if (!eventId) return <Redirect href="/" />;
  return <Redirect href={{ pathname: "/event/[eventId]", params: { eventId } }} />;
}
