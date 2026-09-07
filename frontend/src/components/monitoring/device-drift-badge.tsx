import { useMemo } from "react"
import { Link } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { GitCompareArrows } from "lucide-react"

import { api } from "@/lib/api"
import type { SnmpDriftItem } from "@/lib/api"
import { DriftDescription } from "@/components/drift-detail"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

/** Drift kinds that belong to a device's components rather than the device
 * record itself - used to mark the Components tab and its sub-tabs. */
const COMPONENT_KINDS = new Set([
  "interface_missing",
  "interface_mismatch",
  "interface_stale",
  "ip_missing",
  "part_status",
  "part_missing",
  "lag_membership",
])

/**
 * The device's SNMP drift, shared by every consumer on the page - the header
 * badge, the tab markers, the drift inbox - so they all dedupe to one request
 * and can never disagree about whether drift exists.
 */
export function useDeviceDrift(deviceId: string): SnmpDriftItem[] {
  const q = useQuery({
    queryKey: ["device-snmp-drift", deviceId],
    queryFn: () =>
      api<{ drift: SnmpDriftItem[] }>(
        `/api/monitoring/devices/${deviceId}/snmp/drift/`
      ),
    staleTime: 60_000,
  })
  return q.data?.drift ?? []
}

/** One row of the tenant-wide drift summary (`GET /api/monitoring/snmp-drift/`). */
export interface DeviceDriftRow {
  device: string
  device_name: string
  status: string
  reachable: boolean
  drift_count: number
  by_kind: Record<string, number>
}

/**
 * Fleet-wide drift, keyed by device id - the drift analogue of
 * `useViolationMap()`. ONE request for a whole table: the endpoint pre-groups
 * SNMP state and interfaces per device specifically so a fleet view doesn't
 * issue an N+1, which is what makes a per-row badge affordable at all.
 */
export function useDriftMap(): Map<string, DeviceDriftRow> {
  const q = useQuery({
    queryKey: ["snmp-drift-fleet"],
    queryFn: () =>
      api<{ results?: DeviceDriftRow[] } | DeviceDriftRow[]>(
        "/api/monitoring/snmp-drift/"
      ),
    staleTime: 2 * 60_000,
    refetchOnWindowFocus: false,
  })
  return useMemo(() => {
    const raw = q.data
    const rows = Array.isArray(raw) ? raw : (raw?.results ?? [])
    const m = new Map<string, DeviceDriftRow>()
    for (const r of rows) if (r.drift_count > 0) m.set(r.device, r)
    return m
  }, [q.data])
}

/** Human summary of a fleet row's `by_kind`, for the marker's tooltip. */
const KIND_LABEL: Record<string, string> = {
  device_field: "device field",
  interface_missing: "interface not in Danbyte",
  interface_mismatch: "interface mismatch",
  interface_stale: "not reported by SNMP",
  ip_missing: "IP not recorded on this port",
  part_status: "hardware status",
  part_missing: "unknown part",
  lag_membership: "LAG membership",
}

/**
 * The quiet row marker for a table - the drift twin of `ViolationBadge`'s bare
 * triangle, and like it, renders nothing when the device is in sync so it can
 * sit next to any name without disturbing clean rows. Pass the shared map from
 * the table so 200 rows cost one request.
 */
export function DeviceDriftMarker({
  deviceId,
  map,
  className,
}: {
  deviceId: string
  map: Map<string, DeviceDriftRow>
  className?: string
}) {
  const row = map.get(deviceId)
  if (!row) return null
  const kinds = Object.entries(row.by_kind).filter(([, n]) => n > 0)
  const n = row.drift_count
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Link
          to="/devices/$id"
          params={{ id: deviceId }}
          search={{ tab: "snmp" }}
          aria-label={`${n} SNMP difference${n === 1 ? "" : "s"}`}
          onClick={(e) => e.stopPropagation()}
          className={cn(
            "inline-flex shrink-0 items-center align-middle text-amber-500 dark:text-amber-400",
            className
          )}
        >
          <GitCompareArrows className="h-3.5 w-3.5" />
        </Link>
      </TooltipTrigger>
      <TooltipContent
        side="top"
        variant="panel"
        className="flex-col items-start gap-0.5"
      >
        <span className="font-medium">
          {n} SNMP {n === 1 ? "difference" : "differences"}
        </span>
        <span className="text-[11px] text-muted-foreground">
          Observed by SNMP, differs from the source of truth.
        </span>
        <ul className="mt-0.5 space-y-0.5">
          {kinds.map(([k, count]) => (
            <li key={k} className="text-[11px]">
              {count} × {KIND_LABEL[k] ?? k}
            </li>
          ))}
        </ul>
      </TooltipContent>
    </Tooltip>
  )
}

/** One drifted interface from the fleet summary's opt-in `interfaces` map
 * (`GET /api/monitoring/snmp-drift/?interfaces=1`). */
export interface InterfaceDriftEntry {
  /** The owning device - so a marker can link without knowing its row's device. */
  device: string
  count: number
  kinds: string[]
}

/**
 * Fleet-wide drift keyed by *interface* id - the same one-request trick as
 * `useDriftMap()`, for tables of interfaces rather than devices. The endpoint
 * already computes every device's drift items and pre-groups state + interfaces
 * per device to avoid an N+1; `?interfaces=1` just stops it throwing the
 * interface ids away, so a whole fleet of ports costs one request.
 *
 * Only interfaces that exist in Danbyte appear: an observed port Danbyte lacks
 * (`interface_missing`) has no row to mark, and neither do discovered prefixes or
 * IPs - no drift item references an existing Prefix or IPAddress at all.
 */
export function useInterfaceDriftMap(): Map<string, InterfaceDriftEntry> {
  const q = useQuery({
    queryKey: ["snmp-drift-fleet", "interfaces"],
    queryFn: () =>
      api<{ interfaces?: Record<string, InterfaceDriftEntry> }>(
        "/api/monitoring/snmp-drift/?interfaces=1"
      ),
    staleTime: 2 * 60_000,
    refetchOnWindowFocus: false,
  })
  return useMemo(
    () => new Map(Object.entries(q.data?.interfaces ?? {})),
    [q.data]
  )
}

/**
 * The quiet row marker for a table of interfaces - same glyph and manners as
 * `DeviceDriftMarker` (renders nothing when the port is in sync, so it can sit
 * next to any interface name), pointing at the device's Components → Interfaces
 * table where the port's differences are listed in place.
 */
export function InterfaceDriftMarker({
  interfaceId,
  map,
  className,
}: {
  interfaceId: string
  map: Map<string, InterfaceDriftEntry>
  className?: string
}) {
  const row = map.get(interfaceId)
  if (!row) return null
  const n = row.count
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Link
          to="/devices/$id"
          params={{ id: row.device }}
          search={{ tab: "components", sub: "interfaces" }}
          aria-label={`${n} SNMP difference${n === 1 ? "" : "s"} on this interface`}
          onClick={(e) => e.stopPropagation()}
          className={cn(
            "inline-flex shrink-0 items-center align-middle text-amber-500 dark:text-amber-400",
            className
          )}
        >
          <GitCompareArrows className="h-3.5 w-3.5" />
        </Link>
      </TooltipTrigger>
      <TooltipContent
        side="top"
        variant="panel"
        className="flex-col items-start gap-0.5"
      >
        <span className="font-medium">
          {n} SNMP {n === 1 ? "difference" : "differences"}
        </span>
        <span className="text-[11px] text-muted-foreground">
          Observed by SNMP, differs from the source of truth.
        </span>
        <ul className="mt-0.5 space-y-0.5">
          {row.kinds.map((k) => (
            <li key={k} className="text-[11px]">
              {KIND_LABEL[k] ?? k}
            </li>
          ))}
        </ul>
      </TooltipContent>
    </Tooltip>
  )
}

/** True when any drift concerns the device's components (ports, IPs, parts). */
export function hasComponentDrift(items: SnmpDriftItem[]): boolean {
  return items.some((d) => COMPONENT_KINDS.has(d.kind))
}

/** True when drift concerns one component family, for marking a sub-tab. */
export function hasDriftOfKind(
  items: SnmpDriftItem[],
  kinds: string[]
): boolean {
  return items.some((d) => kinds.includes(d.kind))
}

/**
 * A small amber marker saying "observed reality disagrees with this record".
 *
 * Deliberately NOT a lookalike of the compliance ViolationBadge, which sits
 * right beside it on a device hero: that one is a warning triangle ("a rule you
 * wrote isn't satisfied"), this one is compare-arrows plus the word "drift"
 * ("the device reports something else"). They were once the same amber triangle
 * with a count and were impossible to tell apart. Renders nothing when the
 * device is in sync, so it can sit anywhere unconditionally.
 */
export function DeviceDriftBadge({
  deviceId,
  prominent,
  className,
}: {
  deviceId: string
  /** Filled, labelled pill with the count - for detail-page heroes. */
  prominent?: boolean
  className?: string
}) {
  const items = useDeviceDrift(deviceId)
  if (items.length === 0) return null
  const n = items.length

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* A plain anchor, not a Link: the drift inbox is a tab on THIS page,
            so this is same-route navigation via the ?tab= search param. */}
        <a
          href={`?tab=snmp`}
          aria-label={`${n} SNMP difference${n === 1 ? "" : "s"}`}
          className={cn(
            prominent
              ? "inline-flex shrink-0 items-center gap-1 rounded-md bg-amber-50 px-1.5 py-0.5 text-[11px] font-medium ring-1 ring-amber-600/20 ring-inset dark:bg-amber-950 dark:text-amber-300 dark:ring-amber-400/20"
              : "inline-flex shrink-0 items-center align-middle text-amber-500 dark:text-amber-400",
            prominent && "text-amber-700",
            className
          )}
        >
          <GitCompareArrows className="h-3.5 w-3.5" />
          {prominent && (
            <>
              <span className="num">{n}</span>
              <span>drift</span>
            </>
          )}
        </a>
      </TooltipTrigger>
      <TooltipContent
        side="top"
        variant="panel"
        className="max-w-md flex-col items-start gap-1 overflow-hidden"
      >
        <span className="font-medium">
          {n} SNMP {n === 1 ? "difference" : "differences"}
        </span>
        <span className="text-[11px] text-muted-foreground">
          Observed by SNMP, differs from the source of truth. Review on the
          Monitoring tab - nothing changes until you accept it.
        </span>
        <ul className="mt-0.5 space-y-0.5">
          {items.slice(0, 6).map((d, i) => (
            <li key={i} className="text-[11px]">
              <DriftDescription item={d} />
            </li>
          ))}
          {n > 6 && <li className="text-[11px] opacity-70">+{n - 6} more…</li>}
        </ul>
      </TooltipContent>
    </Tooltip>
  )
}

/** The bare amber dot that marks a tab whose contents contain drift. */
export function DriftDot({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "ml-1 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500",
        className
      )}
    />
  )
}
