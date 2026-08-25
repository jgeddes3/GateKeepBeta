import { initializeApp } from "firebase-admin/app";
initializeApp();

export { onUserCreated } from "./authTriggers.js";
export { createProfileDraft, submitProfileForReview } from "./profiles.js";
