import { useCallback, useState } from "react"
import type { PointerEvent } from "react"
import { TriangleAlert } from "lucide-react"
import { Link } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"

import { api } from "@/lib/api"
import type { Cable, FacePorts } from "@/lib/api"
import { renderTemplateName } from "@/lib/faceplate-geometry"
import { bayHex } from "@/lib/faceplate-colors"
import { useMe } from "@/lib/use-me"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { ColorBadge } from "@/components/cells/color-badge"
import { Loading } from "@/components/loading"
import { BarButton, BarTip } from "@/components/map-toolbar"
import { OpenLink } from "@/components/open-link"

import { PORT_RESERVED, isReserved } from "./device-mesh"
import type { Sel } from "./rack-mesh"
import type { SceneDevice, SceneTile } from "./world"

// The cards a 3D view shows for a racked device and for one of its photo
// ports - the room's, and a single rack's on its page.

/** Where a view's card goes: its top-left corner, or its bottom-left. */
export type CardPlace = "top" | "bottom"

/** The classes that move a card from its top-left corner. */
export const CARD_PLACE: Record<CardPlace, string> = {
  top: "",
  bottom: "top-auto bottom-3",
}

/**
 * Where a view's card goes: in the half of the view away from the click
 * that picked the thing, so the card neither covers what was picked nor
 * catches the second click of a double-click. A narrow view - one rack or
 * one cabinet on its page - is where a fixed corner keeps landing on the
 * gear, and a card can be wider than half of it, so it moves up or down
 * rather than across. Spread `onPointerDown` on the element that holds the
 * canvas and the card.
 */
export function useCardPlace(): {
  place: CardPlace
  onPointerDown: (e: PointerEvent<HTMLElement>) => void
} {
  const [place, setPlace] = useState<CardPlace>("top")
  const onPointerDown = useCallback((e: PointerEvent<HTMLElement>) => {
    // Only presses on the canvas place the card; one on the card is its own.
    if (!(e.target instanceof HTMLCanvasElement)) return
    const box = e.currentTarget.getBoundingClientRect()
    setPlace(e.clientY - box.top < box.height / 2 ? "bottom" : "top")
  }, [])
  return { place, onPointerDown }
}

/** Overlay card for a selected device - identity, status, where it sits;
 * Focus where the view offers it, and the way to the device's page. */
export function DeviceHud({
  tile,
  dev,
  focused,
  onToggleFocus,
  className,
}: {
  tile: SceneTile
  dev: SceneDevice
  focused?: boolean
  /** The room's Focus; left out, the card has no Focus button. */
  onToggleFocus?: () => void
  /** Moves the card, e.g. `CARD_PLACE.bottom`. */
  className?: string
}) {
  const rack = tile.rack!
  const row = (label: string, value: React.ReactNode) => (
    <div className="flex items-baseline justify-between gap-3">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 flex-1 text-right break-words">{value}</span>
    </div>
  )
  return (
    <div
      className={cn(
        "absolute top-3 left-3 w-64 rounded-lg border border-border bg-popover/95 p-3 text-popover-foreground shadow-lg backdrop-blur",
        className
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="min-w-0 flex-1 font-mono text-[13px] font-semibold break-words">
          {dev.name}
        </span>
        {dev.status && (
          <ColorBadge
            name={dev.status.name}
            color={dev.status.color || undefined}
            className="h-4 shrink-0 px-1.5 text-[10px]"
          />
        )}
      </div>
      <div className="mt-1.5 grid gap-1 text-[12px]">
        {dev.device_type && row("Type", dev.device_type)}
        {dev.role_name &&
          row(
            "Role",
            <ColorBadge
              name={dev.role_name}
              color={dev.role_color || undefined}
              className="h-4 px-1.5 text-[10px]"
            />
          )}
        {row(
          "Position",
          dev.position != null
            ? `${rack.name} · U${dev.position}` +
                (dev.u_height > 1 ? `–${dev.position + dev.u_height - 1}` : "")
            : `${rack.name} · ${
                dev.mount === "side_left" ? "left" : "right"
              } side rail`
        )}
        {row(
          "Size",
          `${dev.u_height}U` +
            (dev.rack_width === "half" ? ` · half (${dev.rack_side})` : "") +
            (dev.face === "rear" ? " · rear" : "")
        )}
        {dev.primary_ip &&
          row(
            "Primary IP",
            <span className="font-mono">{dev.primary_ip}</span>
          )}
        {dev.serial_number &&
          row("Serial", <span className="font-mono">{dev.serial_number}</span>)}
      </div>
      {onToggleFocus && (
        <BarTip tip="Focus" shortcut="F">
          <BarButton
            variant={focused ? "default" : "outline"}
            className="mt-2 w-full"
            onClick={onToggleFocus}
          >
            Focus
          </BarButton>
        </BarTip>
      )}
      <OpenLink
        to="/devices/$id"
        params={{ id: dev.id }}
        className={cn("w-full", onToggleFocus ? "mt-1.5" : "mt-2")}
      >
        Open device
      </OpenLink>
    </div>
  )
}

/** Where a racked device's port is, for its card: the rack and the unit,
 * or the rack alone for a side-mounted strip, which has no U. */
export function rackPortPosition(tile: SceneTile, dev: SceneDevice): string {
  const rack = tile.rack!
  return dev.position != null ? `${rack.name} · U${dev.position}` : rack.name
}

/**
 * Overlay card for a clicked photo port. Resolves the marker to the real
 * component (same face-ports fetch the quads use), and:
 *  - free port → the connect flow (pick in 3D / cable maker)
 *  - cabled port → the cable (label/type/color) + the FAR END device:port,
 *    with jump-offs to the cable and an in-room trace of its run.
 * A view without the room's flows leaves their props out: no `planId`, no
 * Trace run; no `onConnect`, `onInstall` or `onEditPart`, no such button.
 * `preview` is the hover card: the same facts, no buttons, and the pointer
 * passes through it.
 */
export function PortHud({
  planId,
  device,
  position,
  selection,
  onConnect,
  onInstall,
  onEditPart,
  showReserved = false,
  preview = false,
  className,
}: {
  /** The floor plan the room is drawn from - Trace run draws the run there. */
  planId?: string
  /** The device the port is on. */
  device: { id: string; name: string }
  /** Where it sits: `rackPortPosition`, or a cabinet's rail and offset. */
  position: string
  selection: Sel
  onConnect?: (path: "maker" | "3d") => void
  /** An empty module bay was clicked - open the install dialog for it. */
  onInstall?: (bay: { id: string; name: string }) => void
  /** A hardware marker (disk bay, PSU…) was clicked - open its part editor. */
  onEditPart?: (part: { id: string; name: string }) => void
  /** A port held but not cabled reads "reserved", as its quad is drawn
   * amber where the view marks reservations. */
  showReserved?: boolean
  /** The hover card: facts only, and the pointer passes through it. */
  preview?: boolean
  /** Moves the card, e.g. `CARD_PLACE.bottom`. */
  className?: string
}) {
  const { canDo } = useMe()
  // Installing a module / editing a part writes to the device - the same gate
  // the Modules pane and the 2D faceplate use.
  const canEditParts = canDo("device", "change")
  const [choosing, setChoosing] = useState(false)
  // A preview offers no action: the room's flows go with the click.
  const act = !preview
  // The saved marker name is a template ("Ethernet{position}/1"); render it the
  // same way the 2D faceplate does so the card shows the real port label.
  const portLabel = renderTemplateName(selection.portName ?? "", null)

  // Resolve this marker → real port (shared cache with the port quads).
  const facePorts = useQuery({
    queryKey: ["device-face-ports", device.id],
    queryFn: () => api<FacePorts>(`/api/devices/${device.id}/face-ports/`),
    staleTime: 30_000,
  })
  const fp = (
    selection.portSide
      ? (facePorts.data?.[selection.portSide] ?? [])
      : [...(facePorts.data?.front ?? []), ...(facePorts.data?.rear ?? [])]
  ).find((p) => p.marker === selection.portName)

  // Cabled → load the cable for its identity + far-end terminations.
  const cable = useQuery({
    queryKey: ["cable", fp?.cable_id],
    queryFn: () => api<Cable>(`/api/cables/${fp!.cable_id}/`),
    enabled: !!fp?.cable_id,
    staleTime: 30_000,
  })
  const farEnds = (() => {
    const c = cable.data
    if (!c || !fp?.id) return []
    const mine = (list: Cable["a_terminations"]) =>
      list.some((t) => t.id === fp.id)
    // The far side is whichever end does NOT carry this port.
    return mine(c.a_terminations) ? c.b_terminations : c.a_terminations
  })()

  const row = (label: string, value: React.ReactNode) => (
    <div className="flex items-baseline justify-between gap-3">
      <span className="shrink-0">{label}</span>
      <span className="min-w-0 flex-1 text-right break-words text-foreground">
        {value}
      </span>
    </div>
  )

  // Module bays resolve with `kind: null` too, so the MARKER's kind is what
  // separates them from hardware: a bay reads occupied/empty, not health.
  const bay = !!fp?.id && selection.portKind === "module-bay"
  // Hardware markers (inventory items) resolve with a status, never a
  // termination kind - the card shows part health, not cabling.
  const hardware = !!fp?.id && !bay && fp.kind === null
  // State chip, tinted like every other badge (bg = color at ~15%, text =
  // color). Hardware wears its status colour; bays their occupancy; ports
  // their cabling state.
  const chip = fp
    ? bay
      ? {
          label: fp.module ? "installed" : "empty",
          color: bayHex(!!fp.module),
        }
      : hardware
        ? {
            label: fp.status?.name || "part",
            color: fp.status?.color || "#64748b",
          }
        : fp.connected
          ? { label: "cabled", color: "#10b981" }
          : showReserved && isReserved(fp)
            ? { label: "reserved", color: PORT_RESERVED }
            : fp.id
              ? { label: "free", color: "#71717a" }
              : { label: "no port", color: "#71717a" }
    : null
  return (
    <div
      role="group"
      aria-label={`Port ${fp?.name || portLabel}`}
      className={cn(
        "absolute top-3 left-3 w-72 rounded-lg border border-border bg-popover/95 p-3 text-popover-foreground shadow-lg backdrop-blur",
        preview && "pointer-events-none",
        className
      )}
    >
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 font-mono text-[13px] font-semibold break-words">
          {fp?.name || portLabel}
        </span>
        {chip && (
          <span
            className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium"
            style={{
              backgroundColor: `${chip.color}26`,
              color: chip.color,
            }}
          >
            {chip.label}
          </span>
        )}
      </div>
      <div className="mt-1.5 grid gap-1 text-[12px] text-muted-foreground">
        {row("Device", <span className="font-mono">{device.name}</span>)}
        {selection.portKind &&
          row(
            "Kind",
            <span className="capitalize">
              {selection.portKind.replace(/-/g, " ")}
            </span>
          )}
        {row("Position", position)}
        {fp?.speed && row("Speed", <span className="num">{fp.speed}</span>)}
        {bay &&
          row(
            "Module",
            fp.module ? (
              <span className="font-mono">{fp.module.module_type.name}</span>
            ) : (
              "Empty"
            )
          )}
        {bay &&
          fp.module?.serial_number &&
          row(
            "Serial",
            <span className="font-mono">{fp.module.serial_number}</span>
          )}
      </div>

      {/* ── Drift: what SNMP saw, beside what the record says ──────────── */}
      {fp?.drift && (
        <div className="mt-2 flex items-start gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-[11px] text-amber-700 dark:text-amber-300">
          <TriangleAlert className="mt-px h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 flex-1 break-words">
            {fp.drift}
            <span className="mt-0.5 block text-muted-foreground">
              Review it on the device's Monitoring tab - nothing changes until
              you accept it.
            </span>
          </span>
        </div>
      )}

      {/* ── Cabled: the run + its far end ─────────────────────────────── */}
      {fp?.connected && (
        <div className="mt-2 grid gap-1 rounded-md border border-border bg-muted/30 p-2 text-[12px] text-muted-foreground">
          {cable.isLoading && <Loading className="min-h-12" />}
          {cable.data && (
            <>
              <div className="flex items-center gap-1.5">
                {cable.data.color && (
                  <span
                    className="h-2 w-2 shrink-0 rounded-full"
                    style={{ backgroundColor: cable.data.color }}
                  />
                )}
                <span className="min-w-0 flex-1 font-mono break-words text-foreground">
                  {cable.data.label || `Cable #${cable.data.numid ?? ""}`}
                </span>
                {cable.data.type_display && (
                  <span className="shrink-0 text-[10px]">
                    {cable.data.type_display}
                  </span>
                )}
              </div>
              {farEnds.length > 0 ? (
                farEnds.map((t) => (
                  <div key={t.id} className="flex items-baseline gap-1.5">
                    <span className="shrink-0">→</span>
                    <Link
                      to="/devices/$id"
                      params={{ id: t.device.id }}
                      className="link min-w-0 flex-1 font-mono break-words text-foreground"
                    >
                      {t.device.name}
                      <span className="text-muted-foreground">:</span>
                      {t.name}
                    </Link>
                  </div>
                ))
              ) : (
                <span>Far end unterminated.</span>
              )}
              {cable.data.length && (
                <span className="num text-[11px]">
                  {cable.data.length} {cable.data.length_unit}
                </span>
              )}
            </>
          )}
          {cable.data && act && (
            <div className="mt-1 flex gap-1.5">
              <OpenLink
                to="/cables/$id"
                params={{ id: cable.data.id }}
                className="flex-1"
              >
                Open cable
              </OpenLink>
              {planId && (
                <BarButton asChild className="flex-1">
                  {/* Same route, ?trace= - the room draws the run as a
                      marching line (and 2D uses the identical param). */}
                  <Link
                    to="/floorplans/$id"
                    params={{ id: planId }}
                    search={{ viz: "3d" as const, trace: cable.data.id }}
                  >
                    Trace run
                  </Link>
                </BarButton>
              )}
            </div>
          )}
        </div>
      )}

      {/* ── Free PORT: the connect flow (hardware parts can't cable) ───── */}
      {fp && !fp.connected && fp.id && fp.kind && onConnect && act && (
        <>
          {choosing ? (
            <div className="mt-2 grid gap-1.5">
              <p className="text-[11px] text-muted-foreground">
                Connect this port…
              </p>
              <Button
                size="sm"
                className="h-7 w-full"
                onClick={() => {
                  setChoosing(false)
                  onConnect("3d")
                }}
              >
                Pick the other end in 3D
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-7 w-full"
                onClick={() => {
                  setChoosing(false)
                  onConnect("maker")
                }}
              >
                Use the cable maker
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-6 w-full"
                onClick={() => setChoosing(false)}
              >
                Cancel
              </Button>
            </div>
          ) : (
            <Button
              size="sm"
              className="mt-2 h-7 w-full"
              onClick={() => setChoosing(true)}
            >
              Connect cable
            </Button>
          )}
        </>
      )}
      {/* ── Empty BAY: seat a module right here (2D-faceplate parity) ──── */}
      {fp && bay && !fp.module && canEditParts && onInstall && act && (
        <Button
          size="sm"
          className="mt-2 h-7 w-full"
          onClick={() => fp.id && onInstall({ id: fp.id, name: fp.name })}
        >
          Install module
        </Button>
      )}
      {/* ── Hardware part: the same editor the 2D faceplate opens ──────── */}
      {fp && hardware && canEditParts && onEditPart && act && (
        <Button
          size="sm"
          className="mt-2 h-7 w-full"
          onClick={() => fp.id && onEditPart({ id: fp.id, name: fp.name })}
        >
          Edit part
        </Button>
      )}
      {fp && !fp.id && (
        <p className="mt-2 text-[11px] text-muted-foreground">
          No matching component on this device - add the interface (or fix the
          marker name) to cable it.
        </p>
      )}

      {act && (
        <OpenLink
          to="/devices/$id"
          params={{ id: device.id }}
          className="mt-1.5 w-full"
        >
          Open device
        </OpenLink>
      )}
    </div>
  )
}
