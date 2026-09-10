import type { BulkStatusEntry, CheckStatus } from "@/lib/api"
import {
  statusColor,
  statusLabel,
  statusTextColor,
} from "@/components/monitoring/status-palette"

/** Facet bucket for a monitoring rollup: the single state, `mixed` when the
 * checks sit in more than one state (the split badge), `__none__` without a
 * rollup. */
export function monitoringBucket(e: BulkStatusEntry | undefined): string {
  if (!e || !e.status) return "__none__"
  const present = Object.values(e.counts ?? {}).filter((n) => n > 0)
  return present.length > 1 ? "mixed" : e.status
}

/** The `meta.facet` of a monitoring rollup column - one definition for
 * devices, prefixes and IPs so the rail lists the same buckets everywhere.
 * `get` returns the row's rollup, `undefined` when the object has none yet,
 * or `null` when the row is not a monitored object at all (a free address) -
 * those stay out of the count and their cell is not a click target. */
export function monitoringFacet<T>(
  get: (r: T) => BulkStatusEntry | undefined | null
) {
  return {
    kind: "enum" as const,
    label: "Monitoring",
    get: (r: T) => {
      const e = get(r)
      return e === null ? null : monitoringBucket(e)
    },
    formatValue: (v: string) => {
      if (v === "__none__") return { label: "Not monitored" }
      if (v === "mixed") return { label: "Mixed" }
      // Read straight from the palette snapshot: a facet definition is data,
      // not a component, and the app shell has the tenant's names loaded
      // before any list that shows this column paints.
      const s = v as CheckStatus
      return {
        label: statusLabel(s),
        color: statusColor(s),
        textColor: statusTextColor(s),
      }
    },
  }
}
