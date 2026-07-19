import { memo, useMemo } from "react"

import type { IPAddress } from "@/lib/api"
import { Checkbox } from "@/components/ui/checkbox"

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
      <FacetGroup
        label="Status"
        options={facets.status}
        selected={statusFilter}
        onToggle={onToggleStatus}
      />
      <FacetGroup
        label="Role"
        options={facets.role}
        selected={roleFilter}
        onToggle={onToggleRole}
      />
      <TagFacetGroup
        options={facets.tags}
        selected={tagFilter}
        onToggle={onToggleTag}
      />
    </aside>
  )
}

// Memoised — same rationale as PrefixIpsTable. Parent toggles for
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

function FacetGroup({
  label,
  options,
  selected,
  onToggle,
}: {
  label: string
  options: FacetCount[]
  selected: Set<string>
  onToggle: (v: string) => void
}) {
  if (options.length === 0) return null
  return (
    <div>
      <h3 className="mb-1.5 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
        {label}
      </h3>
      <ul className="space-y-0.5">
        {options.map((opt) => (
          <li key={opt.id}>
            <label className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-xs hover:bg-muted/50">
              <Checkbox
                checked={selected.has(opt.id)}
                onCheckedChange={() => onToggle(opt.id)}
                aria-label={opt.name}
              />
              <span
                className="inline-block h-1.5 w-1.5 rounded-full"
                style={{
                  backgroundColor: opt.color || "var(--muted-foreground)",
                }}
              />
              <span className="flex-1 truncate">{opt.name}</span>
              <span className="ml-auto text-[11px] text-muted-foreground">
                {opt.count}
              </span>
            </label>
          </li>
        ))}
      </ul>
    </div>
  )
}

function TagFacetGroup({
  options,
  selected,
  onToggle,
}: {
  options: TagFacetCount[]
  selected: Set<string>
  onToggle: (slug: string) => void
}) {
  if (options.length === 0) return null
  return (
    <div>
      <h3 className="mb-1.5 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
        Tags
      </h3>
      <ul className="space-y-0.5">
        {options.map((opt) => (
          <li key={opt.slug}>
            <label className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-xs hover:bg-muted/50">
              <Checkbox
                checked={selected.has(opt.slug)}
                onCheckedChange={() => onToggle(opt.slug)}
                aria-label={opt.name}
              />
              {opt.color ? (
                <span
                  className="inline-flex items-center rounded-[5px] px-1.5 py-0.5 text-[11px] font-medium"
                  style={{
                    backgroundColor: opt.color,
                    color: opt.text_color || "#fff",
                  }}
                >
                  {opt.name}
                </span>
              ) : (
                <span className="flex-1">{opt.name}</span>
              )}
              <span className="ml-auto text-[11px] text-muted-foreground">
                {opt.count}
              </span>
            </label>
          </li>
        ))}
      </ul>
    </div>
  )
}
