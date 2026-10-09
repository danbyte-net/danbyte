import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

// A stored colour may be a bare hex (`2f6f9f`) - seeds, imports and older rows
// don't all carry the `#`. `backgroundColor: "2f6f9f"` is invalid CSS and paints
// nothing, so normalise before using a colour as a style value. Non-hex values
// (CSS names, `var(--x)`, already-`#`) pass through untouched.
export function cssColor(color?: string | null): string | undefined {
  if (!color) return undefined
  const s = color.trim()
  return /^[0-9a-f]{3}([0-9a-f]{3})?$/i.test(s) ? `#${s}` : s
}

// A JSON list or object column as its shape, or empty. Spreadsheet imports
// before 0.17.2 could store "" in such columns (#354); a page reading one
// must not crash on it.
export function asArray<T>(value: readonly T[] | null | undefined): T[] {
  return Array.isArray(value) ? (value as T[]) : []
}

export function asRecord<T extends object>(value: T | null | undefined): T {
  return (
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? value
      : {}
  ) as T
}
