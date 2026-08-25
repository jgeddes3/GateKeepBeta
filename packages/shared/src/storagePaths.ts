// Single source of truth for Storage object paths — clients write staging paths,
// functions write review/public paths, storage.rules mirrors these shapes.
export const stagingAudioPath = (uid: string, profileId: string, trackId: string) =>
  `staging/audio/${uid}/${profileId}/${trackId}`;
export const stagingPhotoPath = (uid: string, profileId: string, kind: "avatar" | "cover", nonce: string) =>
  `staging/photos/${uid}/${profileId}/${kind}-${nonce}`;
export const reviewTrackPath = (profileId: string, trackId: string) =>
  `review/tracks/${profileId}/${trackId}.m4a`;
export const publicTrackPath = (profileId: string, trackId: string) =>
  `public/tracks/${profileId}/${trackId}.m4a`;
export const publicPhotoPath = (profileId: string, kind: "avatar" | "cover", nonce: string) =>
  `public/photos/${profileId}/${kind}-${nonce}.jpg`;
