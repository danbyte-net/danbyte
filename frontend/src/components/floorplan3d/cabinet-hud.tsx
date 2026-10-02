import { useSyncExternalStore } from "react"

import type { FloorPlanLiveState } from "@/lib/api"
import { fmtMm } from "@/lib/din-geometry"
import { cn } from "@/lib/utils"
import { useCabinetDevices } from "@/components/cabinet-devices"
import { ColorBadge } from "@/components/cells/color-badge"
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
 * is selected - Focus, its door, isolate and the way to its page. Without
 * `actions` it is the hover preview, which the pointer passes through.
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
    /** The door stands open, and the way to swing it. */
    doorOpen: boolean
    onToggleDoor: () => void
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
            <BarButton onClick={actions.onToggleDoor}>
              {actions.doorOpen ? "Close door" : "Open door"}
            </BarButton>
          </div>
          <div className="mt-1.5 grid grid-cols-2 gap-1.5">
            <BarButton
              className={actions.onIsolateZone ? undefined : "col-span-2"}
              onClick={actions.onIsolateRow}
            >
              Isolate row
            </BarButton>
            {actions.onIsolateZone && (
              <BarButton onClick={actions.onIsolateZone}>
                Isolate zone
              </BarButton>
            )}
          </div>
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

/** A device in an open cabinet, as the hover store keys it: the tile (or,
 * off a floor plan, the cabinet) and the device. */
export function deviceHoverKey(tileId: string, deviceId: string): string {
  return `${tileId}/${deviceId}`
}

/** The tile and device a `deviceHoverKey` names. */
export function parseDeviceHoverKey(
  key: string
): { tileId: string; deviceId: string } | null {
  const at = key.indexOf("/")
  return at > 0
    ? { tileId: key.slice(0, at), deviceId: key.slice(at + 1) }
    : null
}

/** The hovered device's card while the corner is free; `cabinetOf` names
 * the cabinet behind a tile id. */
export function CabinetDeviceHoverHud({
  store,
  cabinetOf,
  hidden = false,
}: {
  store: HoverStore
  cabinetOf: (tileId: string) => { id: string; name: string } | null
  hidden?: boolean
}) {
  const key = useHoveredTile(store)
  const hit = key && !hidden ? parseDeviceHoverKey(key) : null
  const cabinet = hit ? cabinetOf(hit.tileId) : null
  return hit && cabinet ? (
    <CabinetDeviceHud cabinet={cabinet} deviceId={hit.deviceId} />
  ) : null
}

/**
 * The card for a device in an open cabinet: its name and status, type and
 * role, where it sits on the rails, and - once it is clicked - the way to
 * its page, with Focus where the room offers it. Without `pinned` it is the
 * hover preview, which the pointer passes through. The device comes from
 * the cabinet's device list, which the open cabinet has already fetched.
 */
export function CabinetDeviceHud({
  cabinet,
  deviceId,
  pinned = false,
  focus,
  className,
}: {
  cabinet: { id: string; name: string }
  deviceId: string
  /** Clicked rather than hovered: the links show. */
  pinned?: boolean
  /** The room's Focus, on the clicked device's card. */
  focus?: { on: boolean; onToggle: () => void }
  /** Moves the card, e.g. `CARD_PLACE.bottom`. */
  className?: string
}) {
  const devices = useCabinetDevices(cabinet.id)
  const d = devices.data?.results.find((x) => x.id === deviceId)
  if (!d) return null
  const type = d.device_type
  const row = (label: string, value: React.ReactNode) => (
    <div className="flex items-baseline justify-between gap-3">
      <span className="shrink-0 whitespace-nowrap text-muted-foreground">
        {label}
      </span>
      <span className="min-w-0 flex-1 text-right break-words">{value}</span>
    </div>
  )
  return (
    <div
      role="group"
      aria-label={`Device ${d.name}`}
      className={cn(
        "absolute top-3 left-3 w-64 rounded-lg border border-border bg-popover/95 p-3 text-popover-foreground shadow-lg backdrop-blur",
        !pinned && "pointer-events-none",
        className
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="min-w-0 flex-1 font-mono text-[13px] font-semibold break-words">
          {d.name}
        </span>
        {d.status && (
          <ColorBadge
            name={d.status.name}
            color={d.status.color || undefined}
            className="h-4 shrink-0 px-1.5 text-[10px]"
          />
        )}
      </div>
      <div className="mt-1.5 grid gap-1 text-[12px]">
        {type && row("Type", type.name)}
        {d.role &&
          row(
            "Role",
            <ColorBadge
              name={d.role.name}
              color={d.role.color || undefined}
              className="h-4 px-1.5 text-[10px]"
            />
          )}
        {d.din_rail &&
          row(
            "Position",
            <span className="num">
              {cabinet.name} · {d.din_rail.label} @{" "}
              {fmtMm(d.din_offset_mm ?? 0)} mm
            </span>
          )}
        {type?.width_mm != null &&
          type.height_mm != null &&
          row(
            "Size",
            <span className="num">
              {fmtMm(type.width_mm)} × {fmtMm(type.height_mm)} mm
            </span>
          )}
        {d.primary_ip &&
          row(
            "Primary IP",
            <span className="font-mono">{d.primary_ip.ip_address}</span>
          )}
        {d.serial_number &&
          row("Serial", <span className="font-mono">{d.serial_number}</span>)}
      </div>
      {pinned && focus && (
        <BarTip tip="Focus" shortcut="F">
          <BarButton
            variant={focus.on ? "default" : "outline"}
            className="mt-2 w-full"
            onClick={focus.onToggle}
          >
            Focus
          </BarButton>
        </BarTip>
      )}
      {pinned && (
        <OpenLink
          to="/devices/$id"
          params={{ id: d.id }}
          className={cn("w-full", focus ? "mt-1.5" : "mt-2")}
        >
          Open device
        </OpenLink>
      )}
    </div>
  )
}
