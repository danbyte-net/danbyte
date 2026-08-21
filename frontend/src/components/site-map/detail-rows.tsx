import { type ReactNode } from "react"
import { Link } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"

import {
  api,
  type CustomField,
  type Device,
  type Site,
  type SiteMapSite,
} from "@/lib/api"
import { CopyButton } from "@/components/kv-card"
import { TagList } from "@/components/cells/tag-list"
import {
  formatCustomValue,
  useCustomFieldDefs,
} from "@/components/custom-field-display"
import { cn } from "@/lib/utils"

// The map's kv detail rows - the same label/value shape the detail pages'
// KvCards use, at popover/inspector scale, with the shared per-row copy
// button. Both the floating popovers and the right inspector render these, so
// clicking a node shows the object page's facts wherever you look.

export interface DetailRow {
  label: string
  node: ReactNode
  /** When set, a copy-to-clipboard button trails the value. */
  copy?: string
}

// Row catalogs for the inspector's field chooser. Absent choice = all rows.
export const SITE_FIELD_OPTIONS: { key: string; label: string }[] = [
  { key: "region", label: "Region" },
  { key: "address", label: "Address" },
  { key: "time_zone", label: "Time zone" },
  { key: "counts", label: "Counts (prefixes, VLANs, …)" },
  { key: "coordinates", label: "Coordinates" },
  { key: "description", label: "Description" },
  { key: "tags", label: "Tags" },
  { key: "custom_fields", label: "Custom fields" },
]

export const DEVICE_FIELD_OPTIONS: { key: string; label: string }[] = [
  { key: "primary_ip", label: "Primary IP" },
  { key: "dns", label: "DNS name" },
  { key: "oob_ip", label: "OOB IP" },
  { key: "manufacturer", label: "Manufacturer" },
  { key: "platform", label: "Platform" },
  { key: "serial", label: "Serial" },
  { key: "asset_tag", label: "Asset tag" },
  { key: "rack", label: "Rack" },
  { key: "location", label: "Location" },
  { key: "cluster", label: "Cluster" },
  { key: "interfaces", label: "Interface count" },
  { key: "ips", label: "IP count" },
  { key: "coordinates", label: "Coordinates" },
  { key: "tags", label: "Tags" },
  { key: "custom_fields", label: "Custom fields" },
]

function customFieldRows(
  defs: CustomField[] | undefined,
  values: Record<string, unknown> | undefined
): DetailRow[] {
  if (!defs || !values) return []
  const rows: DetailRow[] = []
  for (const def of defs) {
    const v = values[def.key]
    if (v === null || v === undefined || v === "") continue
    rows.push({
      label: def.label ?? def.key,
      node: formatCustomValue(def, v),
      copy:
        typeof v === "string" || typeof v === "number" ? String(v) : undefined,
    })
  }
  return rows
}

export function DetailRowList({ rows }: { rows: DetailRow[] }) {
  if (rows.length === 0) return null
  // KvCard's zebra table at popover/inspector scale: bordered container,
  // alternating muted rows, label left / value right / copy trailing.
  return (
    <div className="overflow-hidden rounded-md border border-border">
      {rows.map((r, i) => (
        <div
          key={`${r.label}:${i}`}
          className={cn(
            "flex items-baseline justify-between gap-3 px-2 py-1.5 text-[12px]",
            i % 2 === 1 && "bg-muted/30"
          )}
        >
          <span className="shrink-0 text-muted-foreground">{r.label}</span>
          <span className="flex min-w-0 items-baseline justify-end gap-1">
            {/* wrap-anywhere: serials, DNS names and CF strings have no
                natural break points and must not push the panel wide. */}
            <span className="min-w-0 text-right wrap-anywhere">{r.node}</span>
            {r.copy ? <CopyButton value={r.copy} /> : null}
          </span>
        </div>
      ))}
    </div>
  )
}

/** The site page's facts, fetched lazily on selection (same query key as the
 * detail route, so the cache is shared both ways). */
export function SiteDetailRows({
  site: s,
  enabledKeys,
}: {
  site: SiteMapSite
  /** Which SITE_FIELD_OPTIONS keys to render; absent = all. */
  enabledKeys?: string[]
}) {
  const detail = useQuery({
    queryKey: ["site", s.id],
    queryFn: () => api<Site>(`/api/sites/${s.id}/`),
    staleTime: 60_000,
  })
  const cfDefs = useCustomFieldDefs("site").data?.results
  const d = detail.data
  const on = (k: string) => !enabledKeys || enabledKeys.includes(k)
  const rows: DetailRow[] = []
  if (d) {
    if (on("region") && d.region)
      rows.push({ label: "Region", node: d.region.name })
    if (on("address") && d.address)
      rows.push({ label: "Address", node: d.address, copy: d.address })
    if (on("time_zone") && d.time_zone)
      rows.push({ label: "Time zone", node: d.time_zone })
    if (on("counts")) {
      const counts: [string, number][] = [
        ["Prefixes", d.prefix_count],
        ["VLANs", d.vlan_count],
        ["VMs", d.vm_count],
        ["Racks", d.rack_count],
        ["Circuits", d.circuit_count],
        ["Contacts", d.contact_count],
      ]
      for (const [label, n] of counts)
        if (n > 0) rows.push({ label, node: <span className="num">{n}</span> })
    }
  }
  if (on("coordinates") && s.latitude !== null && s.longitude !== null)
    rows.push({
      label: "Coordinates",
      node: (
        <span className="font-mono">
          {s.latitude.toFixed(5)}, {s.longitude.toFixed(5)}
        </span>
      ),
      copy: `${s.latitude.toFixed(6)}, ${s.longitude.toFixed(6)}`,
    })
  if (on("custom_fields"))
    rows.push(...customFieldRows(cfDefs, d?.custom_fields))
  return (
    <>
      {detail.isLoading && (
        <p className="text-[12px] text-muted-foreground">Loading…</p>
      )}
      <DetailRowList rows={rows} />
      {on("description") && d?.description && (
        <p className="text-[12px] wrap-anywhere text-muted-foreground">
          {d.description}
        </p>
      )}
      {on("tags") && d && d.tags.length > 0 && <TagList tags={d.tags} />}
    </>
  )
}

/** The rest of the device's detail-page facts, fetched lazily on selection
 * (same query key as the device page, so the cache is shared). Skips
 * whatever the caller already shows (`shownKeys` = the configured
 * floorplan-popover keys, or an empty list to show everything). */
export function DeviceExtraRows({
  id,
  shownKeys,
  enabledKeys,
  lat,
  lng,
}: {
  id: string
  shownKeys: string[]
  /** Which DEVICE_FIELD_OPTIONS keys to render; absent = all. */
  enabledKeys?: string[]
  lat?: number
  lng?: number
}) {
  const q = useQuery({
    queryKey: ["device", id],
    queryFn: () => api<Device>(`/api/devices/${id}/`),
    staleTime: 60_000,
  })
  const cfDefs = useCustomFieldDefs("device").data?.results
  const d = q.data
  if (q.isLoading)
    return <p className="text-[12px] text-muted-foreground">Loading…</p>
  if (!d) return null
  const has = (k: string) => shownKeys.includes(k)
  const on = (k: string) => !enabledKeys || enabledKeys.includes(k)
  const rows: DetailRow[] = []
  if (on("primary_ip") && !has("linked_primary_ip") && d.primary_ip)
    rows.push({
      label: "Primary IP",
      node: (
        <Link
          to="/ips/$id"
          params={{ id: d.primary_ip.id }}
          className="link font-mono"
        >
          {d.primary_ip.ip_address}
        </Link>
      ),
      copy: d.primary_ip.ip_address,
    })
  if (on("dns") && d.primary_ip?.dns_name)
    rows.push({
      label: "DNS",
      node: <span className="font-mono">{d.primary_ip.dns_name}</span>,
      copy: d.primary_ip.dns_name,
    })
  if (on("oob_ip") && d.oob_ip)
    rows.push({
      label: "OOB IP",
      node: <span className="font-mono">{d.oob_ip.ip_address}</span>,
      copy: d.oob_ip.ip_address,
    })
  if (on("manufacturer") && d.device_type?.manufacturer)
    rows.push({ label: "Manufacturer", node: d.device_type.manufacturer })
  if (on("platform") && d.effective_platform)
    rows.push({ label: "Platform", node: d.effective_platform.name })
  if (on("serial") && !has("linked_serial") && d.serial_number)
    rows.push({
      label: "Serial",
      node: <span className="font-mono">{d.serial_number}</span>,
      copy: d.serial_number,
    })
  if (on("asset_tag") && !has("linked_asset_tag") && d.asset_tag)
    rows.push({
      label: "Asset tag",
      node: <span className="font-mono">{d.asset_tag}</span>,
      copy: d.asset_tag,
    })
  if (on("rack") && d.rack)
    rows.push({
      label: "Rack",
      node: (
        <Link to="/racks/$id" params={{ id: d.rack.id }} className="link">
          {d.rack.name}
          {d.position != null && <span className="num"> · U{d.position}</span>}
        </Link>
      ),
    })
  if (on("location") && d.location)
    rows.push({
      label: "Location",
      node: (
        <Link
          to="/locations/$id"
          params={{ id: d.location.id }}
          className="link"
        >
          {d.location.name}
        </Link>
      ),
    })
  if (on("cluster") && d.cluster)
    rows.push({
      label: "Cluster",
      node: (
        <Link to="/clusters/$id" params={{ id: d.cluster.id }} className="link">
          {d.cluster.name}
        </Link>
      ),
    })
  if (on("interfaces") && d.interface_count > 0)
    rows.push({
      label: "Interfaces",
      node: <span className="num">{d.interface_count}</span>,
    })
  if (on("ips") && d.ip_count > 0)
    rows.push({ label: "IPs", node: <span className="num">{d.ip_count}</span> })
  if (on("coordinates") && lat != null && lng != null)
    rows.push({
      label: "Coordinates",
      node: (
        <span className="font-mono">
          {lat.toFixed(5)}, {lng.toFixed(5)}
        </span>
      ),
      copy: `${lat.toFixed(6)}, ${lng.toFixed(6)}`,
    })
  if (on("tags") && !has("tags") && !has("linked_tags") && d.tags.length > 0)
    rows.push({ label: "Tags", node: <TagList tags={d.tags} /> })
  if (on("custom_fields"))
    rows.push(...customFieldRows(cfDefs, d.custom_fields))
  return <DetailRowList rows={rows} />
}
