import { useEffect, useRef, useState } from "react"
import type {
  KeyboardEvent,
  MouseEvent,
  PointerEvent,
  ReactNode,
  RefObject,
} from "react"

import type { Cabinet, Device, DeviceTypeMini, DinRail } from "@/lib/api"
import {
  PROFILE_HEIGHT_MM,
  PROFILE_LABELS,
  SNAP_MM,
  adjacentRail,
  centreIn,
  clashSpans,
  deviceBody,
  firstFit,
  fittingGaps,
  fmtGaps,
  fmtMm,
  freeGaps,
  mountsOn,
  nearestRail,
  placeOnRail,
  railAtPoint,
  railClash,
  railNeighbours,
  roundMm,
  snapFlush,
} from "@/lib/din-geometry"
import type { RailNeighbour } from "@/lib/din-geometry"
import { cn } from "@/lib/utils"
import { CabinetDeviceBodies, nameLayout } from "@/components/cabinet-devices"
import type { BodyLook, BodyMark } from "@/components/cabinet-devices"
import { RailSlider } from "@/components/cabinet-rail-slider"
import {
  CabinetElevation,
  toPlateMm,
  usePlatePx,
} from "@/components/cabinet-elevation"

// A cabinet's plate as a place to put a device (#277): its rails, the
// devices on them, and the device being placed as an outline at its rail
// and offset. A click on a rail puts it there, a double click centres it in
// the gap, a drag moves it along a rail or onto another, the arrow keys
// nudge it; under the plate the offset is a slider along the rail too. The
// device form draws it under its fields, and the cabinet page's arrange
// mode for the device it has picked.

/** What the drawing sizes the device by, and the rails it mounts on. */
export type PlacedType = Pick<
  DeviceTypeMini,
  "name" | "din_profiles" | "width_mm" | "height_mm" | "din_rail_mm"
>

/** The line under the plate: where a press puts the device, or why not. */
export interface PlateNote {
  text: string
  bad?: boolean
}

/** Where the device is drawn: a rail and an offset, `provisional` while the
 * offset is blank and the device shows in the first gap it fits. */
export interface Spot {
  rail: DinRail
  offset: number
  provisional?: boolean
}

/** The device being placed. `id` names it among the plate's bodies when it
 * is one of them - the arrange mode's pick, drawn as itself under the
 * outline; the device form's is not. */
export interface PlateSubject {
  id?: string
  type: PlacedType | undefined
  name: string
  spot: Spot | null
}

/** A press on a free stretch of a rail with nothing being placed: where on
 * the rail, and where on the screen, for a menu there. */
export interface FreeSpot {
  rail: DinRail
  offset: number
  x: number
  y: number
}

/** A spot a press would take - `bad` where the device does not fit. */
type Ghost = Spot & { bad?: boolean }

/** What a press at a point on the plate does: put the device `to` a spot
 * (or, with no type yet, just on a rail), pick a `body`, offer a `free`
 * stretch, or `clear` the pick - and what the line under the plate says. */
interface Aim {
  to?: Spot | { rail: DinRail; offset: null }
  body?: string
  free?: { rail: DinRail; offset: number }
  clear?: boolean
  ghost?: Ghost
  note?: PlateNote
}

/** Screen pixels a press travels before it drags, so a click never nudges. */
const DRAG_SLOP_PX = 3
/** A small drawing snaps from this many screen pixels, even past SNAP_MM. */
const SNAP_PX = 6
/** How long a refused click or drop explains itself. */
const NOTE_MS = 3000

const NOT_DIN = "Give the device a type that mounts on DIN rails."

/** Why a device of `type` can't go on a rail, in the server's words; null
 * where it can, or while the type is unknown. */
export function railRefusal(
  type: PlacedType | null | undefined,
  rail: Pick<DinRail, "profile">
): string | null {
  if (!type) return null
  if (type.width_mm == null || type.din_profiles.length === 0) return NOT_DIN
  return mountsOn(type, rail.profile)
    ? null
    : `${type.name} does not mount on a ${PROFILE_LABELS[rail.profile]} rail.`
}

/** The device form's cabinet half: the picked cabinet's plate under its
 * fields, the device at the rail and offset they hold - in the first gap it
 * fits while the offset is blank, where the server will put it. */
export function CabinetPlacement({
  cabinet,
  devices,
  deviceId,
  type,
  name,
  railId,
  offset,
  onPlace,
}: {
  cabinet: Cabinet
  /** The devices in the cabinet; undefined while they load. The one being
   * edited, `deviceId`, is the outline instead. */
  devices: Device[] | undefined
  deviceId?: string
  /** The device's type; undefined until one is picked. */
  type: PlacedType | undefined
  /** Written in the outline. */
  name: string
  railId: string | null
  /** The offset as typed: null while blank, NaN while it does not parse. */
  offset: number | null
  /** A click, drag or key put the device here. */
  onPlace: (railId: string, offset: number | null) => void
}) {
  const others = (devices ?? []).filter((d) => d.id !== deviceId)
  const near = (id: string) => railNeighbours(others, id)
  const width = type?.width_mm ?? null

  const rail = cabinet.rails.find((r) => r.id === railId) ?? null
  const gaps = rail ? freeGaps(rail.length_mm, spans(near(rail.id))) : []
  let spot: Spot | null = null
  let standing: PlateNote | null = null
  /** The picked rail has no gap the device fits in: drawn red. */
  let full = false
  if (rail && devices) {
    const refused = railRefusal(type, rail)
    const at =
      width == null
        ? null
        : offset == null
          ? firstFit(gaps, width)
          : Number.isFinite(offset)
            ? offset
            : null
    if (at != null) spot = { rail, offset: at, provisional: offset == null }
    full = !refused && width != null && offset == null && at == null
    const clash =
      refused ??
      (spot && width != null
        ? railClash(spot.offset, width, rail.length_mm, near(rail.id))
        : null) ??
      (full ? "No gap fits" : null)
    standing = clash
      ? { text: clash, bad: true }
      : { text: gaps.length ? `Free ${fmtGaps(gaps)}` : "Rail full" }
  }

  return (
    <PlatePlacer
      cabinet={cabinet}
      bodies={others}
      subject={{ type, name, spot }}
      near={near}
      standing={standing}
      fullRail={full ? railId : null}
      ready={!!devices}
      frame="rounded-md border border-border/60 bg-muted/20 p-2"
      elevationClassName="max-h-96"
      onPlace={onPlace}
    />
  )
}

/**
 * The plate as a place to put one device - the device form's, or the one
 * the cabinet page's arrange mode has picked: the rails and `bodies`, the
 * subject as an outline that clicks, drags and keys move, a slider along
 * its rail, and a line saying where things go or why they can't. The
 * subject's moves come out through `onPlace`; the arrange mode's presses on
 * the bodies and on free stretches through `onBody` and `onFree`.
 */
export function PlatePlacer({
  cabinet,
  bodies,
  marks,
  subject,
  near,
  standing,
  fullRail = null,
  ready = true,
  box = false,
  frame,
  elevationClassName,
  pxPerMm,
  look,
  names,
  railTags,
  onPlace,
  onBody,
  onFree,
}: {
  cabinet: Pick<
    Cabinet,
    | "inner_width_mm"
    | "inner_height_mm"
    | "outer_width_mm"
    | "outer_height_mm"
    | "rails"
  >
  /** The devices drawn on the rails, where they are to go. */
  bodies: Device[]
  /** Bodies drawn moved or clashing - the arrange mode's pending moves. */
  marks?: Record<string, BodyMark>
  /** The device being placed; null for none. */
  subject: PlateSubject | null
  /** The devices on a rail beside the subject. */
  near: (railId: string) => RailNeighbour[]
  /** The line's text while nothing under the pointer speaks. */
  standing: PlateNote | null
  /** A rail with no gap the subject fits in, drawn red. */
  fullRail?: string | null
  /** The bodies are in: presses, the outline and the slider work. */
  ready?: boolean
  /** Draw the cabinet's box around the plate, as its page does. */
  box?: boolean
  /** Classes for a frame around the drawing. */
  frame?: string
  elevationClassName?: string
  /** The drawing's zoom, as the cabinet page has it; fills the column
   * without. */
  pxPerMm?: number
  /** How the bodies are drawn - photos or role colours - and whether they
   * and the rails carry their labels, as the cabinet page has it. */
  look?: BodyLook
  names?: boolean
  railTags?: boolean
  onPlace: (railId: string, offset: number | null) => void
  /** A press on a body picks it; a press off every rail drops the pick. */
  onBody?: (deviceId: string | null) => void
  /** A press on a free stretch with nothing being placed. */
  onFree?: (at: FreeSpot) => void
}) {
  const [live, setLive] = useState<PlateNote | null>(null)
  const [note, setNote] = useState<PlateNote | null>(null)
  // A drag in progress, on the plate or the slider: drawn in both, put in
  // place when it is let go.
  const [dragged, setDragged] = useState<Spot | null>(null)
  // A device just picked or put down takes the focus to its outline, so
  // the arrow keys move it on from there.
  const focusOutline = useRef(false)
  useEffect(() => {
    if (!note) return
    const t = setTimeout(() => setNote(null), NOTE_MS)
    return () => clearTimeout(t)
  }, [note])

  const type = subject?.type
  const width = type?.width_mm ?? null
  const refusal = (r: DinRail) => railRefusal(type, r)
  const spot = subject?.spot ?? null
  const shown = dragged ?? spot

  // While a drag is on, the line follows it: where it is, or what it hits.
  let status: PlateNote | null = note ?? live ?? standing
  if (dragged && width != null) {
    const hit = railClash(
      dragged.offset,
      width,
      dragged.rail.length_mm,
      near(dragged.rail.id)
    )
    status = hit
      ? { text: hit, bad: true }
      : { text: `${dragged.rail.label} · ${fmtMm(dragged.offset)} mm` }
  }

  /** A drag let go at `to`: into the gap under the device's middle, as a
   * click there would put it - or refused, where that gap can't hold it. */
  const settle = (to: Spot, tolerance: number) => {
    if (width == null) return
    const neighbours = near(to.rail.id)
    const placed = placeOnRail(
      to.offset,
      width,
      to.rail.length_mm,
      spans(neighbours),
      { anchor: to.offset + width / 2, tolerance }
    )
    if ("offset" in placed) {
      setNote(null)
      onPlace(to.rail.id, placed.offset)
      return
    }
    if ("taken" in placed) {
      const on = neighbours.find((n) => n.span === placed.taken)
      if (on) setNote({ text: `Taken by ${on.name}`, bad: true })
      return
    }
    const [start, end] = placed.narrow
    setNote({ text: `Only ${fmtMm(end - start)} mm free here`, bad: true })
  }

  // The subject drawn as itself moves with its drag; one that is not among
  // the bodies keeps the rail labels off its spot instead.
  const subjectId = subject?.id
  const drawsSubject = !!subjectId && bodies.some((d) => d.id === subjectId)
  const drawnBodies =
    drawsSubject && dragged
      ? bodies.map((d) =>
          d.id === subjectId
            ? {
                ...d,
                din_rail: {
                  id: dragged.rail.id,
                  label: dragged.rail.label,
                  profile: dragged.rail.profile,
                },
                din_offset_mm: dragged.offset,
              }
            : d
        )
      : bodies

  // The slider runs along the rail the device is drawn on, while it fits.
  const slide =
    ready &&
    shown &&
    width != null &&
    !refusal(shown.rail) &&
    shown.rail.length_mm >= width
      ? shown
      : null
  const drawn = cabinet.rails.map((r) => ({
    ...r,
    key: r.id,
    dimmed: !!refusal(r),
    invalid: r.id === fullRail,
  }))

  return (
    <div className="grid min-w-0 gap-1">
      <div className={frame}>
        <CabinetElevation
          width={cabinet.inner_width_mm}
          height={cabinet.inner_height_mm}
          outerWidth={box ? cabinet.outer_width_mm : null}
          outerHeight={box ? cabinet.outer_height_mm : null}
          rails={drawn}
          railLabels={false}
          emptyText="No rails."
          pxPerMm={pxPerMm}
          className={elevationClassName}
        >
          <CabinetDeviceBodies
            rails={drawn}
            devices={drawnBodies}
            look={look}
            names={names}
            railTags={railTags}
            interactive={false}
            marks={marks}
            onPick={
              onBody
                ? (d) => {
                    focusOutline.current = true
                    onBody(d.id)
                  }
                : undefined
            }
            keepClear={
              !drawsSubject && spot && width != null
                ? [
                    {
                      railId: spot.rail.id,
                      span: [spot.offset, spot.offset + width],
                    },
                  ]
                : []
            }
          />
          {ready && (
            <PlacementLayer
              plate={{
                width: cabinet.inner_width_mm,
                height: cabinet.inner_height_mm,
              }}
              rails={cabinet.rails}
              refusal={refusal}
              near={near}
              bodies={drawnBodies}
              type={type}
              name={subject?.name ?? ""}
              nameOnOutline={!drawsSubject}
              spot={spot}
              dragged={dragged}
              onDrag={setDragged}
              onSettle={settle}
              onPlace={onPlace}
              onBody={onBody}
              onFree={onFree}
              onLive={setLive}
              onNote={setNote}
              focusOutline={focusOutline}
            />
          )}
        </CabinetElevation>
      </div>
      {slide && width != null && (
        <RailSlider
          rail={slide.rail}
          width={width}
          neighbours={near(slide.rail.id)}
          offset={slide.offset}
          clash={
            !!railClash(
              slide.offset,
              width,
              slide.rail.length_mm,
              near(slide.rail.id)
            )
          }
          onPreview={(at) =>
            setDragged(at == null ? null : { rail: slide.rail, offset: at })
          }
          onSettle={(at, tolerance) =>
            settle({ rail: slide.rail, offset: at }, tolerance)
          }
          onPlace={(at) => {
            setNote(null)
            onPlace(slide.rail.id, at)
          }}
        />
      )}
      <div className="flex items-baseline gap-3 text-[10px] leading-4">
        <p
          data-part="status"
          className={cn(
            "h-4 min-w-0 flex-1 truncate",
            status?.bad ? "text-destructive" : "text-muted-foreground"
          )}
        >
          {status?.text ?? " "}
        </p>
        {shown && width != null && (
          <span
            data-part="edges"
            className="shrink-0 whitespace-nowrap text-muted-foreground tabular-nums"
          >
            {fmtMm(shown.offset)}–{fmtMm(shown.offset + width)} mm
          </span>
        )}
      </div>
    </div>
  )
}

const spans = (neighbours: RailNeighbour[]) => neighbours.map((n) => n.span)

/** The device's body on a rail, as the plate draws devices; a type with no
 * height takes the rail's band. */
function bodyOn(r: DinRail, offset: number, type: PlacedType | undefined) {
  if (type?.width_mm == null) return null
  return deviceBody(r, offset, {
    width_mm: type.width_mm,
    height_mm: type.height_mm ?? PROFILE_HEIGHT_MM[r.profile],
    din_rail_mm: type.height_mm == null ? null : type.din_rail_mm,
  })
}

/** Over the plate, in its millimetres: the press target, the spot a click
 * would take, and the outline of the device being placed. */
function PlacementLayer({
  plate,
  rails,
  refusal,
  near,
  bodies,
  type,
  name,
  nameOnOutline,
  spot,
  dragged,
  onDrag,
  onSettle,
  onPlace,
  onBody,
  onFree,
  onLive,
  onNote,
  focusOutline,
}: {
  plate: { width: number; height: number }
  rails: DinRail[]
  refusal: (r: DinRail) => string | null
  near: (railId: string) => RailNeighbour[]
  /** The bodies drawn, for picking one with `onBody`. */
  bodies: Device[]
  type: PlacedType | undefined
  /** The device's name: the outline's label. */
  name: string
  /** Write the name in the outline - not over a body that writes its own. */
  nameOnOutline: boolean
  spot: Spot | null
  /** A drag in progress - this outline's, or the slider's. */
  dragged: Spot | null
  onDrag: (to: Spot | null) => void
  /** This outline's drag let go here. */
  onSettle: (to: Spot, tolerance: number) => void
  onPlace: (railId: string, offset: number | null) => void
  onBody?: (deviceId: string | null) => void
  onFree?: (at: FreeSpot) => void
  /** What the pointer is over, while it is. */
  onLive: (n: PlateNote | null) => void
  /** Why a click or a drop did nothing, for a while; null clears it. */
  onNote: (n: PlateNote | null) => void
  /** Set to have the outline take the focus once it is drawn. */
  focusOutline: RefObject<boolean>
}) {
  const px = usePlatePx()
  const tolerance = Math.max(SNAP_MM, px(SNAP_PX))
  const width = type?.width_mm ?? null
  const open = rails.filter((r) => !refusal(r))
  const shut = rails.filter((r) => refusal(r))
  // A press on the plate takes the rail whose band - or the body the device
  // would hang from it - is under the pointer.
  const height = type?.height_mm ?? 0
  const railAt = type?.din_rail_mm ?? height / 2
  const reach = { above: railAt, below: height - railAt }
  const railById = new Map(rails.map((r) => [r.id, r]))

  const [ghost, setGhost] = useState<Ghost | null>(null)
  const [cursor, setCursor] = useState("default")
  // The line follows the pointer only as far as it changes what it says.
  const lastLive = useRef<string | null>(null)
  const say = (n: PlateNote | null) => {
    const key = n ? `${n.bad ? "!" : ""}${n.text}` : null
    if (key === lastLive.current) return
    lastLive.current = key
    onLive(n)
  }
  const refuse = (n: PlateNote) => {
    say(null)
    onNote(n)
  }

  const drag = useRef<{
    pointerId: number
    client: { x: number; y: number }
    /** Where the press landed on the device: from its left edge across,
     * from the rail's centreline down. */
    grab: { x: number; y: number }
    moved: boolean
    to: Spot | null
  } | null>(null)

  /** The body under a point, the topmost first. */
  const bodyAt = (x: number, y: number): Device | undefined =>
    [...bodies].reverse().find((d) => {
      const r = d.din_rail ? railById.get(d.din_rail.id) : undefined
      const b = r ? deviceBody(r, d.din_offset_mm, d.device_type) : null
      return (
        !!b && x >= b.x && x <= b.x + b.width && y >= b.y && y <= b.y + b.height
      )
    })

  const aim = (x: number, y: number): Aim => {
    if (onBody) {
      const d = bodyAt(x, y)
      if (d) return { body: d.id, note: { text: d.name } }
    }
    const r = railAtPoint(open, x, y, reach)
    if (!r) {
      const off = railAtPoint(shut, x, y)
      const why = off && refusal(off)
      if (why) return { note: { text: why, bad: true } }
      return onBody ? { clear: true } : {}
    }
    if (width == null) {
      // Nothing being placed: a press offers the spot.
      if (onFree) {
        const offset = Math.round(
          Math.min(Math.max(x - r.x_mm, 0), r.length_mm)
        )
        return {
          free: { rail: r, offset },
          note: { text: `${r.label} · ${fmtMm(offset)} mm` },
        }
      }
      // No type yet: a press picks the rail, and the server the gap.
      return { to: { rail: r, offset: null }, note: { text: r.label } }
    }
    const neighbours = near(r.id)
    const placed = placeOnRail(
      x - r.x_mm,
      width,
      r.length_mm,
      spans(neighbours),
      { tolerance }
    )
    if ("offset" in placed) {
      const to = { rail: r, offset: placed.offset }
      return {
        to,
        ghost: to,
        note: { text: `${r.label} · ${fmtMm(placed.offset)} mm` },
      }
    }
    if ("taken" in placed) {
      const on = neighbours.find((n) => n.span === placed.taken)
      return on ? { note: { text: `Taken by ${on.name}` } } : {}
    }
    const [start, end] = placed.narrow
    return {
      ghost: { rail: r, offset: start, bad: true },
      note: { text: `Only ${fmtMm(end - start)} mm free here`, bad: true },
    }
  }

  const sameGhost = (a: Ghost | null, b: Ghost | null) =>
    a === b ||
    (!!a &&
      !!b &&
      a.rail.id === b.rail.id &&
      a.offset === b.offset &&
      !!a.bad === !!b.bad)

  const hover = (e: PointerEvent<SVGRectElement>) => {
    if (drag.current) return
    const at = toPlateMm(e.currentTarget.ownerSVGElement, e)
    if (!at) return
    const a = aim(at.x, at.y)
    const next = a.ghost ?? null
    setGhost((g) => (sameGhost(g, next) ? g : next))
    setCursor(
      a.to || a.body || a.free
        ? "pointer"
        : a.note?.bad
          ? "not-allowed"
          : "default"
    )
    say(a.note ?? null)
  }

  const leave = () => {
    setGhost(null)
    say(null)
  }

  // Focus the outline after a click puts it down, so the arrow keys move it
  // on from there.
  const outline = useRef<SVGGElement>(null)
  useEffect(() => {
    if (!focusOutline.current || !outline.current) return
    focusOutline.current = false
    outline.current.focus({ preventScroll: true })
  })

  const click = (e: MouseEvent<SVGRectElement>) => {
    const at = toPlateMm(e.currentTarget.ownerSVGElement, e)
    if (!at) return
    const a = aim(at.x, at.y)
    if (a.body) {
      setGhost(null)
      focusOutline.current = true
      onBody?.(a.body)
    } else if (a.free) {
      onFree?.({ ...a.free, x: e.clientX, y: e.clientY })
    } else if (a.to) {
      setGhost(null)
      say(null)
      onNote(null)
      focusOutline.current = true
      onPlace(a.to.rail.id, a.to.offset)
    } else if (a.clear) {
      onBody?.(null)
    } else if (a.note) {
      refuse(a.note)
    }
  }

  // ── dragging the outline ──────────────────────────────────────────────
  const startDrag = (e: PointerEvent<SVGGElement>) => {
    if (e.button !== 0 || !spot || width == null) return
    const at = toPlateMm(e.currentTarget.ownerSVGElement, e)
    if (!at) return
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = {
      pointerId: e.pointerId,
      client: { x: e.clientX, y: e.clientY },
      grab: {
        x: at.x - (spot.rail.x_mm + spot.offset),
        y: at.y - spot.rail.y_mm,
      },
      moved: false,
      to: null,
    }
  }

  const continueDrag = (e: PointerEvent<SVGGElement>) => {
    const d = drag.current
    if (!d || d.pointerId !== e.pointerId || width == null) return
    const travel = Math.hypot(e.clientX - d.client.x, e.clientY - d.client.y)
    if (!d.moved && travel < DRAG_SLOP_PX) return
    const at = toPlateMm(e.currentTarget.ownerSVGElement, e)
    if (!at) return
    const left = at.x - d.grab.x
    // Onto the rail nearest where the device's rail line now is.
    const r = nearestRail(open, left + width / 2, at.y - d.grab.y)
    if (!r) return
    if (!d.moved) onNote(null)
    d.moved = true
    const offset = snapFlush(
      Math.round(left - r.x_mm),
      width,
      r.length_mm,
      spans(near(r.id)),
      tolerance
    )
    if (d.to?.rail.id === r.id && d.to.offset === offset) return
    const to = { rail: r, offset }
    d.to = to
    onDrag(to)
    setGhost(null)
  }

  const endDrag = (e: PointerEvent<SVGGElement>, drop: boolean) => {
    const d = drag.current
    if (!d || d.pointerId !== e.pointerId) return
    drag.current = null
    onDrag(null)
    say(null)
    if (drop && d.moved && d.to) onSettle(d.to, tolerance)
  }

  // A double click on a free gap centres the device in it.
  const centre = (e: MouseEvent<SVGGElement>) => {
    if (width == null) return
    const at = toPlateMm(e.currentTarget.ownerSVGElement, e)
    const r = at && railAtPoint(open, at.x, at.y, reach)
    if (!at || !r) return
    const x = at.x - r.x_mm
    const gap = fittingGaps(
      freeGaps(r.length_mm, spans(near(r.id))),
      width
    ).find(([s, end]) => s <= x && x <= end)
    if (gap) onPlace(r.id, centreIn(gap, width))
  }

  // ── the arrow keys ────────────────────────────────────────────────────
  const nudge = (e: KeyboardEvent<SVGGElement>) => {
    if (e.key === "Escape" && onBody) {
      e.preventDefault()
      onBody(null)
      return
    }
    if (!spot || width == null) return
    const r = spot.rail
    const along = e.key === "ArrowLeft" ? -1 : e.key === "ArrowRight" ? 1 : 0
    const across = e.key === "ArrowUp" ? -1 : e.key === "ArrowDown" ? 1 : 0
    if (!along && !across) return
    e.preventDefault()
    const keep = (to: DinRail, v: number) =>
      roundMm(Math.min(Math.max(v, 0), Math.max(0, to.length_mm - width)))
    if (along) {
      const next = keep(r, spot.offset + along * (e.shiftKey ? 10 : 1))
      if (next !== spot.offset || spot.provisional) onPlace(r.id, next)
      return
    }
    // Up or down a rail, the device kept where it is across the plate.
    const x = r.x_mm + spot.offset
    const to = adjacentRail(open, r, across as -1 | 1, x + width / 2)
    if (to) onPlace(to.id, keep(to, x - to.x_mm))
  }

  const shown = dragged ?? spot
  const body = shown ? bodyOn(shown.rail, shown.offset, type) : null
  const ghostBody =
    ghost && !dragged ? bodyOn(ghost.rail, ghost.offset, type) : null

  let outlineEl: ReactNode = null
  if (shown && body && width != null) {
    const neighbours = near(shown.rail.id)
    const refused = refusal(shown.rail)
    const clash =
      !!refused ||
      !!railClash(shown.offset, width, shown.rail.length_mm, neighbours)
    const red = clashSpans(
      shown.offset,
      width,
      shown.rail.length_mm,
      spans(neighbours)
    )
    const label =
      name && nameOnOutline
        ? nameLayout(name, body.width / px(1), body.height / px(1), false)
        : null
    const cx = body.x + body.width / 2
    const cy = label?.vertical ? body.y + body.height / 2 : body.y + px(8)
    outlineEl = (
      <g
        ref={outline}
        data-part="placement"
        data-rail={shown.rail.label}
        data-clash={clash || undefined}
        data-provisional={shown.provisional || undefined}
        role="slider"
        tabIndex={0}
        aria-label={name || "Device"}
        aria-orientation="horizontal"
        aria-valuemin={0}
        aria-valuemax={Math.max(0, roundMm(shown.rail.length_mm - width))}
        aria-valuenow={shown.offset}
        aria-valuetext={`${shown.rail.label}, ${fmtMm(shown.offset)} mm`}
        className="group/placement cursor-grab touch-none outline-none active:cursor-grabbing"
        onPointerDown={startDrag}
        onPointerMove={continueDrag}
        onPointerUp={(e) => endDrag(e, true)}
        onPointerCancel={(e) => endDrag(e, false)}
        onLostPointerCapture={(e) => endDrag(e, false)}
        onKeyDown={nudge}
      >
        <rect
          data-part="body"
          x={body.x}
          y={body.y}
          width={body.width}
          height={body.height}
          className={
            clash
              ? "fill-destructive/10 stroke-destructive"
              : "fill-primary/15 stroke-primary"
          }
          strokeWidth={2}
          strokeDasharray={shown.provisional ? "5 3" : undefined}
          vectorEffect="non-scaling-stroke"
        />
        {red.map(([s, e]) => (
          <rect
            key={s}
            data-part="clash"
            x={shown.rail.x_mm + s}
            y={body.y}
            width={e - s}
            height={body.height}
            className="fill-destructive/35"
          />
        ))}
        {label && clash && (
          // Over a neighbour, the name keeps a backdrop to stay readable.
          <rect
            x={label.vertical ? cx - px(8) : body.x}
            y={body.y}
            width={label.vertical ? px(16) : body.width}
            height={label.vertical ? body.height : px(16)}
            className="pointer-events-none fill-background/85"
          />
        )}
        {label && (
          <text
            x={cx}
            y={cy}
            transform={label.vertical ? `rotate(90 ${cx} ${cy})` : undefined}
            textAnchor="middle"
            dominantBaseline="central"
            fontSize={px(10)}
            className={cn(
              "pointer-events-none font-medium",
              clash ? "fill-destructive" : "fill-foreground"
            )}
          >
            {label.text}
          </text>
        )}
        {/* The keyboard's focus ring, just outside the body. */}
        <rect
          x={body.x - px(3)}
          y={body.y - px(3)}
          width={body.width + px(6)}
          height={body.height + px(6)}
          rx={px(3)}
          className="pointer-events-none fill-none stroke-ring opacity-0 group-focus-visible/placement:opacity-100"
          strokeWidth={2}
          vectorEffect="non-scaling-stroke"
        />
      </g>
    )
  }

  return (
    <g data-part="placing" onDoubleClick={centre}>
      <rect
        data-part="target"
        x={0}
        y={0}
        width={plate.width}
        height={plate.height}
        fill="transparent"
        style={{ cursor }}
        onPointerMove={hover}
        onPointerLeave={leave}
        onClick={click}
      />
      {ghostBody && ghost && (
        <rect
          data-part="ghost"
          data-bad={ghost.bad || undefined}
          x={ghostBody.x}
          y={ghostBody.y}
          width={ghostBody.width}
          height={ghostBody.height}
          className={cn(
            "pointer-events-none",
            ghost.bad
              ? "fill-destructive/10 stroke-destructive"
              : "fill-primary/10 stroke-primary/70"
          )}
          strokeWidth={1}
          strokeDasharray="4 3"
          vectorEffect="non-scaling-stroke"
        />
      )}
      {outlineEl}
    </g>
  )
}
