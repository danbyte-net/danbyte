import { expandNameRange } from "@/lib/name-range"

/**
 * Live feedback under a component's Name field: what a `[a-b]` range is about
 * to create. Shown on create only — editing renames one row, it never fans
 * out. Renders nothing when the name has no range, so it can sit
 * unconditionally under any name input.
 */
export function NameRangeHint({
  name,
  editing,
  noun = "components",
}: {
  name: string
  editing?: boolean
  /** Plural noun for the count, e.g. "parts", "interfaces". */
  noun?: string
}) {
  const trimmed = name.trim()
  if (!trimmed || editing) return null
  const names = expandNameRange(trimmed)
  if (names.length < 2) return null
  return (
    <p className="-mt-1 font-mono text-[11px] text-muted-foreground">
      Creates {names.length} {noun}: {names[0]} … {names[names.length - 1]}
    </p>
  )
}
