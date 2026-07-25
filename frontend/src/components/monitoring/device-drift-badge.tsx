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
 * record itself — used to mark the Components tab and its sub-tabs. */
const COMPONENT_KINDS = new Set([
  "interface_missing",
  "interface_mismatch",
  "interface_stale",
  "ip_missing",
  "part_status",
  "part_missing",
])

/**
 * The device's SNMP drift, shared by every consumer on the page — the header
 * badge, the tab markers, the drift inbox — so they all dedupe to one request
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
  /** Filled, labelled pill with the count — for detail-page heroes. */
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
        className="max-w-md flex-col items-start gap-1"
      >
        <span className="font-medium">
          {n} SNMP {n === 1 ? "difference" : "differences"}
        </span>
        <span className="text-[11px] text-muted-foreground">
          Observed by SNMP, differs from the source of truth. Review on the
          Monitoring tab — nothing changes until you accept it.
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
