import { useState } from "react"
import type { ReactNode } from "react"
import { List, X } from "lucide-react"

import { ColorBadge } from "@/components/cells/color-badge"
import { SectionLabel } from "@/components/map-panel"
import { CheckStatusBadge } from "@/components/monitoring/status-badge"
import { StatusBadge } from "@/components/status-badge"
import { Button } from "@/components/ui/button"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import type { StatusMini } from "@/lib/api"
import { cn } from "@/lib/utils"

// The legend a map draws in a corner of its canvas - the topology's, the
// rail maps', the site map's and the 3D room's. One frame: bordered and
// opaque (a coloured card or line behind it never shows through), no shadow
// (shadows are for overlays), headed *Legend* with a Hide button, and folded
// to a *Legend* chip. Its rows are the pieces below: lines keyed as lines,
// and catalog colours - roles, statuses - as their pills, never a dot.

/** One legend entry. The topology legend draws these, and the exports turn
 * them into their own legend rows (to-document.ts `printLegend`). */
export type LegendItem =
  /** A Diagram card fill: the role's colour. */
  | { kind: "role"; label: string; color?: string }
  /** The monitoring pill a card shows while down. */
  | { kind: "pill"; label: string }
  /** A line style. `sem` names the edge kind when the look is that kind's
   * own (the exports draw it with their print colours). */
  | {
      kind: "line"
      label: string
      width?: number
      dash?: string
      color?: string
      sem?: "cable" | "bundle" | "ghost" | "bgp"
    }
  /** A box: a site/location card, or a patch panel's dashed outline. */
  | { kind: "box"; label: string; dashed?: boolean }
  /** A color-mode swatch: a cable type or a speed tier. */
  | { kind: "tone"; label: string; color: string; mono?: boolean }
  /** A color-mode note. */
  | { kind: "note"; label: string }

function readOpen(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key)
    return v ? v !== "closed" : fallback
  } catch {
    return fallback
  }
}

/**
 * The legend box. Open or folded is remembered per browser under
 * `storageKey` ("open" / "closed"), or held by the page when it passes
 * `open` and `onOpenChange`. `hideable={false}` keeps it open with no Hide
 * button - a legend that is part of the picture, which an export carries.
 */
export function LegendFrame({
  storageKey,
  defaultOpen = true,
  open: openProp,
  onOpenChange,
  hideable = true,
  className = "w-60",
  children,
}: {
  /** Where the open state is remembered. Maps that share a key share the
   * choice (the topology's views do). */
  storageKey?: string
  /** Open until the viewer folds it. */
  defaultOpen?: boolean
  /** Controlled: the page keeps the open state. */
  open?: boolean
  onOpenChange?: (open: boolean) => void
  /** False: always open, headed *Legend* with no Hide button and never
   * folded - for a legend drawn inside an export's area (the floor plan's
   * Color by key), where a button would land in the picture. */
  hideable?: boolean
  /** The open box's width - `w-60` unless the rows need their own. */
  className?: string
  children: ReactNode
}) {
  const [own, setOwn] = useState(() =>
    storageKey ? readOpen(storageKey, defaultOpen) : defaultOpen
  )
  const open = !hideable || (openProp ?? own)
  const toggle = (v: boolean) => {
    setOwn(v)
    onOpenChange?.(v)
    if (!storageKey) return
    try {
      localStorage.setItem(storageKey, v ? "open" : "closed")
    } catch {
      /* private window or blocked storage: the choice lasts this visit */
    }
  }

  if (!open)
    return (
      <Button
        variant="outline"
        size="xs"
        onClick={() => toggle(true)}
        className="bg-background text-muted-foreground shadow-none"
      >
        <List /> Legend
      </Button>
    )
  return (
    <div
      data-slot="map-legend"
      className={cn(
        "rounded-md border border-border bg-background p-2.5 pt-1.5 text-[11px]",
        className
      )}
    >
      <div
        className={cn(
          "mb-1 flex items-center justify-between gap-4",
          // The Hide button sets the header's height; without it the label
          // keeps the same rhythm.
          !hideable && "h-6"
        )}
      >
        <SectionLabel className="mb-0">Legend</SectionLabel>
        {hideable && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                className="-mr-1.5"
                aria-label="Hide legend"
                onClick={() => toggle(false)}
              >
                <X />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top" variant="default">
              Hide legend
            </TooltipContent>
          </Tooltip>
        )}
      </div>
      {children}
    </div>
  )
}

/** A line swatch: a legend keys a line as a line. */
export function LegendLine({
  color = "var(--muted-foreground)",
  width = 2,
  dash,
  length = 26,
  cap = "round",
}: {
  color?: string
  width?: number
  dash?: string
  length?: number
  cap?: "round" | "butt"
}) {
  return (
    <svg width={length} height="10" className="shrink-0">
      <line
        x1="1"
        y1="5"
        x2={length - 1}
        y2="5"
        stroke={color}
        strokeWidth={width}
        strokeDasharray={dash}
        strokeLinecap={cap}
      />
    </svg>
  )
}

/** One keyed row: the swatch, then its label. */
export function LegendRow({
  swatch,
  label,
  className,
}: {
  swatch: ReactNode
  label: ReactNode
  className?: string
}) {
  return (
    <div className={cn("flex items-center gap-2", className)}>
      {swatch}
      <span className="min-w-0">{label}</span>
    </div>
  )
}

/** The pill size every legend uses for a role or a status. */
export const LEGEND_PILL = "h-4 px-1.5 text-[10px]"
const PILL = LEGEND_PILL

/** Catalog colours - roles, tile types - as their pills. */
export function LegendPills({
  items,
  className,
}: {
  items: readonly { name: string; color?: string | null }[]
  className?: string
}) {
  if (items.length === 0) return null
  return (
    <div className={cn("flex flex-wrap gap-1 pb-1", className)}>
      {items.map((i) => (
        <ColorBadge
          key={i.name}
          name={i.name}
          color={i.color || undefined}
          className={PILL}
        />
      ))}
    </div>
  )
}

/** Statuses as their `StatusBadge` pills, in the tenant's own colours. */
export function LegendStatuses({
  statuses,
  className,
}: {
  statuses: readonly StatusMini[]
  className?: string
}) {
  if (statuses.length === 0) return null
  return (
    <div className={cn("flex flex-wrap gap-1 pb-1", className)}>
      {statuses.map((s) => (
        <StatusBadge key={s.id} status={s} className={PILL} />
      ))}
    </div>
  )
}

/** Colour-mode keys - cable types, speed tiers - as short lines in their
 * colours, wrapping when there are more than fit. */
export function LegendTones({
  tones,
  className,
}: {
  tones: readonly { label: string; color: string; mono?: boolean }[]
  className?: string
}) {
  if (tones.length === 0) return null
  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-x-2 gap-y-0.5 pt-1",
        className
      )}
    >
      {tones.map((t) => (
        <span key={t.label} className="flex items-center gap-1">
          <LegendLine color={t.color} width={2.5} length={14} />
          <span
            className={
              t.mono
                ? "font-mono text-muted-foreground"
                : "text-muted-foreground"
            }
          >
            {t.label}
          </span>
        </span>
      ))}
    </div>
  )
}

/** A legend item's swatch as the topology canvas draws it. */
export function legendSwatch(item: LegendItem): ReactNode {
  if (item.kind === "pill")
    return (
      <CheckStatusBadge status="down" className="h-4 px-[7px] text-[9px]" />
    )
  if (item.kind === "line")
    return <LegendLine dash={item.dash} width={item.width} color={item.color} />
  if (item.kind === "box")
    return item.dashed ? (
      <span className="h-3 w-6 shrink-0 rounded-sm border border-dashed border-muted-foreground/60 bg-card" />
    ) : (
      <span className="h-3 w-6 shrink-0 rounded-sm border-2 border-border bg-card" />
    )
  return null
}

/**
 * A list of legend items, in order: the roles as pills, then a row per
 * pill, line and box, then the colour-mode tones or note. `swatch` draws a
 * row's key when the map draws its lines and boxes its own way (the rail
 * maps' bars).
 */
export function LegendItems({
  rows,
  maxRoles,
  swatch = legendSwatch,
}: {
  rows: readonly LegendItem[]
  /** The most role pills to list; the rest are on the map. */
  maxRoles?: number
  swatch?: (item: LegendItem) => ReactNode
}) {
  const roles = rows
    .filter(
      (r): r is Extract<LegendItem, { kind: "role" }> => r.kind === "role"
    )
    .slice(0, maxRoles)
    .map((r) => ({ name: r.label, color: r.color }))
  const tones = rows.filter(
    (r): r is Extract<LegendItem, { kind: "tone" }> => r.kind === "tone"
  )
  const note = rows.find((r) => r.kind === "note")
  return (
    <div className="space-y-1">
      <LegendPills items={roles} />
      {rows.map((r, i) =>
        r.kind === "pill" || r.kind === "line" || r.kind === "box" ? (
          <LegendRow key={i} swatch={swatch(r)} label={r.label} />
        ) : null
      )}
      {tones.length > 0 ? (
        <LegendTones tones={tones} />
      ) : note ? (
        <p className="pt-1 text-muted-foreground">{note.label}</p>
      ) : null}
    </div>
  )
}
