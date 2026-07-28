import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

// A stored colour may be a bare hex (`2f6f9f`) — seeds, imports and older rows
// don't all carry the `#`. `backgroundColor: "2f6f9f"` is invalid CSS and paints
// nothing, so normalise before using a colour as a style value. Non-hex values
// (CSS names, `var(--x)`, already-`#`) pass through untouched.
export function cssColor(color?: string | null): string | undefined {
  if (!color) return undefined
  const s = color.trim()
  return /^[0-9a-f]{3}([0-9a-f]{3})?$/i.test(s) ? `#${s}` : s
}
