import { DeckScreen } from "../../src/discover/DeckScreen";

// SP7 Task 12: the Discover tab IS the swipe deck (design spec section 3,
// "Discover tab = deck"). This screen used to be sub-project 6's upcoming
// -shows list plus the 9B "Discover shows, coming soon" placeholder; the
// placeholder is what sub-project 7 was always going to replace, and the
// upcoming-shows list moved into DeckScreen's own List view, at the top of
// its Shows tab, so nothing that was here is gone.
export default function Screen() {
  return <DeckScreen />;
}
