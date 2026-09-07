import { ArrowRight, GitCompareArrows } from "lucide-react"

import type { SnmpDriftItem } from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"

// Shared drift-detail rendering: one line per drift item (intended → observed),
// used by the device drift inbox, the interface table's drift badge popover, and
// the interface detail page. Read-only - accepting drift stays in the inbox.

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
    case "lag_membership":
      return `lag_membership:${item.interface_id}`
    case "part_status":
      return `part_status:${item.part_id}`
    case "part_missing":
      return `part_missing:${item.name}`
  }
}

// Every drift row uses these. `min-w-0 flex-wrap` lets the row break between
// chips, and `break-all` lets a single long token (an interface description,
// a port-group name) break too - without both, text paints outside the
// popover frame instead of wrapping (issue #44).
const ROW = "flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5"
const MONO = "min-w-0 break-all font-mono"


function val(v: string | boolean): string {
  if (typeof v === "boolean") return v ? "enabled" : "disabled"
  return v || "-"
}

export function DriftDescription({ item }: { item: SnmpDriftItem }) {
  if (item.kind === "device_field") {
    return (
      <span className={ROW}>
        <span className="text-muted-foreground">{item.label}</span>
        <span className={`${MONO} line-through opacity-60`}>
          {item.intended || "-"}
        </span>
        <ArrowRight className="h-3 w-3 shrink-0 text-muted-foreground" />
        <span className={MONO}>{item.observed}</span>
      </span>
    )
  }
  if (item.kind === "interface_missing") {
    return (
      <span className={ROW}>
        <Badge variant="secondary">new interface</Badge>
        <span className={MONO}>{item.name}</span>
        {item.observed.type_name === "lag" && (
          <Badge variant="secondary">LAG</Badge>
        )}
        {item.observed.mac && (
          <span className={`${MONO} text-[11px] text-muted-foreground`}>
            {item.observed.mac}
          </span>
        )}
      </span>
    )
  }
  if (item.kind === "interface_mismatch") {
    return (
      <span className={ROW}>
        <span className={MONO}>{item.name}</span>
        <span className="text-muted-foreground">{item.field}</span>
        <span className={`${MONO} line-through opacity-60`}>
          {val(item.intended)}
        </span>
        <ArrowRight className="h-3 w-3 shrink-0 text-muted-foreground" />
        <span className={MONO}>{val(item.observed)}</span>
      </span>
    )
  }
  if (item.kind === "ip_missing") {
    return (
      <span className={ROW}>
        <Badge variant="secondary">discovered IP</Badge>
        <span className={MONO}>{item.ip}</span>
        <span className="text-muted-foreground">on</span>
        <span className={MONO}>{item.name}</span>
      </span>
    )
  }
  if (item.kind === "part_status") {
    return (
      <span className={ROW}>
        <span className={MONO}>{item.name}</span>
        <span className={`${MONO} line-through opacity-60`}>
          {item.intended}
        </span>
        <ArrowRight className="h-3 w-3 shrink-0 text-muted-foreground" />
        <span className={`${MONO} capitalize`}>{item.observed}</span>
        {/* The value the agent actually returned - "Failed" is a conclusion,
            "Critical" is the evidence for it. */}
        {item.raw && (
          <span className="text-[11px] text-muted-foreground">
            ({item.sensor ? `${item.sensor}: ` : ""}
            {item.raw})
          </span>
        )}
      </span>
    )
  }
  if (item.kind === "part_missing") {
    return (
      <span className={ROW}>
        <Badge variant="secondary">new part</Badge>
        <span className={MONO}>{item.name}</span>
        <span className={`${MONO} capitalize text-muted-foreground`}>
          {item.observed}
        </span>
        {item.raw && (
          <span className="text-[11px] text-muted-foreground">({item.raw})</span>
        )}
      </span>
    )
  }
  if (item.kind === "switch_link_suggested") {
    return (
      <span className={ROW}>
        <Badge variant="secondary">switch link</Badge>
        <span className={MONO}>{item.ip}</span>
        <span className={`${MONO} line-through opacity-60`}>{item.intended}</span>
        <ArrowRight className="h-3 w-3 shrink-0 text-muted-foreground" />
        <span className={MONO}>{item.observed}</span>
      </span>
    )
  }
  if (item.kind === "lag_membership") {
    return (
      <span className={ROW}>
        <Badge variant="secondary">LAG member</Badge>
        <span className={MONO}>{item.name}</span>
        <span className={`${MONO} line-through opacity-60`}>{item.intended}</span>
        <ArrowRight className="h-3 w-3 shrink-0 text-muted-foreground" />
        <span className={MONO}>{item.observed}</span>
        {item.observed !== "-" && !item.lag_interface_id && (
          <span className="text-[11px] text-muted-foreground">
            accept {item.observed} first
          </span>
        )}
      </span>
    )
  }
  // stale
  return (
    <span className={ROW}>
      <Badge variant="secondary">not seen on device</Badge>
      <span className={MONO}>{item.name}</span>
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
          title="Config drift - click for details"
          className="inline-flex h-4 items-center gap-1 rounded-[5px] bg-amber-500/15 px-1.5 text-[10px] font-medium text-amber-700 ring-1 ring-amber-500/30 ring-inset hover:bg-amber-500/25 dark:text-amber-400"
        >
          <GitCompareArrows className="h-2.5 w-2.5" />
          drift
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-80 overflow-hidden" align="start" onClick={(e) => e.stopPropagation()}>
        <div className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold">
          <GitCompareArrows className="h-3.5 w-3.5 text-amber-500" />
          Config drift
        </div>
        <p className="mb-2 text-[11px] text-muted-foreground">
          What SNMP observed differs from the source of truth. Review and accept
          in the device's <span className="font-medium">Drift</span> panel - the
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
