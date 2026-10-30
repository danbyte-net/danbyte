import { useEffect, useRef, useState } from "react"
import { Link } from "@tanstack/react-router"
import { ExternalLink } from "lucide-react"

import type { FloorPlanCablePath, FloorPlanTray } from "@/lib/api"
import { PanelRow } from "@/components/map-panel"
import { StatusBadge } from "@/components/status-badge"
import { Button } from "@/components/ui/button"
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover"

import {
  endText,
  formatMetres,
  formatStoredLength,
  routeLengthM,
  storedLengthM,
} from "./cable-draw"
import type { CableRoute } from "./cable-draw"
import type { CableHoverHit } from "./cable-layer"

/** A hovered or pinned cable (or bundle), anchored in the canvas
 * wrapper's px. */
export interface CableHoverTarget extends CableHoverHit {
  x: number
  y: number
  pinned: boolean
}

/** The most cables a bundle's popover lists. */
const BUNDLE_ROWS = 10

/**
 * Hover and pin for the cable popover, with the tile popover's open delay:
 * a hover previews, a click (or Enter) on a cable pins it.
 */
export function useCablePopover(delayMs = 250) {
  const [target, setTarget] = useState<CableHoverTarget | null>(null)
  const timer = useRef<number | null>(null)
  const pinned = useRef(false)
  const last = useRef<CableHoverTarget | null>(null)

  const clearTimer = () => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current)
      timer.current = null
    }
  }
  useEffect(() => clearTimer, [])

  const onHover = (
    hit: CableHoverHit | null,
    at: { x: number; y: number } | null
  ) => {
    last.current = hit && at ? { ...hit, ...at, pinned: false } : null
    if (pinned.current) return
    clearTimer()
    if (!hit || !at) {
      setTarget(null)
      return
    }
    timer.current = window.setTimeout(() => {
      if (pinned.current) return
      setTarget({ ...hit, ...at, pinned: false })
    }, delayMs)
  }

  /** Pin the cable under the pointer (or the keyboard). False when there is
   * none. */
  const pinCurrent = () => {
    const hit = last.current
    if (!hit) return false
    clearTimer()
    pinned.current = true
    setTarget({ ...hit, pinned: true })
    return true
  }

  const close = () => {
    clearTimer()
    pinned.current = false
    setTarget(null)
  }

  return { target, onHover, pinCurrent, close }
}

/**
 * The cable popover: what a run is - its status, type, both ends (an end on
 * a device you may not view reads Hidden), the stored length against the
 * length its route works out, and the trays it rides. Over a bundle it
 * lists the cables in it. Replaces the browser's `<title>` tooltip.
 */
export function CablePopover({
  target,
  cablePaths,
  routes,
  trays,
  cellMm,
  onOpenChange,
}: {
  target: CableHoverTarget | null
  cablePaths: readonly FloorPlanCablePath[]
  routes: ReadonlyMap<string, CableRoute>
  trays: readonly FloorPlanTray[]
  cellMm: number
  onOpenChange: (open: boolean) => void
}) {
  const cables = (target?.ids ?? [])
    .map((id) => cablePaths.find((cp) => cp.id === id))
    .filter((cp): cp is FloorPlanCablePath => !!cp)
  const open = cables.length > 0
  const one = target && !target.bundle ? cables[0] : null

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverAnchor asChild>
        <div
          className="pointer-events-none absolute"
          style={{ left: target?.x ?? 0, top: target?.y ?? 0 }}
        />
      </PopoverAnchor>
      <PopoverContent
        side="top"
        align="start"
        sideOffset={12}
        className="w-72 p-3"
        onOpenAutoFocus={(e) => e.preventDefault()}
        // A click on the plan is the canvas's to read (pin another, clear).
        onPointerDownOutside={(e) => {
          const t = e.detail.originalEvent.target as Element | null
          if (t?.closest("[data-floor-canvas]")) e.preventDefault()
        }}
        style={target?.pinned ? undefined : { pointerEvents: "none" }}
      >
        {one ? (
          <CableFacts
            cp={one}
            route={routes.get(one.id)}
            trays={trays}
            cellMm={cellMm}
            pinned={!!target?.pinned}
          />
        ) : (
          open && (
            <>
              <p className="text-sm font-medium">{cables.length} cables</p>
              <ul className="mt-2 grid gap-1 text-[12px]">
                {cables.slice(0, BUNDLE_ROWS).map((cp) => (
                  <li
                    key={cp.id}
                    className="flex items-center justify-between gap-2"
                  >
                    <span className="min-w-0 truncate">{cp.label}</span>
                    {cp.status && (
                      <StatusBadge
                        status={cp.status}
                        className="h-4 px-1.5 text-[10px]"
                      />
                    )}
                  </li>
                ))}
              </ul>
              {cables.length > BUNDLE_ROWS && (
                <p className="mt-1 text-[11px] text-muted-foreground">
                  +{cables.length - BUNDLE_ROWS} more
                </p>
              )}
              <p className="mt-2 text-[10px] text-muted-foreground">
                Click to fan out
              </p>
            </>
          )
        )}
      </PopoverContent>
    </Popover>
  )
}

function CableFacts({
  cp,
  route,
  trays,
  cellMm,
  pinned,
}: {
  cp: FloorPlanCablePath
  route: CableRoute | undefined
  trays: readonly FloorPlanTray[]
  cellMm: number
  pinned: boolean
}) {
  const computed = route ? routeLengthM(route, cellMm) : null
  const stored = storedLengthM(cp)
  const delta = computed != null && stored != null ? computed - stored : null
  const trayNames = (route?.trayIds ?? [])
    .map((id) => trays.find((t) => t.id === id)?.name)
    .filter(Boolean)
  return (
    <>
      <p className="truncate text-sm font-medium">{cp.label || "Cable"}</p>
      <div className="mt-2">
        <PanelRow label="Status">
          <StatusBadge status={cp.status ?? null} />
        </PanelRow>
        <PanelRow label="Type">{cp.type_display || cp.type || "-"}</PanelRow>
        <PanelRow label="A">{endText(cp.a_points)}</PanelRow>
        <PanelRow label="B">{endText(cp.b_points)}</PanelRow>
        <PanelRow label="Length">{formatStoredLength(cp) ?? "-"}</PanelRow>
        <PanelRow label="Route">
          {computed == null ? (
            "-"
          ) : (
            <span className="num">
              {formatMetres(computed)}
              {delta != null && Math.abs(delta) >= 0.05 && (
                <span className="text-muted-foreground">
                  {" "}
                  ({delta > 0 ? "+" : "−"}
                  {formatMetres(Math.abs(delta))})
                </span>
              )}
            </span>
          )}
        </PanelRow>
        <PanelRow label="Trays">
          {trayNames.length ? trayNames.join(" → ") : "Direct"}
        </PanelRow>
      </div>
      {pinned ? (
        <Button variant="outline" size="sm" className="mt-3 w-full" asChild>
          <Link to="/cables/$id" params={{ id: cp.id }}>
            <ExternalLink className="h-3.5 w-3.5" /> Open cable
          </Link>
        </Button>
      ) : (
        <p className="mt-2 text-[10px] text-muted-foreground">Click to trace</p>
      )}
    </>
  )
}
