import { type ReactNode } from "react"
import { Link } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"

import { api, type Device, type Site, type SiteMapSite } from "@/lib/api"
import { CopyButton } from "@/components/kv-card"
import { TagList } from "@/components/cells/tag-list"
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
            <span className="min-w-0 text-right break-words">{r.node}</span>
            {r.copy ? <CopyButton value={r.copy} /> : null}
          </span>
        </div>
      ))}
    </div>
  )
}

/** The site page's facts, fetched lazily on selection (same query key as the
 * detail route, so the cache is shared both ways). */
export function SiteDetailRows({ site: s }: { site: SiteMapSite }) {
  const detail = useQuery({
    queryKey: ["site", s.id],
    queryFn: () => api<Site>(`/api/sites/${s.id}/`),
    staleTime: 60_000,
  })
  const d = detail.data
  const rows: DetailRow[] = []
  if (d) {
    if (d.region) rows.push({ label: "Region", node: d.region.name })
    if (d.address)
      rows.push({ label: "Address", node: d.address, copy: d.address })
    if (d.time_zone) rows.push({ label: "Time zone", node: d.time_zone })
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
  if (s.latitude !== null && s.longitude !== null)
    rows.push({
      label: "Coordinates",
      node: (
        <span className="font-mono">
          {s.latitude.toFixed(5)}, {s.longitude.toFixed(5)}
        </span>
      ),
      copy: `${s.latitude.toFixed(6)}, ${s.longitude.toFixed(6)}`,
    })
  return (
    <>
      {detail.isLoading && (
        <p className="text-[12px] text-muted-foreground">Loading…</p>
      )}
      <DetailRowList rows={rows} />
      {d?.description && (
        <p className="text-[12px] text-muted-foreground">{d.description}</p>
      )}
      {d && d.tags.length > 0 && <TagList tags={d.tags} />}
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
  lat,
  lng,
}: {
  id: string
  shownKeys: string[]
  lat?: number
  lng?: number
}) {
  const q = useQuery({
    queryKey: ["device", id],
    queryFn: () => api<Device>(`/api/devices/${id}/`),
    staleTime: 60_000,
  })
  const d = q.data
  if (q.isLoading)
    return <p className="text-[12px] text-muted-foreground">Loading…</p>
  if (!d) return null
  const has = (k: string) => shownKeys.includes(k)
  const rows: DetailRow[] = []
  if (!has("linked_primary_ip") && d.primary_ip)
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
  if (d.primary_ip?.dns_name)
    rows.push({
      label: "DNS",
      node: <span className="font-mono">{d.primary_ip.dns_name}</span>,
      copy: d.primary_ip.dns_name,
    })
  if (d.oob_ip)
    rows.push({
      label: "OOB IP",
      node: <span className="font-mono">{d.oob_ip.ip_address}</span>,
      copy: d.oob_ip.ip_address,
    })
  if (d.device_type?.manufacturer)
    rows.push({ label: "Manufacturer", node: d.device_type.manufacturer })
  if (d.effective_platform)
    rows.push({ label: "Platform", node: d.effective_platform.name })
  if (!has("linked_serial") && d.serial_number)
    rows.push({
      label: "Serial",
      node: <span className="font-mono">{d.serial_number}</span>,
      copy: d.serial_number,
    })
  if (!has("linked_asset_tag") && d.asset_tag)
    rows.push({
      label: "Asset tag",
      node: <span className="font-mono">{d.asset_tag}</span>,
      copy: d.asset_tag,
    })
  if (d.rack)
    rows.push({
      label: "Rack",
      node: (
        <Link to="/racks/$id" params={{ id: d.rack.id }} className="link">
          {d.rack.name}
          {d.position != null && <span className="num"> · U{d.position}</span>}
        </Link>
      ),
    })
  if (d.location)
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
  if (d.cluster)
    rows.push({
      label: "Cluster",
      node: (
        <Link to="/clusters/$id" params={{ id: d.cluster.id }} className="link">
          {d.cluster.name}
        </Link>
      ),
    })
  if (d.interface_count > 0)
    rows.push({
      label: "Interfaces",
      node: <span className="num">{d.interface_count}</span>,
    })
  if (d.ip_count > 0)
    rows.push({ label: "IPs", node: <span className="num">{d.ip_count}</span> })
  if (lat != null && lng != null)
    rows.push({
      label: "Coordinates",
      node: (
        <span className="font-mono">
          {lat.toFixed(5)}, {lng.toFixed(5)}
        </span>
      ),
      copy: `${lat.toFixed(6)}, ${lng.toFixed(6)}`,
    })
  if (!has("tags") && !has("linked_tags") && d.tags.length > 0)
    rows.push({ label: "Tags", node: <TagList tags={d.tags} /> })
  return <DetailRowList rows={rows} />
}
