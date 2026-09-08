import { ColorBadge } from "@/components/cells/color-badge"
import type { SearchHit, SearchStatus } from "@/lib/api"

// The order details read best in: where it is, what it is, what it's on.
const ORDER = [
  "site",
  "location",
  "rack",
  "role",
  "type",
  "platform",
  "device",
  "vm",
  "interface",
  "cluster",
  "vrf",
  "vlan",
  "prefix",
  "ip",
  "dns",
  "provider",
  "manufacturer",
  "group",
  "rir",
  "zone",
  "master",
  "size",
  "serial",
  "asset",
  "part",
]

const LABELS: Record<string, string> = {
  site: "Site",
  location: "Location",
  rack: "Rack",
  role: "Role",
  type: "Type",
  platform: "Platform",
  device: "Device",
  vm: "VM",
  interface: "Interface",
  cluster: "Cluster",
  vrf: "VRF",
  vlan: "VLAN",
  prefix: "Prefix",
  ip: "IP",
  dns: "DNS",
  provider: "Provider",
  manufacturer: "Manufacturer",
  group: "Group",
  rir: "RIR",
  zone: "Zone",
  master: "Master",
  size: "Size",
  serial: "Serial",
  asset: "Asset",
  part: "Part",
}

function isStatus(v: unknown): v is SearchStatus {
  return typeof v === "object" && v !== null && "name" in v
}

/** Status pill plus the labelled details of a hit. `max` caps the pairs for
 * the compact palette row; the results page shows them all. */
export function hitStatus(
  hit: Pick<SearchHit, "context">
): SearchStatus | null {
  return isStatus(hit.context.status) ? hit.context.status : null
}

export function hitPairs(
  hit: Pick<SearchHit, "context">,
  max?: number
): (readonly [string, string])[] {
  const ctx = hit.context
  return ORDER.filter((k) => typeof ctx[k] === "string" && ctx[k])
    .slice(0, max)
    .map((k) => [LABELS[k] ?? k, ctx[k] as string] as const)
}

/** The status pill for a hit, sized for a table or palette row. */
export function SearchHitStatus({ hit }: { hit: Pick<SearchHit, "context"> }) {
  const status = hitStatus(hit)
  if (!status) return null
  return (
    <ColorBadge
      name={status.name}
      color={status.color || undefined}
      className="h-4 px-1.5 text-[10px]"
    />
  )
}

/** Status pill plus the labelled details of a hit. `max` caps the pairs for
 * the compact palette row; the results page shows them all. `oneLine` keeps
 * everything on a single truncating line. */
export function SearchHitContext({
  hit,
  max,
  className,
  oneLine = false,
  withStatus = true,
}: {
  hit: Pick<SearchHit, "context" | "subtitle">
  max?: number
  className?: string
  oneLine?: boolean
  withStatus?: boolean
}) {
  const status = withStatus ? hitStatus(hit) : null
  const pairs = hitPairs(hit, max)
  if (!status && pairs.length === 0 && !hit.subtitle) return null
  return (
    <span
      className={
        (oneLine
          ? "inline-flex min-w-0 items-center gap-x-3 overflow-hidden whitespace-nowrap "
          : "inline-flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 ") +
        (className ?? "")
      }
    >
      {status && <SearchHitStatus hit={hit} />}
      {pairs.map(([label, value]) => (
        <span
          key={label}
          className={
            "text-[11px] " + (oneLine ? "truncate" : "whitespace-nowrap")
          }
        >
          <span className="text-muted-foreground">{label} </span>
          <span className="text-foreground/80">{value}</span>
        </span>
      ))}
      {hit.subtitle && pairs.length === 0 && (
        <span className="truncate text-[11px] text-muted-foreground">
          {hit.subtitle}
        </span>
      )}
    </span>
  )
}
