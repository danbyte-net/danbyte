import type { ImagePortMarker, ImagePorts } from "@/lib/api"
import {
  normalizePortName,
  OPENING_MM,
  PANEL_MM,
  renderTemplateName,
} from "@/lib/faceplate-geometry"

/**
 * World-space conventions for the 3D room view.
 *
 * Units are METRES (three.js default), Y is up. The floor plan's grid maps
 * cell coordinates → metres via the plan's `cell_mm`; rack/device dimensions
 * come from the same mm constants the 2D elevation and faceplates use, so a
 * rack renders at exactly the proportions its elevation shows.
 */

// ─── Scene payload (GET /api/floor-plans/{id}/scene/) ────────────────────────

export interface SceneDevice {
  id: string
  name: string
  /** Lowest occupied U — null for side-mounted 0U strips. */
  position: number | null
  face: "" | "front" | "rear"
  rack_side: "" | "left" | "right"
  /** Zero-U side mounting (vertical PDU strips); ""/absent = racked. */
  mount?: "" | "side_left" | "side_right"
  mount_offset_mm?: number | null
  mount_span_u?: number | null
  u_height: number
  rack_width: "full" | "half"
  is_full_depth: boolean
  role_color: string
  role_name: string
  device_type: string
  status: { name: string; color: string } | null
  primary_ip: string | null
  serial_number: string
  front_image: string | null
  rear_image: string | null
  has_faceplate: boolean
  /** Photo-anchored port markers (per device type), or null. */
  image_ports: ImagePorts | null
  /** Effective airflow (device override, else type default). Optional so
   * older cached payloads stay type-valid; "" = unknown. */
  airflow?: string
  /** The device's REAL power port / outlet names — what synthetic port quads
   * are laid out from when a component has no photo marker. Optional so older
   * cached payloads stay type-valid. */
  power_ports?: string[]
  power_outlets?: string[]
  /** Phase leg (A/B/C, "" unset) per power port/outlet name — the vertical PDU
   * strip tints each outlet cell by it. Optional for old cached payloads. */
  power_legs?: Record<string, string>
  /** Which redundant feed powers this PDU: "primary" | "redundant" | "". The
   * whole strip tints by it — the A/B story — when no per-outlet leg is set. */
  power_feed_type?: string
}

export interface SceneRack {
  id: string
  name: string
  u_height: number
  starting_unit: number
  desc_units: boolean
  width: number
  outer_width_mm: number | null
  outer_depth_mm: number | null
  devices: SceneDevice[]
}

export interface SceneTile {
  id: string
  x: number
  y: number
  w: number
  h: number
  orientation: number
  status: string
  label: string
  kind: "rack" | "device" | "other"
  color: string
  is_zone: boolean
  rack: SceneRack | null
  /** The tile type's / role's name — labels unlinked planning tiles. */
  type_name?: string
  /** Zone tiles of a perforated type draw as grate floor in 3D. Optional so
   * older cached payloads stay type-valid. */
  perforated?: boolean
}

export interface SceneTray {
  id: string
  name: string
  kind: string
  color: string
  level: "overhead" | "underfloor" | "floor"
  elevation_mm: number | null
  points: [number, number][]
  cable_count: number
}

export interface SceneRaisedFloor {
  id: string
  x: number
  y: number
  w: number
  h: number
  plenum_mm: number
  label: string
  color: string
}

export interface SceneWallOpening {
  seg: number
  from: number
  to: number
  height_mm: number | null
}

export interface SceneWall {
  id: string
  label: string
  points: [number, number][]
  /** null = full height (the plan's ceiling). */
  height_mm: number | null
  color: string
  openings: SceneWallOpening[]
}

export interface ScenePayload {
  plan: {
    id: string
    name: string
    grid_width: number
    grid_height: number
    cell_mm: number
    ceiling_mm: number
    background_image: string | null
    background_opacity: number
  }
  tiles: SceneTile[]
  trays: SceneTray[]
  /** Raised-floor rectangles; optional so older cached payloads stay valid. */
  raised_floors?: SceneRaisedFloor[]
  /** Wall polylines with door openings; optional for the same reason. */
  walls?: SceneWall[]
  as_of: string
}

// ─── Physical constants (metres) ─────────────────────────────────────────────

/** Rack plinth/base under U1 — visual, matches typical cabinet bases. */
export const RACK_BASE_M = 0.1
/** Frame added around the rail opening when outer width isn't recorded. */
export const RACK_FRAME_MM = 150
/** Render default when a rack has no recorded outer depth. */
export const RACK_DEPTH_DEFAULT_M = 1.0
/** Tray cross-section. Drawn as a real basket — two side rails and rungs —
 * so the runs it carries are VISIBLE inside it. (v1 was one solid box, which
 * swallowed every cable riding through it.) */
export const TRAY_W_M = 0.2
export const TRAY_H_M = 0.08
/** Rail thickness and how deep the basket's floor sits below the datum. */
export const TRAY_RAIL_T_M = 0.008
/** Rung pitch along the run, and the rung's square section. */
export const TRAY_RUNG_PITCH_M = 0.3
export const TRAY_RUNG_T_M = 0.01
/** Derived tray elevation offsets (mm) when elevation_mm is blank.
 * UNDERFLOOR_MM is the FALLBACK plenum — a raised-floor area under the run
 * overrides it (api/pathfinding.py's DEFAULT_PLENUM_MM is the same 300). */
export const OVERHEAD_DROP_MM = 300
export const UNDERFLOOR_MM = -300

/**
 * Draw order for the room's see-through pieces. three.js sorts transparent
 * objects by depth every frame, so overlapping ghosts and cabinet glass
 * reshuffled as the camera moved — the flicker that shows up when flipping
 * between solid, cutaway and x-ray. A fixed order makes the stack
 * deterministic: ghosts first, glass over them.
 */
export const TRANSPARENT_ORDER = { ghost: 1, glass: 2 } as const

export const mm = (v: number) => v / 1000

/** One grid cell in metres. */
export const cellM = (plan: ScenePayload["plan"]) => mm(plan.cell_mm)

/** Grid cell coords (cells) → world metres. X east, Z south (grid y). */
export function cellToWorld(
  plan: ScenePayload["plan"],
  x: number,
  y: number
): [number, number] {
  const c = cellM(plan)
  return [x * c, y * c]
}

/** The plenum depth (mm, positive) under a tray run: the deepest raised-floor
 * area any of its points sits in, else the 300 fallback — the twin of
 * api/pathfinding.py's underfloor_plenum_mm, so 3D depth and route-length
 * drops can't disagree. */
export function underfloorMM(
  areas: SceneRaisedFloor[] | undefined,
  points: [number, number][]
): number {
  let best = 0
  for (const [px, py] of points) {
    for (const a of areas ?? []) {
      if (a.x <= px && px <= a.x + a.w && a.y <= py && py <= a.y + a.h)
        if (a.plenum_mm > best) best = a.plenum_mm
    }
  }
  return best || -UNDERFLOOR_MM
}

/** A tray's resolved elevation (m) from its level when not set explicitly.
 * Omit `areas` and underfloor derives the historical −300. */
export function trayElevationM(
  plan: ScenePayload["plan"],
  tray: SceneTray,
  areas?: SceneRaisedFloor[]
): number {
  if (tray.elevation_mm != null) return mm(tray.elevation_mm)
  if (tray.level === "underfloor") return -mm(underfloorMM(areas, tray.points))
  if (tray.level === "floor") return 0
  return mm(plan.ceiling_mm - OVERHEAD_DROP_MM)
}

/** Top panel thickness. Shared with the rack shell so the cabinet's height
 * and the cap that closes it can never disagree. */
export const RACK_CAP_M = 0.03

/** Cabinet outer footprint (m) — recorded, or derived like the docs promise. */
export function rackFootprintM(rack: SceneRack): {
  width: number
  depth: number
  height: number
} {
  const opening = OPENING_MM[rack.width] ?? PANEL_MM.opening
  const width = mm(rack.outer_width_mm ?? opening + RACK_FRAME_MM)
  const depth =
    rack.outer_depth_mm != null ? mm(rack.outer_depth_mm) : RACK_DEPTH_DEFAULT_M
  // The cap sits ABOVE the rail space, not in it. Without this term the U
  // space filled the whole cabinet and the 30 mm top panel was drawn inside
  // the highest U — burying two thirds of whatever was installed there. A real
  // 42U cabinet is taller than 42U of rail, for exactly this reason.
  const height = mm(rack.u_height * PANEL_MM.uPitch) + RACK_BASE_M + RACK_CAP_M
  return { width, depth, height }
}

/** 0U gear racked at a position is non-rack-format (a desktop appliance on a
 * shelf, not a 19″ unit). Zero height would render a degenerate plane, so it
 * draws as a smaller centred box: sub-1U tall, well under rack width/depth —
 * honest about "sits in the rack" vs "fills the rack". */
export const APPLIANCE_H_U = 0.8
export const APPLIANCE_W_FRAC = 0.4
export const APPLIANCE_D_FRAC = 0.35

/**
 * A device's vertical placement inside its rack: bottom Y (m above the rack
 * base plate) + its height (m). Mirrors the 2D elevation's unit math exactly:
 * `position` is the device's lowest-numbered unit; with default (ascending)
 * numbering units count bottom-up, with `desc_units` they count top-down.
 */
export function deviceYM(
  rack: SceneRack,
  dev: SceneDevice
): { y: number; h: number } {
  const pitch = mm(PANEL_MM.uPitch)
  // Side-mounted strips never reach this math (they render via
  // sideStripBoxM); the fallback keeps the function total for TypeScript.
  const position = dev.position ?? rack.starting_unit
  // A 0U appliance still occupies its position's slot (the 2D elevation's
  // Math.max(1, …) clamp), it just renders shorter than the slot.
  const units = Math.max(dev.u_height, 1)
  const slotFromBottom = rack.desc_units
    ? rack.u_height - (position - rack.starting_unit) - units
    : position - rack.starting_unit
  return {
    y: RACK_BASE_M + slotFromBottom * pitch,
    h: (dev.u_height > 0 ? dev.u_height : APPLIANCE_H_U) * pitch,
  }
}

/**
 * A racked device's box geometry, local to its rack group — THE single source
 * for the 3D device box (DeviceMesh renders from it; the cables layer anchors
 * runs to it). All values in metres.
 */
export function deviceBoxM(
  rack: SceneRack,
  dev: SceneDevice,
  // Gear is sized to the rail opening, not the cabinet, so the outer width is
  // no longer read here — kept in the signature so every caller stays
  // uniform (rack, dev, width, depth).
  _rackWidthM: number,
  rackDepthM: number
): {
  y: number
  h: number
  dx: number
  dz: number
  dw: number
  dd: number
  boxH: number
  mountedRear: boolean
} {
  const { y, h } = deviceYM(rack, dev)
  const appliance = dev.u_height <= 0
  // Gear is sized to the 19" RAIL OPENING (a fixed 450 mm), NOT the cabinet
  // width. That is what makes a wider cabinet show zero-U side bays: the extra
  // outer width beyond the opening is empty channel where PDUs and cabling
  // live, exactly as a real rack elevation reads. Sizing devices to the
  // cabinet made them grow with it and swallow the bay every time.
  const openM = mm(OPENING_MM[rack.width] ?? PANEL_MM.opening)
  const dw = appliance
    ? openM * APPLIANCE_W_FRAC
    : dev.rack_width === "half"
      ? openM * 0.48
      : openM * 0.98
  const dx =
    dev.rack_side === "left"
      ? -openM * 0.25
      : dev.rack_side === "right"
        ? openM * 0.25
        : 0
  const dd = appliance
    ? rackDepthM * APPLIANCE_D_FRAC
    : dev.is_full_depth
      ? rackDepthM * 0.9
      : rackDepthM * 0.45
  const mountedRear = dev.face === "rear"
  const dz = mountedRear
    ? rackDepthM * 0.45 - dd / 2
    : dd / 2 - rackDepthM * 0.45
  return { y, h, dx, dz, dw, dd, boxH: h * 0.94, mountedRear }
}

/**
 * A photo-port marker's position local to the RACK group (metres) — the same
 * spot DeviceMesh draws the quad: on the exposed face plane, a hair off the
 * box. Feed through the rack's world transform for a scene position.
 */
export function portLocalM(
  box: ReturnType<typeof deviceBoxM>,
  m: { x: number; y: number },
  /** Which of the device's own panels the marker is on (image_ports front vs
   * rear). Defaults to the front panel — the faceplate. Which SIDE of the
   * rack that panel faces depends on the mounting: a front-mounted server's
   * rear panel faces the hot aisle (+Z), but a REAR-mounted box is turned
   * around, so its rear panel faces the cold aisle (−Z). Keying the ±Z pick
   * off the panel alone put every rear-mounted device's ports on the wrong
   * side of the cabinet.
   */
  onRear = false
): [number, number, number] {
  const mx = (m.x - 0.5) * box.dw
  const my = (0.5 - m.y) * box.boxH
  // Rack-space side this panel faces: +Z (rear aisle) when panel and mounting
  // disagree, −Z when they agree — truth table of the two flips.
  const plusZ = onRear !== box.mountedRear
  // The −Z face is drawn via a π turn about Y (mirrors X); +Z is unturned.
  return plusZ
    ? [box.dx + mx, box.y + box.h / 2 + my, box.dz + box.dd / 2 + 0.004]
    : [box.dx - mx, box.y + box.h / 2 + my, box.dz - box.dd / 2 - 0.004]
}

// ─── Synthetic port markers ──────────────────────────────────────────────────

/** Row placement for synthesized quads, in the marker's fraction coordinates
 * (x right, y down from the panel's top-left; centres). */
const SYNTH_ROW_Y = 0.8
const SYNTH_H = 0.28
const SYNTH_MARGIN = 0.04
const SYNTH_MAX_W = 0.06

/** Numeric-aware, locale-stable ordering: "PSU 2" before "PSU 10". */
const byPortName = (a: string, b: string) =>
  a.localeCompare(b, "en", { numeric: true, sensitivity: "base" }) ||
  a.localeCompare(b, "en")

/**
 * Deterministic markers for power components that have NO photo marker: a
 * small row of quads along the bottom edge of the device's REAR panel (where
 * inlets physically live), ordered by name — power ports first, then outlets.
 *
 * Marker-shaped on purpose. DeviceMesh renders these through the exact same
 * quad path as photo markers, and the cable layer anchors runs through the
 * same `portLocalM` — ONE layout, so what you can click and where a cable
 * lands can never disagree. Before this, a power port whose name matched no
 * photo marker anchored its cable in the middle of the face and could not be
 * clicked to start a connection at all.
 *
 * Ports already covered by a photo marker (matched via the shared
 * `normalizePortName`, template names rendered first) are skipped, so gear
 * with a marked-up rear photo keeps exactly its photographed anchors.
 */
export function syntheticPortMarkers(dev: SceneDevice): ImagePortMarker[] {
  const ports = dev.power_ports ?? []
  const outlets = dev.power_outlets ?? []
  if (ports.length + outlets.length === 0) return []
  const claimed = new Set<string>()
  for (const panel of ["front", "rear"] as const)
    for (const mk of dev.image_ports?.[panel] ?? [])
      claimed.add(normalizePortName(renderTemplateName(mk.name, null)))
  const unmarked = (names: string[], kind: string) =>
    names
      .filter((n) => !claimed.has(normalizePortName(n)))
      .sort(byPortName)
      .map((name) => ({ name, kind }))
  const entries = [
    ...unmarked(ports, "power-port"),
    ...unmarked(outlets, "power-outlet"),
  ]
  const n = entries.length
  if (n === 0) return []
  const slot = (1 - 2 * SYNTH_MARGIN) / n
  const w = Math.min(SYNTH_MAX_W, slot * 0.8)
  return entries.map((e, i) => ({
    ...e,
    x: SYNTH_MARGIN + slot * (i + 0.5),
    y: SYNTH_ROW_Y,
    w,
    h: SYNTH_H,
  }))
}

// ─── Airflow glyphs ──────────────────────────────────────────────────────────

export interface AirflowGlyph {
  kind: "intake" | "exhaust"
  /** Cone centre, local to the rack group (m). */
  pos: [number, number, number]
  /** Unit flow direction the cone points along. */
  dir: [number, number, number]
  /** Multiplier on the unit cone, sized to the DEVICE. Fixed-size cones were
   * 50 mm across on a 42 mm-tall 1U box — bigger than the gear they annotated,
   * and up close they sat over the faceplate and hid the ports. */
  scale: number
}

/** Cone size as a fraction of the device's box height, and the floor/ceiling
 * that keeps a 0U strip's cue visible and a 10U chassis's cue sane. */
const GLYPH_H_FRAC = 0.2
const GLYPH_MIN_M = 0.012
const GLYPH_MAX_M = 0.024

/** Unit-cone height the scale multiplies (keep in step with the geometry in
 * airflow-glyphs.tsx, which builds a cone of exactly this height). */
export const GLYPH_UNIT_H_M = 0.06

/** Cone height for a device box — the scale factor is this over the unit. */
export function airflowGlyphSizeM(boxH: number): number {
  return Math.min(GLYPH_MAX_M, Math.max(GLYPH_MIN_M, boxH * GLYPH_H_FRAC))
}

/**
 * Where a device's airflow cones go, in rack-local space. A direction CUE,
 * not CFD: 2–3 cones per face, all pointing along the flow.
 *
 * Conventions (rack-local): the front plane is at `dz − dd/2` (faces −Z),
 * the rear at `dz + dd/2` (faces +Z). "front-to-rear" flow therefore points
 * +Z: intake cones sit on the front plane, exhaust cones on the rear, both
 * pointing +Z. Side flows run along ±X ("left" = −X side as drawn, which is
 * the device's left as seen from the aisle facing its front). "passive",
 * "mixed-without-a-face" and unknown draw nothing; "mixed" draws one intake
 * and one exhaust side by side on the exposed face.
 */
export function airflowGlyphPlacements(
  airflow: string | undefined,
  box: ReturnType<typeof deviceBoxM>
): AirflowGlyph[] {
  if (!airflow || airflow === "passive") return []
  // Ride the TOP EDGE of the unit, not its middle. Centred on the face these
  // sat straight on the port field — head-on a cone reads as a fat disc, and a
  // rack of them made faceplates unreadable (reported twice). An airflow cue
  // annotates a unit; it must never be the thing you see instead of it.
  const midY = box.y + box.h - airflowGlyphSizeM(box.boxH) * 0.6
  // Cone size — and therefore its standoff — follow the device, so the cue
  // never outgrows the gear or lands on top of the faceplate's ports.
  const size = airflowGlyphSizeM(box.boxH)
  const scale = size / GLYPH_UNIT_H_M
  const off = size * 0.9
  const frontZ = box.dz - box.dd / 2 - off
  const rearZ = box.dz + box.dd / 2 + off
  // 3 across the width for wide gear, 2 for half-width — spread, not centred.
  const n = box.dw > 0.3 ? 3 : 2
  const xs = Array.from(
    { length: n },
    (_, i) => box.dx + ((i + 1) / (n + 1) - 0.5) * box.dw
  )
  const out: AirflowGlyph[] = []
  const row = (
    kind: AirflowGlyph["kind"],
    z: number,
    dir: [number, number, number]
  ) => {
    for (const x of xs) out.push({ kind, pos: [x, midY, z], dir, scale })
  }
  switch (airflow) {
    case "front-to-rear":
      row("intake", frontZ, [0, 0, 1])
      row("exhaust", rearZ, [0, 0, 1])
      break
    case "rear-to-front":
      row("intake", rearZ, [0, 0, -1])
      row("exhaust", frontZ, [0, 0, -1])
      break
    case "left-to-right":
    case "right-to-left": {
      const sign = airflow === "left-to-right" ? 1 : -1
      const inX = box.dx - (sign * box.dw) / 2 - sign * off
      const outX = box.dx + (sign * box.dw) / 2 + sign * off
      for (const z of [box.dz - box.dd / 4, box.dz + box.dd / 4]) {
        out.push({
          kind: "intake",
          pos: [inX, midY, z],
          dir: [sign, 0, 0],
          scale,
        })
        out.push({
          kind: "exhaust",
          pos: [outX, midY, z],
          dir: [sign, 0, 0],
          scale,
        })
      }
      break
    }
    case "mixed": {
      // One of each, side by side on the exposed face, pointing in and out.
      const z = box.mountedRear ? rearZ : frontZ
      const outward = box.mountedRear ? 1 : -1
      out.push({
        kind: "intake",
        pos: [box.dx - box.dw / 4, midY, z],
        dir: [0, 0, -outward],
        scale,
      })
      out.push({
        kind: "exhaust",
        pos: [box.dx + box.dw / 4, midY, z],
        dir: [0, 0, outward],
        scale,
      })
      break
    }
    default:
      return []
  }
  return out
}

// ─── Walls ───────────────────────────────────────────────────────────────────

/** Wall thickness (m) — a frontend constant until someone needs it as data. */
export const WALL_THICKNESS_M = 0.1
/** An opening with no height renders a standard door. */
export const DOOR_DEFAULT_MM = 2100

export interface WallBox {
  /** Segment endpoints in CELL units (the caller converts to metres). */
  x0: number
  z0: number
  x1: number
  z1: number
  /** Vertical extent in metres. */
  y0: number
  y1: number
}

/**
 * Decompose one wall segment run into solid boxes: full-height spans between
 * openings, plus a lintel over each opening (door height → wall top). Pure —
 * cell units in the plane, metres vertically — so the geometry that shapes
 * every room is unit-tested instead of eyeballed.
 */
export function wallSegmentsWithOpenings(
  points: [number, number][],
  openings: SceneWallOpening[],
  wallHeightM: number
): WallBox[] {
  const out: WallBox[] = []
  for (let seg = 0; seg < points.length - 1; seg++) {
    const [ax, az] = points[seg]
    const [bx, bz] = points[seg + 1]
    const len = Math.hypot(bx - ax, bz - az)
    if (len < 1e-9) continue
    const ux = (bx - ax) / len
    const uz = (bz - az) / len
    const at = (t: number): [number, number] => [ax + ux * t, az + uz * t]

    const spans = openings
      .filter((o) => o.seg === seg)
      .map((o) => ({
        from: Math.max(0, Math.min(o.from, len)),
        to: Math.max(0, Math.min(o.to, len)),
        doorM: mm(o.height_mm ?? DOOR_DEFAULT_MM),
      }))
      .filter((o) => o.to > o.from)
      .sort((a, b) => a.from - b.from)

    let cursor = 0
    for (const o of spans) {
      if (o.from > cursor) {
        const [x0, z0] = at(cursor)
        const [x1, z1] = at(o.from)
        out.push({ x0, z0, x1, z1, y0: 0, y1: wallHeightM })
      }
      // Lintel above the door gap — omitted when the door reaches the top.
      const doorTop = Math.min(o.doorM, wallHeightM)
      if (doorTop < wallHeightM - 1e-9) {
        const [x0, z0] = at(o.from)
        const [x1, z1] = at(o.to)
        out.push({ x0, z0, x1, z1, y0: doorTop, y1: wallHeightM })
      }
      cursor = Math.max(cursor, o.to)
    }
    if (cursor < len - 1e-9) {
      const [x0, z0] = at(cursor)
      const [x1, z1] = at(len)
      out.push({ x0, z0, x1, z1, y0: 0, y1: wallHeightM })
    }
  }
  return out
}

/**
 * Camera viewpoint that frames one face of a rack: orbit target at chest
 * height on the cabinet, eye backed off along the face normal. The SAME math
 * drives the double-click fly-to (front) and the HUD's front↔rear flip, so
 * the two can never frame differently. Pure tuples — unit-testable.
 */
export function rackViewpoint(
  plan: ScenePayload["plan"],
  tile: SceneTile,
  heightM: number,
  side: "front" | "rear"
): { target: [number, number, number]; position: [number, number, number] } {
  const [cx, cz] = cellToWorld(plan, tile.x + tile.w / 2, tile.y + tile.h / 2)
  const rotY = (-tile.orientation * Math.PI) / 180
  // Local −Z is the rack's front; +Z its rear. Rotate about Y by rotY.
  const sign = side === "front" ? -1 : 1
  const dist = Math.max(heightM * 1.3, 2.2)
  const dx = sign * Math.sin(rotY) * dist
  const dz = sign * Math.cos(rotY) * dist
  return {
    target: [cx, heightM * 0.55, cz],
    position: [cx + dx, heightM * 0.62, cz + dz],
  }
}

/**
 * Where to stand to read ONE device's face — the double-click framing, and
 * the device-scale twin of {@link rackViewpoint}.
 *
 * Same rack-local convention (front is −Z), but the target is the device's
 * own centre height and the standoff is driven by how tall the device is, so
 * a 1U switch fills the frame instead of being a sliver in a rack-sized shot.
 * `mountedRear` gear is framed from the rear aisle without the caller having
 * to know which side it lives on.
 */
export function deviceViewpoint(
  plan: ScenePayload["plan"],
  tile: SceneTile,
  box: Pick<ReturnType<typeof deviceBoxM>, "y" | "h" | "dx" | "boxH"> & {
    mountedRear: boolean
  }
): { target: [number, number, number]; position: [number, number, number] } {
  const [cx, cz] = cellToWorld(plan, tile.x + tile.w / 2, tile.y + tile.h / 2)
  const rotY = (-tile.orientation * Math.PI) / 180
  const sign = box.mountedRear ? 1 : -1
  // Close enough to read port labels, far enough that a 10U chassis fits.
  const dist = Math.min(2.4, Math.max(0.55, box.boxH * 9))
  const eyeY = box.y + box.h / 2
  // The device's own X offset (half-width gear) rotated into world space.
  const ox = box.dx * Math.cos(rotY)
  const oz = -box.dx * Math.sin(rotY)
  return {
    target: [cx + ox, eyeY, cz + oz],
    position: [
      cx + ox + sign * Math.sin(rotY) * dist,
      eyeY,
      cz + oz + sign * Math.cos(rotY) * dist,
    ],
  }
}

/** The door/passage gaps of a wall in plan view: one span per valid opening,
 * clamped exactly like wallSegmentsWithOpenings — so the 2D canvas's gaps and
 * the 3D boxes can never disagree about where a doorway sits. */
export function wallDoorSpans(
  points: [number, number][],
  openings: SceneWallOpening[]
): { x0: number; z0: number; x1: number; z1: number }[] {
  const out: { x0: number; z0: number; x1: number; z1: number }[] = []
  for (let seg = 0; seg < points.length - 1; seg++) {
    const [ax, az] = points[seg]
    const [bx, bz] = points[seg + 1]
    const len = Math.hypot(bx - ax, bz - az)
    if (len < 1e-9) continue
    const ux = (bx - ax) / len
    const uz = (bz - az) / len
    for (const o of openings) {
      if (o.seg !== seg) continue
      const from = Math.max(0, Math.min(o.from, len))
      const to = Math.max(0, Math.min(o.to, len))
      if (to <= from) continue
      out.push({
        x0: ax + ux * from,
        z0: az + uz * from,
        x1: ax + ux * to,
        z1: az + uz * to,
      })
    }
  }
  return out
}

// ─── Zero-U side strips ──────────────────────────────────────────────────────

/** Strip cross-section, and the clearance it keeps off the side panel. */
export const STRIP_W_M = 0.05
export const STRIP_D_M = 0.11
const STRIP_CLEARANCE_M = 0.008
/** Air between the rail opening and the strip's inner face. */
const STRIP_GAP_M = 0.012

/**
 * The clear width, per side, between the mounting rails and the cabinet's
 * side panel — the **zero-U space** a vertical PDU actually lives in.
 *
 * This is why 750 mm and 800 mm cabinets exist: the 19″ rail opening is a
 * fixed 450 mm, so every millimetre of extra cabinet width becomes zero-U
 * channel. A plain 600 mm cabinet has almost none, which is exactly why you
 * can't hang a PDU in one — and the render should say so rather than
 * pretend.
 */
/** How much of a cabinet's contents the room draws at a given range. */
export type Tier = "detail" | "mid" | "far"

/** Metres (surface distance, not centre) at which each tier takes over, with
 * hysteresis so orbiting on a boundary can't strobe. */
const TIER_IN = { detail: 7, mid: 26 }
const TIER_OUT = { detail: 9, mid: 30 }

/**
 * Pick a cabinet's detail tier from its distance to the eye.
 *
 * Two tiers were not enough for a full hall. `detail` (a mesh, an outline, a
 * photo plane and port quads per device) has to stay within a few metres or a
 * hundred full cabinets is five figures of draw calls; but promoting straight
 * from there to an empty frame left the room looking derelict from the door.
 * `mid` fills that gap with one instanced draw call per cabinet — you see the
 * gear, you just can't read it.
 */
export function tierFor(distM: number, current: Tier): Tier {
  const detail = current === "detail" ? TIER_OUT.detail : TIER_IN.detail
  if (distM < detail) return "detail"
  const mid = current === "far" ? TIER_IN.mid : TIER_OUT.mid
  return distM < mid ? "mid" : "far"
}

/**
 * Does a cabinet at `centre` stand between the eye and the point being looked
 * at? True when its centre lies close to the camera→target segment and
 * strictly between the two ends. Drives auto-ghosting: a rack that blocks the
 * view of the selected rack fades instead of filling the screen.
 */
export function occludesSightLine(
  cam: [number, number, number],
  target: [number, number, number],
  centre: [number, number, number],
  radiusM: number
): boolean {
  const dx = target[0] - cam[0]
  const dy = target[1] - cam[1]
  const dz = target[2] - cam[2]
  const len2 = dx * dx + dy * dy + dz * dz
  if (len2 < 1e-6) return false
  const t =
    ((centre[0] - cam[0]) * dx +
      (centre[1] - cam[1]) * dy +
      (centre[2] - cam[2]) * dz) /
    len2
  // Strictly between: not the target itself (t≈1) and not behind the eye.
  if (t <= 0.02 || t >= 0.94) return false
  const px = cam[0] + t * dx - centre[0]
  const py = cam[1] + t * dy - centre[1]
  const pz = cam[2] + t * dz - centre[2]
  return px * px + py * py + pz * pz < radiusM * radiusM
}

export function zeroUChannelM(rack: SceneRack): number {
  const opening = mm(OPENING_MM[rack.width] ?? PANEL_MM.opening)
  const { width } = rackFootprintM(rack)
  // Frame/panel steel eats a little of each side before the clear channel.
  return Math.max(0, (width - opening) / 2 - 0.012)
}

/** Whether this cabinet has room for a strip in its channel at all. */
export function fitsInChannel(rack: SceneRack): boolean {
  return zeroUChannelM(rack) >= STRIP_W_M + STRIP_CLEARANCE_M
}

/**
 * Where a side-mounted 0U strip (a vertical PDU) sits, local to its rack
 * group.
 *
 * INSIDE the cabinet, in the zero-U channel between the rail and the side
 * panel — which is where one physically bolts. (v1 hung it off the outside
 * of the panel, so PDUs floated in the aisle beside their rack and collided
 * with the neighbouring cabinet in a bayed row.) A cabinet too narrow for a
 * channel gets the strip tucked as far out as it goes, overlapping the rail
 * line: honest about the squeeze rather than teleporting it outdoors.
 *
 * Spans `mount_span_u` (default ~¾ of the rack) above its offset, never
 * poking past the rack's top. `face` picks the channel end. Pure —
 * unit-tested.
 */
export function sideStripBoxM(
  rack: SceneRack,
  dev: SceneDevice,
  rackWidthM: number,
  rackDepthM: number
): { x: number; y: number; h: number; z: number } {
  const pitch = mm(PANEL_MM.uPitch)
  const spanU = Math.min(
    dev.mount_span_u ?? Math.round(rack.u_height * 0.75),
    rack.u_height
  )
  const h = spanU * pitch
  const rackTop = RACK_BASE_M + rack.u_height * pitch
  const y = Math.min(
    RACK_BASE_M + mm(dev.mount_offset_mm ?? 0),
    Math.max(RACK_BASE_M, rackTop - h)
  )
  const sign = dev.mount === "side_left" ? -1 : 1
  // `face` names the CHANNEL the strip bolts into: rear sits back in the
  // cabinet (where a vertical PDU actually lives), front sits forward.
  // Blank stays mid-depth — we genuinely don't know which channel it's in.
  const z =
    dev.face === "rear"
      ? rackDepthM * 0.32
      : dev.face === "front"
        ? -rackDepthM * 0.28
        : rackDepthM * 0.2
  // The strip stands just OUTSIDE the rail opening, shoulder to shoulder
  // with the gear — where a real vertical PDU bolts. It used to hug the far
  // side panel instead, which in a wide cabinet left a dead gap between rails
  // and PDU and read as "floating at the edge". Clamped inside the cabinet so
  // narrow cabinets keep it in their own footprint.
  const openHalf = mm(OPENING_MM[rack.width] ?? PANEL_MM.opening) / 2
  const beside = openHalf + STRIP_GAP_M + STRIP_W_M / 2
  const panelMax = rackWidthM / 2 - STRIP_CLEARANCE_M - STRIP_W_M / 2
  const x = sign * Math.max(STRIP_W_M / 2, Math.min(beside, panelMax))
  return { x, y, h, z }
}

/** Outlet spacing down a vertical strip (m) — about a real C13 pitch, so 24
 * outlets cover roughly the strip's outlet field. */
export const STRIP_PORT_PITCH_M = 0.05
/** Port quad side (m) on the strip's end face. */
export const STRIP_PORT_QUAD_M = 0.03

/**
 * Where one port of a side-mounted 0U strip sits, local to the RACK group —
 * on the strip's exposed END face (rear-facing for a rear-channel strip), the
 * side an operator in that aisle actually sees.
 *
 * Outlets are named with a trailing index (`C13-01`…), so an indexed name
 * spreads down from the strip's top at a real C13 pitch, clamped inside it;
 * a non-indexed name (the inlet) sits at the strip's foot, where the supply
 * cord physically enters. `out` is the ±Z the face looks along — the stub
 * direction for cables, the quad turn for the render.
 *
 * ONE function on purpose: SideStripMesh draws its clickable quads here and
 * the cable layer anchors runs here, so a power cord and the outlet it lands
 * on can never disagree. Before this the strip drew NO port quads at all and
 * the cable layer invented its own positions on the strip's side face.
 */
export function stripPortLocalM(
  strip: { x: number; y: number; h: number; z: number },
  dev: SceneDevice,
  portName: string
): { x: number; y: number; z: number; out: 1 | -1 } {
  const idx = Number(/(\d+)\s*$/.exec(portName)?.[1] ?? 0)
  const top = strip.y + strip.h
  const y =
    idx > 0
      ? Math.max(
          strip.y + STRIP_PORT_QUAD_M / 2,
          top - (idx - 0.5) * STRIP_PORT_PITCH_M
        )
      : strip.y + STRIP_PORT_QUAD_M * 1.5
  // `face` names the channel the strip bolts into; its ports look out the
  // matching end. Blank (unknown channel) keeps the rear-facing default.
  const out = dev.face === "front" ? -1 : 1
  return { x: strip.x, y, z: strip.z + out * (STRIP_D_M / 2 + 0.002), out }
}

// ─── Cable-run geometry (P8) ─────────────────────────────────────────────────

type V3 = [number, number, number]

/**
 * Replace every interior corner of a polyline with a rounded bend: pull back
 * up to `radius` along both edges and sample a quadratic Bézier through the
 * corner. No installer bends a cable at 90° — and neither should the room.
 * Endpoints are preserved exactly (a run still starts ON its port quad);
 * collinear vertices pass through untouched. Pure and unit-tested.
 */
export function filletPath(points: V3[], radius = 0.1, steps = 4): V3[] {
  if (points.length < 3) return points
  const out: V3[] = [points[0]]
  for (let i = 1; i < points.length - 1; i++) {
    const [ax, ay, az] = points[i - 1]
    const [bx, by, bz] = points[i]
    const [cx, cy, cz] = points[i + 1]
    const inV: V3 = [bx - ax, by - ay, bz - az]
    const outV: V3 = [cx - bx, cy - by, cz - bz]
    const inLen = Math.hypot(...inV)
    const outLen = Math.hypot(...outV)
    if (inLen < 1e-9 || outLen < 1e-9) continue
    // Collinear (or nearly): keep the vertex as-is.
    const dot =
      (inV[0] * outV[0] + inV[1] * outV[1] + inV[2] * outV[2]) /
      (inLen * outLen)
    if (dot > 0.999) {
      out.push(points[i])
      continue
    }
    const t = Math.min(radius, inLen / 2, outLen / 2)
    const p1: V3 = [
      bx - (inV[0] / inLen) * t,
      by - (inV[1] / inLen) * t,
      bz - (inV[2] / inLen) * t,
    ]
    const p2: V3 = [
      bx + (outV[0] / outLen) * t,
      by + (outV[1] / outLen) * t,
      bz + (outV[2] / outLen) * t,
    ]
    // Quadratic Bézier p1 → (corner) → p2.
    for (let s = 0; s <= steps; s++) {
      const u = s / steps
      const w0 = (1 - u) * (1 - u)
      const w1 = 2 * (1 - u) * u
      const w2 = u * u
      out.push([
        w0 * p1[0] + w1 * bx + w2 * p2[0],
        w0 * p1[1] + w1 * by + w2 * p2[1],
        w0 * p1[2] + w1 * bz + w2 * p2[2],
      ])
    }
  }
  out.push(points[points.length - 1])
  return out
}

/**
 * Offset a 2D polyline sideways by `offset` (metres, +left of travel), with
 * averaged normals at the joints — how ten cables in one tray become ten
 * PARALLEL runs instead of one overdrawn line.
 */
export function offsetPolyline(
  points: [number, number][],
  offset: number
): [number, number][] {
  if (points.length < 2 || offset === 0) return points.map((p) => [p[0], p[1]])
  const normals: [number, number][] = []
  for (let i = 0; i < points.length - 1; i++) {
    const dx = points[i + 1][0] - points[i][0]
    const dz = points[i + 1][1] - points[i][1]
    const len = Math.hypot(dx, dz) || 1
    normals.push([-dz / len, dx / len])
  }
  return points.map((p, i) => {
    const n0 = normals[Math.max(0, i - 1)]
    const n1 = normals[Math.min(normals.length - 1, i)]
    let nx = n0[0] + n1[0]
    let nz = n0[1] + n1[1]
    const len = Math.hypot(nx, nz)
    if (len < 1e-9) {
      nx = n1[0]
      nz = n1[1]
    } else {
      nx /= len
      nz /= len
    }
    return [p[0] + nx * offset, p[1] + nz * offset]
  })
}

/** Lanes across a tray and a little vertical stagger. Seven lanes at 26 mm
 * span 156 mm — inside a 200 mm basket's clear width, so no run rides the
 * rail or hangs over the edge. */
export const CABLE_LANES = 7
export const CABLE_LANE_SPACING_M = 0.026

/**
 * A cable's deterministic tray lane: same cable, same lane, every frame and
 * every reload — no flicker, no reshuffling. `across` spreads runs over the
 * tray width, `lift` staggers heights so crossing lanes don't z-fight.
 */
export function cableLane(cableId: string): { across: number; lift: number } {
  // djb2 — tiny, stable, good enough spread for a handful of lanes.
  let h = 5381
  for (let i = 0; i < cableId.length; i++)
    h = ((h << 5) + h + cableId.charCodeAt(i)) >>> 0
  const lane = h % CABLE_LANES
  const across = (lane - (CABLE_LANES - 1) / 2) * CABLE_LANE_SPACING_M
  const lift = ((h >>> 3) % 3) * 0.01
  return { across, lift }
}

/**
 * The height a run rides at when it follows a tray: resting on the basket's
 * FLOOR (plus its lane stagger), not on the tray's centre datum.
 *
 * `trayElevationM` returns the tray's datum — the middle of the old solid
 * box — so riding there put every cable *inside* the tin and invisible.
 * The basket's floor is half a section below the datum; a hair above it is
 * where cable actually lies.
 */
export function trayRideY(trayY: number, lift = 0): number {
  return trayY - TRAY_H_M / 2 + TRAY_RAIL_T_M + 0.006 + lift
}

/**
 * Where two straight runs cross or meet, in world metres.
 *
 * `null` when they are parallel (an end-to-end continuation needs no joint)
 * or when the crossing falls outside either segment. Inclusive at the ends,
 * so a run terminating ON another run — a tee — counts.
 */
export function segmentCrossing(
  a1: [number, number],
  a2: [number, number],
  b1: [number, number],
  b2: [number, number]
): [number, number] | null {
  const rx = a2[0] - a1[0]
  const rz = a2[1] - a1[1]
  const sx = b2[0] - b1[0]
  const sz = b2[1] - b1[1]
  const denom = rx * sz - rz * sx
  if (Math.abs(denom) < 1e-12) return null
  const qx = b1[0] - a1[0]
  const qz = b1[1] - a1[1]
  const t = (qx * sz - qz * sx) / denom
  const u = (qx * rz - qz * rx) / denom
  const e = 1e-6
  if (t < -e || t > 1 + e || u < -e || u > 1 + e) return null
  return [a1[0] + t * rx, a1[1] + t * rz]
}

/**
 * Every place tray runs join: a polyline's own corners, plus wherever two
 * different trays tee or cross.
 *
 * Each segment is drawn as a full-length basket, so at a junction two baskets
 * simply shot through each other — rails overshooting past the corner, rungs
 * crossing in mid-air. Knowing the joints lets the rails stop short and a
 * junction plate bridge the gap, the way fabricated tray actually turns.
 */
export interface TrayJunction {
  /** World position of the joint (x, z). */
  at: [number, number]
  /** Ids of the trays that meet here — the first one styles the plate. */
  trayIds: string[]
}

/**
 * Whether a polyline actually TURNS at `at` — the cross product of the two
 * edge directions is non-negligible.
 *
 * A redundant collinear vertex (drawn by clicking a couple of times along a
 * straight run) is not a joint. Treating every interior vertex as a corner
 * cut a fake gap into the middle of straight tray, complete with a junction
 * plate bridging nothing.
 */
export function turnsAt(
  prev: [number, number],
  at: [number, number],
  next: [number, number]
): boolean {
  const ax = at[0] - prev[0]
  const az = at[1] - prev[1]
  const bx = next[0] - at[0]
  const bz = next[1] - at[1]
  const la = Math.hypot(ax, az)
  const lb = Math.hypot(bx, bz)
  if (la < 1e-9 || lb < 1e-9) return false
  return Math.abs((ax / la) * (bz / lb) - (az / la) * (bx / lb)) > 1e-6
}

export function trayJunctions(
  plan: ScenePayload["plan"],
  trays: SceneTray[]
): TrayJunction[] {
  const out: TrayJunction[] = []
  const byKey = new Map<string, TrayJunction>()
  const add = (p: [number, number], ...ids: string[]) => {
    // Dedupe to the millimetre — a crossing found from both trays is one
    // joint, and it remembers every run that lands on it.
    const key = `${Math.round(p[0] * 1000)}:${Math.round(p[1] * 1000)}`
    let j = byKey.get(key)
    if (!j) {
      j = { at: p, trayIds: [] }
      byKey.set(key, j)
      out.push(j)
    }
    for (const id of ids) if (!j.trayIds.includes(id)) j.trayIds.push(id)
  }

  const world = trays.map((t) =>
    t.points.map((p) => cellToWorld(plan, p[0], p[1]))
  )
  // A polyline's own vertices — but only where it genuinely turns.
  world.forEach((pts, t) => {
    for (let i = 1; i < pts.length - 1; i++)
      if (turnsAt(pts[i - 1], pts[i], pts[i + 1])) add(pts[i], trays[t].id)
    // A CLOSED run (last point back on the first) turns at that shared
    // vertex too, and it is neither an interior vertex nor a free end — so
    // it was skipped entirely and its two rails ran through each other.
    // Every rectangular ring drawn in the editor has exactly this corner.
    const n = pts.length
    const closed =
      n > 3 &&
      Math.hypot(pts[0][0] - pts[n - 1][0], pts[0][1] - pts[n - 1][1]) < 1e-9
    if (closed && turnsAt(pts[n - 2], pts[0], pts[1])) add(pts[0], trays[t].id)
  })
  // …and every tee or crossing BETWEEN trays.
  for (let a = 0; a < world.length; a++) {
    for (let b = a + 1; b < world.length; b++) {
      for (let i = 0; i < world[a].length - 1; i++) {
        for (let j = 0; j < world[b].length - 1; j++) {
          const hit = segmentCrossing(
            world[a][i],
            world[a][i + 1],
            world[b][j],
            world[b][j + 1]
          )
          if (hit) add(hit, trays[a].id, trays[b].id)
        }
      }
    }
  }
  return out
}

/** The tallest cabinet top in the room (m) — what a tray-less run must clear. */
export function tallestRackTopM(scene: ScenePayload): number {
  let top = 0
  for (const t of scene.tiles) {
    if (!t.rack) continue
    top = Math.max(top, rackFootprintM(t.rack).height)
  }
  return top
}

/**
 * Ride height for a run that follows NO tray — over the cabinets, under the
 * ceiling.
 *
 * The old constant was two thirds of the ceiling: 1.98 m in a 3 m room, which
 * is BELOW the top of a 42U cabinet (~1.97 m plus its cap). Every
 * point-to-point run therefore flew at cabinet height and sliced diagonally
 * through every rack between its ends. Clearing the tallest cabinet keeps the
 * abstract "no duct assigned" read without driving cable through steel.
 */
export function freeAirRideY(scene: ScenePayload, lift = 0): number {
  const ceiling = mm(scene.plan.ceiling_mm)
  const overRacks = tallestRackTopM(scene) + 0.3
  const headroom = Math.max(0.15, ceiling - 0.12)
  return Math.min(headroom, Math.max(ceiling * 0.66, overRacks) + lift)
}

/**
 * Cable jacket radius (m) by kind — power reads fatter than fibre.
 *
 * These are deliberately a shade over life size (a real Cat6 is ~3 mm radius)
 * so a run still reads from across the hall, but the first pass doubled that
 * again and every patch lead came out looking like garden hose up close.
 */
export function cableRadiusM(type: string | null | undefined): number {
  const t = (type ?? "").toLowerCase()
  if (t.includes("power")) return 0.007
  if (/smf|mmf|fib|os[12]|om[1-5]|aoc/.test(t)) return 0.003
  return 0.0045
}

/** True when this browser can do WebGL at all (feature gate for the view). */
export function webglSupported(): boolean {
  try {
    const canvas = document.createElement("canvas")
    return !!(canvas.getContext("webgl2") ?? canvas.getContext("webgl"))
  } catch {
    return false
  }
}
