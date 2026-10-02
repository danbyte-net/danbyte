import { useEffect, useState } from "react"
import { useQuery } from "@tanstack/react-query"

import { api } from "@/lib/api"
import type { Device, Rack } from "@/lib/api"
import { OPENING_MM, PANEL_MM } from "@/lib/faceplate-geometry"
import {
  fmtUnits,
  placeInRack,
  rackClash,
  unitRange,
  unitRow,
} from "@/lib/rack-placement"
import type { RackMount, RackSpot } from "@/lib/rack-placement"
import { useContentWidth } from "@/lib/use-content-width"
import { cn } from "@/lib/utils"
import { Loading } from "@/components/loading"
import { QueryError } from "@/components/query-error"
import { RackElevation } from "@/components/rack-elevation"
import type { RackFace } from "@/components/rack-elevation"

// The device form's rack half draws the picked rack under its fields: both
// faces side by side with the devices in them, and this device as an
// outline over its units - red where it collides, by the server's rules. A
// click on a free unit puts the device there, on the face clicked; the
// Position and Face fields follow, as the outline follows them.

/** The faces' scale, px per mm: as large as two fit the column, within. */
const MIN_SCALE = 0.32
const MAX_SCALE = 0.45
/** Around each face's unit grid: the unit-number gutter (40), the frame's
 * padding and border (14); and the gap between the faces, in px. */
const FACE_CHROME_PX = 54
const FACE_GAP_PX = 12
/** How long a refused click explains itself. */
const NOTE_MS = 3000

const FACES: RackFace[] = ["front", "rear"]
const FACE_LABEL: Record<RackFace, string> = { front: "Front", rear: "Rear" }

interface Note {
  text: string
  bad?: boolean
}

/** What a press on a unit does: put the device's lowest unit at
 * `position`, or say why it can't. */
type Aim = { position: number } | { note: Note }

export function RackPlacement({
  rackId,
  devices,
  deviceId,
  name,
  position,
  face,
  mount,
  onPlace,
}: {
  rackId: string
  /** The devices in the rack; undefined while they load. The one being
   * edited, `deviceId`, is the outline instead. */
  devices: Device[] | undefined
  deviceId?: string
  /** Written in the outline. */
  name: string
  /** The position as picked; "" while unracked. */
  position: string
  face: "" | "front" | "rear"
  /** Width, half and height of the device - its face is the one clicked. */
  mount: Omit<RackMount, "face"> & { height: number }
  onPlace: (position: number, face: RackFace) => void
}) {
  const rack = useQuery({
    queryKey: ["rack", rackId],
    queryFn: () => api<Rack>(`/api/racks/${rackId}/`),
  })
  const [box, setBox] = useState<HTMLDivElement | null>(null)
  const boxWidth = useContentWidth(box)
  const [hover, setHover] = useState<{ face: RackFace; unit: number } | null>(
    null
  )
  const [note, setNote] = useState<Note | null>(null)
  useEffect(() => {
    if (!note) return
    const t = setTimeout(() => setNote(null), NOTE_MS)
    return () => clearTimeout(t)
  }, [note])

  const r = rack.data?.id === rackId ? rack.data : undefined
  const occupants = devices ?? []
  const at = position.trim() === "" ? NaN : Number(position)
  const spot: RackSpot | null = Number.isFinite(at)
    ? { ...mount, face, position: at }
    : null
  const clash = r && spot ? rackClash(r, occupants, spot, deviceId) : null

  /** What a press on a unit of a face does. */
  const aim = (f: RackFace, unit: number): Aim | null => {
    if (!r) return null
    const placed = placeInRack(
      r,
      occupants,
      { ...mount, face: f },
      unit,
      deviceId
    )
    if ("position" in placed) return { position: placed.position }
    if ("blocker" in placed)
      return { note: { text: `Taken by ${placed.blocker.name}` } }
    return { note: { text: `Only ${placed.free}U free here`, bad: true } }
  }

  const status: Note | null =
    note ??
    (() => {
      if (!hover) return null
      const a = aim(hover.face, hover.unit)
      if (!a) return null
      return "position" in a
        ? {
            text: `${fmtUnits(a.position, mount.height)} · ${FACE_LABEL[hover.face]}`,
          }
        : a.note
    })() ??
    (clash ? { text: clash.message, bad: true } : null)

  // As the elevation reads the rack's opening; a width it does not know
  // draws at 19 inches.
  const opening: number | undefined = r ? OPENING_MM[r.width] : undefined
  const fit =
    (boxWidth - 2 * FACE_CHROME_PX - FACE_GAP_PX) /
    (2 * (opening ?? PANEL_MM.opening))
  const scale = Math.min(
    MAX_SCALE,
    Math.max(MIN_SCALE, Math.floor(fit * 100) / 100)
  )
  const column =
    mount.width === "half" ? (mount.side === "right" ? "2" : "1") : "1 / -1"

  // Keep the outline in view when the fields move it, or the faces resize.
  useEffect(() => {
    const el = box?.querySelector<HTMLElement>("[data-part=placement]")
    if (!box || !el) return
    const b = box.getBoundingClientRect()
    const o = el.getBoundingClientRect()
    if (o.top >= b.top && o.bottom <= b.bottom) return
    box.scrollTop += o.top - b.top - (box.clientHeight - o.height) / 2
  }, [box, r, position, face, scale])

  /** The device's outline on face `f`, and its colliding units in red. */
  const outline = (f: RackFace) => {
    if (!r || !spot || (spot.face && spot.face !== f)) return null
    const [first, last] = unitRange(r)
    const lo = Math.max(spot.position, first)
    const hi = Math.min(spot.position + spot.height - 1, last)
    if (lo > hi) return null
    return (
      <>
        <div
          data-part="placement"
          data-clash={clash ? "" : undefined}
          className={cn(
            // Opaque, so the unit numbers under it don't show through.
            "pointer-events-none relative z-20 m-px flex items-center gap-2 overflow-hidden rounded-sm border-2 bg-card px-2 text-[11px] font-medium",
            clash
              ? "border-destructive text-destructive"
              : "border-primary text-foreground"
          )}
          style={{
            gridRow: `${unitRow(r, r.desc_units ? lo : hi)} / span ${hi - lo + 1}`,
            gridColumn: column,
          }}
        >
          <span
            aria-hidden
            className={cn(
              "absolute inset-0",
              clash ? "bg-destructive/10" : "bg-primary/15"
            )}
          />
          <span
            className={cn(
              "relative w-6 shrink-0 text-right font-mono text-[10px] tabular-nums",
              !clash && "text-muted-foreground"
            )}
          >
            {spot.position}
          </span>
          <span className="relative truncate">{name}</span>
        </div>
        {clash?.units.map((u) => (
          <div
            key={u}
            data-part="clash"
            className="pointer-events-none z-20 m-px rounded-sm bg-destructive/30"
            style={{ gridRow: unitRow(r, u), gridColumn: column }}
          />
        ))}
      </>
    )
  }

  /** Where a click on the unit under the pointer would put the device. */
  const preview = (f: RackFace) => {
    if (!r || hover?.face !== f) return null
    const a = aim(f, hover.unit)
    if (!a) return null
    if (!("position" in a))
      return (
        <div
          data-part="ghost"
          data-bad=""
          className="pointer-events-none z-20 bg-destructive/10"
          style={{ gridRow: unitRow(r, hover.unit), gridColumn: column }}
        />
      )
    const top = r.desc_units ? a.position : a.position + mount.height - 1
    return (
      <div
        data-part="ghost"
        className="pointer-events-none z-20 m-px rounded-sm border border-dashed border-primary/70 bg-primary/10"
        style={{
          gridRow: `${unitRow(r, top)} / span ${mount.height}`,
          gridColumn: column,
        }}
      />
    )
  }

  const click = (f: RackFace, unit: number) => {
    const a = aim(f, unit)
    if (!a) return
    if ("position" in a) {
      setNote(null)
      onPlace(a.position, f)
    } else {
      setNote(a.note)
    }
  }

  return (
    <div className="grid min-w-0 gap-1">
      <div ref={setBox} className="isolate max-h-96 overflow-auto">
        {rack.isError ? (
          <QueryError error={rack.error} />
        ) : !r ? (
          <Loading />
        ) : (
          <div className="flex w-fit gap-3">
            {FACES.map((f) => (
              <div key={f} data-face={f} className="min-w-0">
                <div className="sticky top-0 z-30 bg-card pb-1 text-[10px] font-semibold tracking-[0.08em] whitespace-nowrap text-muted-foreground uppercase">
                  {FACE_LABEL[f]}
                </div>
                <RackElevation
                  rack={r}
                  face={f}
                  mode="names"
                  showHeader={false}
                  scale={scale}
                  picker={{
                    exclude: deviceId,
                    onUnit: (unit) => click(f, unit),
                    onHover: (unit) =>
                      setHover(unit == null ? null : { face: f, unit }),
                    overlay: (
                      <>
                        {preview(f)}
                        {outline(f)}
                      </>
                    ),
                  }}
                />
              </div>
            ))}
          </div>
        )}
      </div>
      <p
        data-part="status"
        className={cn(
          "h-4 truncate text-[10px] leading-4",
          status?.bad ? "text-destructive" : "text-muted-foreground"
        )}
      >
        {status?.text ?? "\u00a0"}
      </p>
    </div>
  )
}
