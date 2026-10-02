import { useSyncExternalStore } from "react"

import type { FloorPlanLiveState } from "@/lib/api"
import { cn } from "@/lib/utils"
import { RowCheckBadge } from "@/components/foldable-group"
import { BarButton, BarTip } from "@/components/map-toolbar"
import { OpenLink } from "@/components/open-link"

import type { SceneTile } from "./world"

/**
 * Which tile the pointer is over, outside React state: the scene re-renders
 * every rack when its own state changes, so a hover kept there would cost a
 * hall-wide render per pointer crossing. Only the card subscribes.
 */
export interface HoverStore {
  get: () => string | null
  subscribe: (listener: () => void) => () => void
  /** Pointer over (`on`) or off a tile. Off lets go only of the tile it
   * names, so a late pointer-out can't clear the next tile's hover. */
  set: (tileId: string, on: boolean) => void
}

export function createHoverStore(): HoverStore {
  let current: string | null = null
  const listeners = new Set<() => void>()
  return {
    get: () => current,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    set: (tileId, on) => {
      const next = on ? tileId : current === tileId ? null : current
      if (next === current) return
      current = next
      for (const listener of listeners) listener()
    },
  }
}

export function useHoveredTile(store: HoverStore): string | null {
  return useSyncExternalStore(store.subscribe, store.get, store.get)
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`

/** The hovered cabinet's card, while the corner is free - a selection's
 * card owns it otherwise. */
export function CabinetHoverHud({
  store,
  tiles,
  liveState,
  hidden = false,
}: {
  store: HoverStore
  /** The cabinet tiles the room draws. */
  tiles: SceneTile[]
  liveState: FloorPlanLiveState | null
  hidden?: boolean
}) {
  const id = useHoveredTile(store)
  const tile = id && !hidden ? tiles.find((t) => t.id === id) : undefined
  return tile ? <CabinetHud tile={tile} liveState={liveState} /> : null
}

/**
 * The card for a DIN-rail cabinet in the room: its name and outer size,
 * its devices and rails with the worst check of its devices, and - once it
 * is selected - Focus, isolate and the way to its page. Without `actions`
 * it is the hover preview, which the pointer passes through.
 */
export function CabinetHud({
  tile,
  liveState,
  actions,
}: {
  tile: SceneTile
  liveState: FloorPlanLiveState | null
  /** The selected cabinet's controls; left out, the card is a preview. */
  actions?: {
    focused: boolean
    onToggleFocus: () => void
    onIsolateRow: () => void
    /** Present only when the cabinet stands in a zone. */
    onIsolateZone?: () => void
  }
}) {
  const cabinet = tile.cabinet
  if (!cabinet) return null
  const live = liveState?.tiles[tile.id]
  const state = live?.kind === "cabinet" ? live : null
  const devices = state?.device_count ?? cabinet.device_count
  return (
    <div
      role="group"
      aria-label={`Cabinet ${tile.label || cabinet.name}`}
      className={cn(
        "absolute top-3 left-3 w-60 rounded-lg border border-border bg-popover/95 p-3 text-popover-foreground shadow-lg backdrop-blur",
        !actions && "pointer-events-none"
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="min-w-0 truncate font-mono text-[13px] font-semibold">
          {tile.label || cabinet.name}
        </span>
        <span className="num shrink-0 text-[11px] whitespace-nowrap text-muted-foreground">
          {cabinet.outer_width_mm}×{cabinet.outer_height_mm} mm
        </span>
      </div>
      <div className="mt-1 grid gap-0.5 text-[12px] text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <span className="num">{plural(devices, "device")}</span>
          <RowCheckBadge check={state?.check} />
        </span>
        {state && (
          <span className="num">{plural(state.rail_count, "rail")}</span>
        )}
        {actions && (
          <span className="text-[11px]">double-click to zoom in</span>
        )}
      </div>
      {actions && (
        <>
          <div className="mt-2 grid grid-cols-2 gap-1.5">
            <BarTip tip="Focus" shortcut="F">
              <BarButton
                variant={actions.focused ? "default" : "outline"}
                onClick={actions.onToggleFocus}
              >
                Focus
              </BarButton>
            </BarTip>
            <BarButton onClick={actions.onIsolateRow}>Isolate row</BarButton>
          </div>
          {actions.onIsolateZone && (
            <BarButton
              className="mt-1.5 w-full"
              onClick={actions.onIsolateZone}
            >
              Isolate zone
            </BarButton>
          )}
          <OpenLink
            to="/cabinets/$id"
            params={{ id: cabinet.id }}
            className="mt-1.5 w-full"
          >
            Open cabinet
          </OpenLink>
        </>
      )}
    </div>
  )
}
