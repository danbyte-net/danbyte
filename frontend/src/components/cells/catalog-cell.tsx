import { Link } from "@tanstack/react-router"
import type { LinkProps } from "@tanstack/react-router"
import { ColorBadge } from "@/components/cells/color-badge"

// Shared renderer for tenant-managed catalog values (Status, IPRole,
// Tenant, etc) - anything with `{ name, color }`. Ensures every list
// page renders them identically: a colored badge, NEVER a dot+name.

export interface CatalogLike {
  name: string
  color?: string | null
}

export interface CatalogCellProps {
  value: CatalogLike | null | undefined
  /** Wrap the badge in a link to the catalog object's page. */
  to?: LinkProps["to"]
  params?: Record<string, string>
}

export function CatalogCell({ value, to, params }: CatalogCellProps) {
  if (!value) return <span className="text-muted-foreground">-</span>
  const badge = (
    <ColorBadge name={value.name} color={value.color || undefined} />
  )
  if (!to) return badge
  return (
    <Link to={to} params={params} className="link">
      {badge}
    </Link>
  )
}
