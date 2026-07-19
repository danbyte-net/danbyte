import { DynamicIcon } from "@/components/dynamic-icon"
import { cn } from "@/lib/utils"

const FALLBACK = "#a1a1aa"

/**
 * The floor-plan badge for a tile type / device role — a tinted rounded square
 * carrying the type's icon in its own colour.
 *
 * The single source of truth for this treatment: the palette rail, the objects
 * sidebar and the popover settings all render it, so a type looks identical
 * everywhere it appears. (Device roles carry no icon, so they fall back to a
 * colour chip inside the same tint — exactly as the palette has always drawn
 * them.) Use this rather than a bare colour dot: a dot beside a name is what the
 * design rules call out, and it loses the icon that makes types scannable.
 */
export function TileBadge({
  color,
  icon,
  className,
}: {
  color?: string | null
  icon?: string | null
  className?: string
}) {
  const c = color || FALLBACK
  return (
    <span
      className={cn(
        "inline-flex h-5 w-5 shrink-0 items-center justify-center rounded",
        className
      )}
      style={{ backgroundColor: `${c}33`, color: c }}
    >
      {icon ? (
        <DynamicIcon name={icon} className="h-3 w-3" />
      ) : (
        <span
          className="h-2.5 w-2.5 rounded-sm"
          style={{ backgroundColor: c }}
        />
      )}
    </span>
  )
}
