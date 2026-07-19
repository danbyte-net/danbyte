import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"

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
      style={{ backgroundColor: color, color: fg }}
    >
      {name}
      {suffix && <span className="font-mono opacity-80">{suffix}</span>}
    </Badge>
  )
}

// Pick black or white text based on perceived luminance (Rec. 709).
export function readableText(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex)
  if (!m) return "#fff"
  const v = parseInt(m[1], 16)
  const r = (v >> 16) & 0xff
  const g = (v >> 8) & 0xff
  const b = v & 0xff
  const L = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
  return L > 0.6 ? "#0a0a0a" : "#fff"
}
