import { initializeApp } from "firebase-admin/app";
initializeApp();

export { onUserCreated, onUserDeleted, onUserDocWritten } from "./authTriggers.js";
export { createProfileDraft, submitProfileForReview, deleteProfile } from "./profiles.js";
export { reviewProfile, grantAdmin } from "./review.js";
export { inviteMember, respondToInvite, removeMember, transferAdmin, revokeInvite } from "./members.js";
export { deleteAccount } from "./account.js";
export { updatePortfolio, updateBookingInfo } from "./portfolio.js";
export { updateCuratorProfile, removeCuratorPhoto } from "./curator.js";
export { createTrack, updateTrack, deleteTrack, reorderTracks, reviewTrack } from "./tracks.js";
export { processUpload } from "./media.js";
export { createGig, publishGig, updateGig, cancelGig, takedownGig } from "./gigs.js";
export { createSeries, updateSeries, pauseSeries, endSeries } from "./gigSeries.js";
export { dailySweep } from "./scheduled.js";
export { searchUsersByName, backfillDisplayNameLower, flagAccount } from "./adminTools.js";
export { backfillBookingVisibility } from "./bookingVisibility.js";
export { applyToGig, offerGig, counterBooking, declineBooking, withdrawBooking, acceptBooking } from "./bookings.js";
export { cancelBooking, cancelOccurrence, reportNoShow, removeReliabilityMark } from "./bookingLifecycle.js";
export { stripeWebhook } from "./paymentsWebhook.js";
export { paymentsSweep, ticketOrderExpiry } from "./paymentsSweep.js";
export {
  createSetupIntent, refreshPaymentMethod, createOnboardingLink, getStripeStatus, releaseStuckSaga,
  confirmOccurrenceActuals, payPastDue,
} from "./payments.js";
// Also the edge that loads paymentsPayouts.ts's payout.paid/payout.failed
// webhook registrations (see paymentsWebhook.ts's header).
export { requestPayout } from "./paymentsPayouts.js";
export { createEvent, updateEvent, setEventTiers, publishEvent, cancelEvent } from "./events.js";
export { takedownEvent } from "./eventsAdmin.js";
export {
  createTicketOrder, finalizeTicketOrder, cancelTicketOrder, refundTicket, checkInTicket, undoCheckIn,
  offerTransfer, respondToTransfer,
} from "./ticketing.js";
export { followTarget, unfollowTarget, markGenrePickerSeen } from "./follows.js";
export { createShowPost, removeShowPost } from "./showPosts.js";
export { getDiscoverDeck } from "./discover.js";
export {
  onProfileWrittenSearch, onTrackWrittenSearch, onEventWrittenSearch, onGigWrittenSearch, onBookingWrittenSearch,
  backfillSearchIndex,
} from "./searchIndex.js";
export { search } from "./search.js";
export { saveSearch, deleteSavedSearch, onSearchIndexCreated } from "./savedSearches.js";
