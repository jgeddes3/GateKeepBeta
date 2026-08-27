import { initializeApp } from "firebase-admin/app";
initializeApp();

export { onUserCreated, onUserDocWritten } from "./authTriggers.js";
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
