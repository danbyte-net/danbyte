import { Badge } from "@/components/ui/badge"
import { readableText } from "@/lib/color"
import { cn, cssColor } from "@/lib/utils"

// Moved to lib/color.ts; re-exported for existing importers.
export { readableText } from "@/lib/color"

export interface ColorBadgeProps {
  name: string
  color?: string
  /** Optional muted suffix (e.g. RD on a VRF, slug on a tenant). */
  suffix?: React.ReactNode
  className?: string
}

// Single source of truth for "colored badge with a name". Replaces every
// `dot + name` pattern (VRF, Tenant, Role, Status when self-colored).
// When no color is set, falls back to the neutral secondary variant.
export function ColorBadge({
  name,
  color,
  suffix,
  className,
}: ColorBadgeProps) {
  if (!color) {
    return (
      <Badge variant="secondary" className={cn("gap-1.5", className)}>
        {name}
        {suffix && (
          <span className="font-mono text-muted-foreground opacity-80">
            {suffix}
          </span>
        )}
      </Badge>
    )
  }
  const fg = readableText(color)
  return (
    <Badge
      className={cn("gap-1.5", className)}
      style={{ backgroundColor: cssColor(color), color: fg }}
    >
      {name}
      {suffix && <span className="font-mono opacity-80">{suffix}</span>}
    </Badge>
  )
}
