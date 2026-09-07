import { cssColor } from "@/lib/utils"

/** A catalog object's raw colour as data: a small swatch next to the hex
 * value, so an operator can read or copy what the badge is painted with.
 * Shows a dash when the object has no colour. */
export function ColorValueCell({ color }: { color?: string | null }) {
  const css = cssColor(color)
  if (!css) return <span className="text-muted-foreground">-</span>
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        aria-hidden
        className="h-3.5 w-3.5 shrink-0 rounded-sm border border-border/60"
        style={{ backgroundColor: css }}
      />
      <span className="font-mono text-xs uppercase">{css}</span>
    </span>
  )
}
