import { ArrowRight, TriangleAlert } from "lucide-react"

import type { SnmpDriftItem } from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"

// Shared drift-detail rendering: one line per drift item (intended → observed),
// used by the device drift inbox, the interface table's drift badge popover, and
// the interface detail page. Read-only — accepting drift stays in the inbox.

export function driftKey(item: SnmpDriftItem): string {
  switch (item.kind) {
    case "device_field":
      return `device_field:${item.field}`
    case "interface_missing":
      return `interface_missing:${item.name}`
    case "interface_mismatch":
      return `interface_mismatch:${item.interface_id}:${item.field}`
    case "interface_stale":
      return `interface_stale:${item.interface_id}`
    case "ip_missing":
      return `ip_missing:${item.interface_id}:${item.ip}`
    case "switch_link_suggested":
      return `switch_link:${item.ip_id}:${item.interface_id}`
  }
}

function val(v: string | boolean): string {
  if (typeof v === "boolean") return v ? "enabled" : "disabled"
  return v || "—"
}

export function DriftDescription({ item }: { item: SnmpDriftItem }) {
  if (item.kind === "device_field") {
    return (
      <span className="flex min-w-0 flex-wrap items-center gap-1.5">
        <span className="text-muted-foreground">{item.label}</span>
        <span className="font-mono line-through opacity-60">
          {item.intended || "—"}
        </span>
        <ArrowRight className="h-3 w-3 shrink-0 text-muted-foreground" />
        <span className="font-mono">{item.observed}</span>
      </span>
    )
  }
  if (item.kind === "interface_missing") {
    return (
      <span className="flex items-center gap-2">
        <Badge variant="secondary">new interface</Badge>
        <span className="font-mono">{item.name}</span>
        {item.observed.mac && (
          <span className="font-mono text-[11px] text-muted-foreground">
            {item.observed.mac}
          </span>
        )}
      </span>
    )
  }
  if (item.kind === "interface_mismatch") {
    return (
      <span className="flex min-w-0 flex-wrap items-center gap-1.5">
        <span className="font-mono">{item.name}</span>
        <span className="text-muted-foreground">{item.field}</span>
        <span className="font-mono line-through opacity-60">
          {val(item.intended)}
        </span>
        <ArrowRight className="h-3 w-3 shrink-0 text-muted-foreground" />
        <span className="font-mono">{val(item.observed)}</span>
      </span>
    )
  }
  if (item.kind === "ip_missing") {
    return (
      <span className="flex items-center gap-2">
        <Badge variant="secondary">discovered IP</Badge>
        <span className="font-mono">{item.ip}</span>
        <span className="text-muted-foreground">on</span>
        <span className="font-mono">{item.name}</span>
      </span>
    )
  }
  if (item.kind === "switch_link_suggested") {
    return (
      <span className="flex min-w-0 flex-wrap items-center gap-1.5">
        <Badge variant="secondary">switch link</Badge>
        <span className="font-mono">{item.ip}</span>
        <span className="font-mono line-through opacity-60">{item.intended}</span>
        <ArrowRight className="h-3 w-3 shrink-0 text-muted-foreground" />
        <span className="font-mono">{item.observed}</span>
      </span>
    )
  }
  // stale
  return (
    <span className="flex items-center gap-2">
      <Badge variant="secondary">not seen on device</Badge>
      <span className="font-mono">{item.name}</span>
    </span>
  )
}

/** The amber "drift" pill that opens a popover listing what differs. Renders
 * nothing when there are no items. */
export function DriftBadge({ items }: { items: SnmpDriftItem[] }) {
  if (!items.length) return null
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          onClick={(e) => e.stopPropagation()}
          title="Config drift — click for details"
          className="inline-flex h-4 items-center gap-1 rounded-[5px] bg-amber-500/15 px-1.5 text-[10px] font-medium text-amber-700 ring-1 ring-amber-500/30 ring-inset hover:bg-amber-500/25 dark:text-amber-400"
        >
          <TriangleAlert className="h-2.5 w-2.5" />
          drift
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-80" align="start" onClick={(e) => e.stopPropagation()}>
        <div className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold">
          <TriangleAlert className="h-3.5 w-3.5 text-amber-500" />
          Config drift
        </div>
        <p className="mb-2 text-[11px] text-muted-foreground">
          What SNMP observed differs from the source of truth. Review and accept
          in the device's <span className="font-medium">Drift</span> panel — the
          source of truth doesn't change until you do.
        </p>
        <ul className="space-y-1.5 text-[12px]">
          {items.map((it) => (
            <li key={driftKey(it)}>
              <DriftDescription item={it} />
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  )
}
