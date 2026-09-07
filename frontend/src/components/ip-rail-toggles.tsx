import { Checkbox } from "@/components/ui/checkbox"

/** The non-facet toggles of an IP table's rail: free rows, their compact
 * fold, and the DHCP pool ghost rows. Rendered above the facets. */
export function IpRailToggles({
  showAvailable,
  onToggleShowAvailable,
  canShowAvailable,
  compact = false,
  onToggleCompact,
  hasDhcpPool,
  showDhcpPool,
  onToggleShowDhcpPool,
}: {
  showAvailable: boolean
  onToggleShowAvailable: (v: boolean) => void
  canShowAvailable: boolean
  compact?: boolean
  onToggleCompact?: (v: boolean) => void
  hasDhcpPool?: boolean
  showDhcpPool?: boolean
  onToggleShowDhcpPool?: (v: boolean) => void
}) {
  if (!canShowAvailable && !hasDhcpPool) return null
  return (
    <div className="flex flex-col gap-1">
      {canShowAvailable && (
        <label className="-mx-1.5 flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-xs hover:bg-muted/50">
          <Checkbox
            checked={showAvailable}
            onCheckedChange={(v) => onToggleShowAvailable(!!v)}
          />
          <span>Show available</span>
        </label>
      )}
      {canShowAvailable && showAvailable && onToggleCompact && (
        <label className="-mx-1.5 flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-xs hover:bg-muted/50">
          <Checkbox
            checked={compact}
            onCheckedChange={(v) => onToggleCompact(!!v)}
          />
          <span>Compact</span>
        </label>
      )}
      {hasDhcpPool && onToggleShowDhcpPool && (
        <label className="-mx-1.5 flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-xs hover:bg-muted/50">
          <Checkbox
            checked={!!showDhcpPool}
            onCheckedChange={(v) => onToggleShowDhcpPool(!!v)}
          />
          <span>Show DHCP pool</span>
        </label>
      )}
    </div>
  )
}
