"use client";
import { cn } from "../lib/utils";
import { Input } from "../ui/input";
import { IconSearch } from "../ui/icons";

// The one search-box shape every face uses: a magnifying-glass icon inset
// over a left-padded Input, matching AttendeeList.tsx's own identical
// treatment there. aria-label mirrors the placeholder (the icon itself is
// aria-hidden and gives no accessible name of its own), so this single
// component is also where that convention lives once instead of four times.
export function SearchInputField({ value, onChange, placeholder, className }: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  className?: string;
}) {
  return (
    <div className={cn("relative", className)}>
      <IconSearch size={16} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-gk-muted" aria-hidden="true" />
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
        className="pl-9"
      />
    </div>
  );
}
