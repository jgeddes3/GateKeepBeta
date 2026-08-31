// Single source of truth for Storage object paths — clients write staging paths,
// functions write review/public paths, storage.rules mirrors these shapes.
export const stagingAudioPath = (uid: string, profileId: string, trackId: string) =>
  `staging/audio/${uid}/${profileId}/${trackId}`;
// "gallery" is the curator equivalent of avatar/cover: musicians get two
// named single-photo slots (portfolio.avatarPhotoPath/coverPhotoPath),
// curators get one append-only array (curator.photoPaths) — see media.ts's
// processPhoto for how the kind picks its destination. "poster" (SP6) is a
// single-photo slot on an EventDoc (EventDoc.posterPath), processed the
// same way as "gallery": bounded to 1600x1600, no upscaling.
export type PhotoKind = "avatar" | "cover" | "gallery" | "poster";
export const stagingPhotoPath = (uid: string, profileId: string, kind: PhotoKind, nonce: string) =>
  `staging/photos/${uid}/${profileId}/${kind}-${nonce}`;
export const reviewTrackPath = (profileId: string, trackId: string) =>
  `review/tracks/${profileId}/${trackId}.m4a`;
export const publicTrackPath = (profileId: string, trackId: string) =>
  `public/tracks/${profileId}/${trackId}.m4a`;
export const publicPhotoPath = (profileId: string, kind: PhotoKind, nonce: string) =>
  `public/photos/${profileId}/${kind}-${nonce}.jpg`;
