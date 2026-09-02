import { memo, useMemo } from "react"

import type { IPAddress } from "@/lib/api"
import { Checkbox } from "@/components/ui/checkbox"
import { FacetGroup } from "@/components/filter-rail"

type FacetOption = Parameters<typeof FacetGroup>[0]["options"][number]

interface FacetCount {
  id: string
  name: string
  color?: string
  text_color?: string
  count: number
}

interface TagFacetCount {
  slug: string
  name: string
  color?: string
  text_color?: string
  count: number
}

const asOption = (f: FacetCount): FacetOption => ({
  value: f.id,
  label: f.name,
  count: f.count,
  color: f.color,
  textColor: f.text_color,
})

export interface IpFilterRailProps {
  rows: IPAddress[]
  statusFilter: Set<string>
  roleFilter: Set<string>
  tagFilter: Set<string>
  onToggleStatus: (id: string) => void
  onToggleRole: (id: string) => void
  onToggleTag: (slug: string) => void
  showAvailable: boolean
  onToggleShowAvailable: (v: boolean) => void
  canShowAvailable: boolean
  /** Fold the free rows into one ("first free · N more"). */
  compact?: boolean
  onToggleCompact?: (v: boolean) => void
  /** Prefix has DHCP scope pools - offers the "Show DHCP pool" toggle. */
  hasDhcpPool?: boolean
  showDhcpPool?: boolean
  onToggleShowDhcpPool?: (v: boolean) => void
}

function IpFilterRailImpl({
  rows,
  statusFilter,
  roleFilter,
  tagFilter,
  onToggleStatus,
  onToggleRole,
  onToggleTag,
  showAvailable,
  onToggleShowAvailable,
  canShowAvailable,
  compact = false,
  onToggleCompact,
  hasDhcpPool,
  showDhcpPool,
  onToggleShowDhcpPool,
}: IpFilterRailProps) {
  const facets = useMemo(() => buildFacets(rows), [rows])
  return (
    <aside className="hidden h-full w-64 shrink-0 flex-col gap-4 overflow-y-auto border-r border-border bg-background p-4 xl:flex">
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
        <label className="-mx-1.5 -mt-3 flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-xs hover:bg-muted/50">
          <Checkbox
            checked={compact}
            onCheckedChange={(v) => onToggleCompact(!!v)}
          />
          <span>Compact</span>
        </label>
      )}
      {hasDhcpPool && onToggleShowDhcpPool && (
        <label
          className="-mx-1.5 -mt-3 flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-xs hover:bg-muted/50"
          title="Lay out the DHCP scope pool's addresses even before any are registered"
        >
          <Checkbox
            checked={!!showDhcpPool}
            onCheckedChange={(v) => onToggleShowDhcpPool(!!v)}
          />
          <span>Show DHCP pool</span>
        </label>
      )}
      <FacetGroup
        label="Status"
        options={facets.status.map(asOption)}
        selected={statusFilter}
        onToggle={onToggleStatus}
      />
      <FacetGroup
        label="Role"
        options={facets.role.map(asOption)}
        selected={roleFilter}
        onToggle={onToggleRole}
      />
      <FacetGroup
        label="Tags"
        options={facets.tags.map((t) => ({
          value: t.slug,
          label: t.name,
          count: t.count,
          color: t.color,
          textColor: t.text_color,
        }))}
        selected={tagFilter}
        onToggle={onToggleTag}
      />
    </aside>
  )
}

// Memoised - same rationale as PrefixIpsTable. Parent toggles for
// dialog state shouldn't recompute facets or re-render the rail.
export const IpFilterRail = memo(IpFilterRailImpl)

function buildFacets(rows: IPAddress[]) {
  const statusMap = new Map<string, FacetCount>()
  const roleMap = new Map<string, FacetCount>()
  const tagMap = new Map<string, TagFacetCount>()
  for (const ip of rows) {
    if (ip.status) {
      const cur = statusMap.get(ip.status.id)
      if (cur) cur.count++
      else
        statusMap.set(ip.status.id, {
          id: ip.status.id,
          name: ip.status.name,
          color: ip.status.color,
          text_color: ip.status.text_color,
          count: 1,
        })
    }
    if (ip.role) {
      const cur = roleMap.get(ip.role.id)
      if (cur) cur.count++
      else
        roleMap.set(ip.role.id, {
          id: ip.role.id,
          name: ip.role.name,
          color: ip.role.color,
          text_color: ip.role.text_color,
          count: 1,
        })
    }
    for (const t of ip.tags) {
      const cur = tagMap.get(t.slug)
      if (cur) cur.count++
      else
        tagMap.set(t.slug, {
          slug: t.slug,
          name: t.name,
          color: t.color,
          text_color: t.text_color,
          count: 1,
        })
    }
  }
  return {
    status: Array.from(statusMap.values()).sort((a, b) =>
      a.name.localeCompare(b.name)
    ),
    role: Array.from(roleMap.values()).sort((a, b) =>
      a.name.localeCompare(b.name)
    ),
    tags: Array.from(tagMap.values()).sort((a, b) => b.count - a.count),
  }
}

