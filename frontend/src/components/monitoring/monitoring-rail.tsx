import { useQuery } from "@tanstack/react-query"

import { api } from "@/lib/api"
import type {
  CheckStatus,
  FacetBucket,
  Paginated,
  RegionOption,
  TagOption,
  TransitionFacet,
  VRFOption,
} from "@/lib/api"
import { Combobox } from "@/components/ui/combobox"
import { Input } from "@/components/ui/input"
import { FacetGroup, FilterRail } from "@/components/filter-rail"
import type { FacetOption } from "@/components/filter-rail"
import { DevicePicker } from "@/components/device-picker"
import { PrefixPicker } from "@/components/prefix-picker"
import { VlanPicker } from "@/components/vlan-picker"
import { statusColor, statusLabel, useStatusLabels } from "./status-palette"
import { STATUS_LABEL } from "./charts"

/** The filter keys the rail owns - one URL param each, comma-separated lists
 * for the counted facets. `page` is reset by every change. */
export interface RailFilters {
  to_status?: string
  from_status?: string
  status?: string
  kind?: string
  source?: string
  site?: string
  device_type?: string
  role?: string
  platform?: string
  template?: string
  engine?: string
  region?: string
  device?: string
  prefix?: string
  vrf?: string
  vlan?: string
  tag?: string
  port?: string
}

export type RailPatch = Partial<
  Record<keyof RailFilters | "page", string | undefined>
>

const csv = (v: string | undefined) =>
  new Set((v ?? "").split(",").filter(Boolean))

function toggled(
  current: string | undefined,
  value: string
): string | undefined {
  const s = csv(current)
  if (s.has(value)) s.delete(value)
  else s.add(value)
  return s.size ? [...s].join(",") : undefined
}

const SOURCE_LABEL: Record<string, string> = {
  local: "Local",
  outpost: "Outpost",
}

/**
 * One rail for every monitoring list: the history, the checks and, later,
 * the flapping view. Counted facets come from the server with every filter
 * but their own applied, so ticking a second value never zeroes its
 * neighbours; the pickers below narrow by an object the rail cannot count
 * cheaply. Status facets are the tenant's pills, never a dot.
 *
 * `facets` is whatever the list's response carried; a dimension the list does
 * not count is simply not shown. `statusKey` is which status the "Status"
 * group writes - the history filters on the state a change went *to*, the
 * checks list on the state a check is *in*.
 */
export function MonitoringRail({
  facets,
  filters,
  onChange,
  statusKey = "to_status",
  showFrom = false,
}: {
  facets: Partial<Record<TransitionFacet | "status", FacetBucket[]>>
  filters: RailFilters
  onChange: (patch: RailPatch) => void
  statusKey?: "to_status" | "status"
  showFrom?: boolean
}) {
  const labels = useStatusLabels()
  const patch = (key: keyof RailFilters, value: string | undefined) =>
    onChange({ [key]: value, page: undefined })
  const toggle = (key: keyof RailFilters) => (v: string) =>
    patch(key, toggled(filters[key], v))

  const statusOptions = (buckets: FacetBucket[] | undefined): FacetOption[] =>
    (buckets ?? [])
      .filter((b) => b.value in STATUS_LABEL)
      .map((b) => ({
        value: b.value,
        label: statusLabel(b.value as CheckStatus, labels),
        color: statusColor(b.value as CheckStatus, labels),
        count: b.count,
      }))
  const plain = (
    buckets: FacetBucket[] | undefined,
    label?: (b: FacetBucket) => string
  ): FacetOption[] =>
    (buckets ?? []).map((b) => ({
      value: b.value,
      label: label ? label(b) : b.label,
      count: b.count,
    }))

  const regions = useQuery({
    queryKey: ["regions-picker"],
    queryFn: () => api<Paginated<RegionOption>>("/api/regions/?picker=1"),
    staleTime: 10 * 60_000,
  })
  const vrfs = useQuery({
    queryKey: ["vrfs-picker"],
    queryFn: () => api<Paginated<VRFOption>>("/api/vrfs/?picker=1"),
    staleTime: 10 * 60_000,
  })
  const tags = useQuery({
    queryKey: ["tags-all"],
    queryFn: () => api<Paginated<TagOption>>("/api/tags/?page_size=500"),
    staleTime: 10 * 60_000,
  })

  return (
    <FilterRail>
      <FacetGroup
        label="Status"
        options={statusOptions(facets[statusKey])}
        selected={csv(filters[statusKey])}
        onToggle={toggle(statusKey)}
      />
      {showFrom && (
        <FacetGroup
          label="From"
          options={statusOptions(facets.from_status)}
          selected={csv(filters.from_status)}
          onToggle={toggle("from_status")}
        />
      )}
      <FacetGroup
        label="Source"
        options={plain(
          facets.source,
          (b) =>
            SOURCE_LABEL[b.value] ??
            b.value.charAt(0).toUpperCase() + b.value.slice(1)
        )}
        selected={csv(filters.source)}
        onToggle={toggle("source")}
      />
      <FacetGroup
        label="Type"
        options={plain(facets.kind, (b) => b.value.toUpperCase())}
        selected={csv(filters.kind)}
        onToggle={toggle("kind")}
      />
      <FacetGroup
        label="Site"
        options={plain(facets.site)}
        selected={csv(filters.site)}
        onToggle={toggle("site")}
      />
      <FacetGroup
        label="Device type"
        options={plain(facets.device_type)}
        selected={csv(filters.device_type)}
        onToggle={toggle("device_type")}
      />
      <FacetGroup
        label="Role"
        options={plain(facets.role)}
        selected={csv(filters.role)}
        onToggle={toggle("role")}
      />
      <FacetGroup
        label="Platform"
        options={plain(facets.platform)}
        selected={csv(filters.platform)}
        onToggle={toggle("platform")}
      />
      <FacetGroup
        label="Check"
        options={plain(facets.template)}
        selected={csv(filters.template)}
        onToggle={toggle("template")}
      />
      <FacetGroup
        label="Engine"
        options={plain(facets.engine)}
        selected={csv(filters.engine)}
        onToggle={toggle("engine")}
      />

      <div className="space-y-3 border-t border-border pt-3">
        <RailPick label="Region">
          <Combobox
            value={filters.region ?? null}
            onChange={(v) => patch("region", v ?? undefined)}
            options={(regions.data?.results ?? []).map((r) => ({
              value: r.id,
              label: r.name,
            }))}
            noneLabel="Any region"
            placeholder="Any region"
            className="h-8 text-xs"
          />
        </RailPick>
        <DevicePicker
          value={filters.device ?? null}
          onChange={(v) => patch("device", v ?? undefined)}
          noneLabel="Any device"
          placeholder="Any device"
        />
        <PrefixPicker
          value={filters.prefix ?? null}
          onChange={(v) => patch("prefix", v ?? undefined)}
          noneLabel="Any prefix"
          placeholder="Any prefix"
        />
        <RailPick label="VRF">
          <Combobox
            value={filters.vrf ?? null}
            onChange={(v) => patch("vrf", v ?? undefined)}
            options={(vrfs.data?.results ?? []).map((r) => ({
              value: r.id,
              label: r.name,
              color: r.color,
            }))}
            noneLabel="Any VRF"
            placeholder="Any VRF"
            className="h-8 text-xs"
          />
        </RailPick>
        <VlanPicker
          value={filters.vlan ?? null}
          onChange={(v) => patch("vlan", v ?? undefined)}
          noneLabel="Any VLAN"
          placeholder="Any VLAN"
        />
        <RailPick label="Tag">
          <Combobox
            value={filters.tag ?? null}
            onChange={(v) => patch("tag", v ?? undefined)}
            options={(tags.data?.results ?? []).map((t) => ({
              value: t.slug,
              label: t.name,
              color: t.color,
            }))}
            noneLabel="Any tag"
            placeholder="Any tag"
            className="h-8 text-xs"
          />
        </RailPick>
        <RailPick label="Port">
          <Input
            type="number"
            min={1}
            max={65535}
            inputMode="numeric"
            className="h-8 text-xs"
            placeholder="Any"
            value={filters.port ?? ""}
            onChange={(e) => patch("port", e.target.value || undefined)}
          />
        </RailPick>
      </div>
    </FilterRail>
  )
}

function RailPick({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div>
      <h3 className="mb-1.5 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
        {label}
      </h3>
      {children}
    </div>
  )
}

/** How many rail filters are set - the saved-views badge. */
export function railActiveCount(f: RailFilters): number {
  return Object.values(f).filter((v) => v !== undefined && v !== "").length
}

export const RAIL_KEYS: (keyof RailFilters)[] = [
  "to_status",
  "from_status",
  "status",
  "kind",
  "source",
  "site",
  "device_type",
  "role",
  "platform",
  "template",
  "engine",
  "region",
  "device",
  "prefix",
  "vrf",
  "vlan",
  "tag",
  "port",
]
