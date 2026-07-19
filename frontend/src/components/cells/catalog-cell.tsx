import { ColorBadge } from "@/components/cells/color-badge"

// Shared renderer for tenant-managed catalog values (Status, IPRole,
// Tenant, etc) — anything with `{ name, color }`. Ensures every list
// page renders them identically: a colored badge, NEVER a dot+name.

export interface CatalogLike {
  name: string
  color?: string | null
}

export interface CatalogCellProps {
  value: CatalogLike | null | undefined
}

export function CatalogCell({ value }: CatalogCellProps) {
  if (!value) return <span className="text-muted-foreground">—</span>
  return <ColorBadge name={value.name} color={value.color || undefined} />
}
