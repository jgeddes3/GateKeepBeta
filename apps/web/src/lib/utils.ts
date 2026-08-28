import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

// Merges conditional class lists and resolves conflicting Tailwind
// utilities (e.g. "px-2" vs "px-4") in favor of the last one given. Used
// by every component in src/ui so variant classes can be overridden by a
// caller-supplied className without fighting specificity.
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
