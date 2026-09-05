import { IconWarning } from "./icons";

// A shared inline error row (role="alert", warning-toned): originally
// EventEditor.tsx's own module-private helper, promoted to a ui primitive
// (fix round 1, ruling 2) once ArtistPicker.tsx needed the identical row and
// importing it from EventEditor.tsx would have made the two files a cycle
// (EventEditor renders ArtistPicker, ArtistPicker rendered EventEditor's
// ErrorBox). Any file surfacing a callable rejection verbatim can reach for
// this instead of hand-rolling the same markup.
export function ErrorBox({ message }: { message: string }) {
  return (
    <p role="alert" className="flex items-start gap-2 rounded-gk border border-gk-warning/40 bg-gk-warning/14 px-3.5 py-2.5 font-sora text-sm text-gk-warning">
      <IconWarning size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
      <span>{message}</span>
    </p>
  );
}
