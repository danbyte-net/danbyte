import type { ImagePorts } from "@/lib/api"
import { OPENING_MM, PANEL_MM } from "@/lib/faceplate-geometry"

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
  position: number
  face: "" | "front" | "rear"
  rack_side: "" | "left" | "right"
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
  as_of: string
}

// ─── Physical constants (metres) ─────────────────────────────────────────────

/** Rack plinth/base under U1 — visual, matches typical cabinet bases. */
export const RACK_BASE_M = 0.1
/** Frame added around the rail opening when outer width isn't recorded. */
export const RACK_FRAME_MM = 150
/** Render default when a rack has no recorded outer depth. */
export const RACK_DEPTH_DEFAULT_M = 1.0
/** Tray cross-section (ladder tray look). */
export const TRAY_W_M = 0.2
export const TRAY_H_M = 0.08
/** Derived tray elevation offsets (mm) when elevation_mm is blank. */
export const OVERHEAD_DROP_MM = 300
export const UNDERFLOOR_MM = -300

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

/** A tray's resolved elevation (m) from its level when not set explicitly. */
export function trayElevationM(
  plan: ScenePayload["plan"],
  tray: SceneTray
): number {
  if (tray.elevation_mm != null) return mm(tray.elevation_mm)
  if (tray.level === "underfloor") return mm(UNDERFLOOR_MM)
  if (tray.level === "floor") return 0
  return mm(plan.ceiling_mm - OVERHEAD_DROP_MM)
}

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
  const height = mm(rack.u_height * PANEL_MM.uPitch) + RACK_BASE_M
  return { width, depth, height }
}

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
  const slotFromBottom = rack.desc_units
    ? rack.u_height - (dev.position - rack.starting_unit) - dev.u_height
    : dev.position - rack.starting_unit
  return {
    y: RACK_BASE_M + slotFromBottom * pitch,
    h: dev.u_height * pitch,
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
  rackWidthM: number,
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
  const dw = dev.rack_width === "half" ? rackWidthM * 0.44 : rackWidthM * 0.92
  const dx =
    dev.rack_side === "left"
      ? -rackWidthM * 0.23
      : dev.rack_side === "right"
        ? rackWidthM * 0.23
        : 0
  const dd = dev.is_full_depth ? rackDepthM * 0.9 : rackDepthM * 0.45
  const mountedRear = dev.face === "rear"
  const dz = mountedRear ? rackDepthM * 0.45 - dd / 2 : dd / 2 - rackDepthM * 0.45
  return { y, h, dx, dz, dw, dd, boxH: h * 0.94, mountedRear }
}

/**
 * A photo-port marker's position local to the RACK group (metres) — the same
 * spot DeviceMesh draws the quad: on the exposed face plane, a hair off the
 * box. Feed through the rack's world transform for a scene position.
 */
export function portLocalM(
  box: ReturnType<typeof deviceBoxM>,
  m: { x: number; y: number }
): [number, number, number] {
  const mx = (m.x - 0.5) * box.dw
  const my = (0.5 - m.y) * box.boxH
  // Front faces −Z via a π turn about Y (mirrors X); rear faces +Z unturned.
  return box.mountedRear
    ? [box.dx + mx, box.y + box.h / 2 + my, box.dz + box.dd / 2 + 0.004]
    : [box.dx - mx, box.y + box.h / 2 + my, box.dz - box.dd / 2 - 0.004]
}

/** True when this browser can do WebGL at all (feature gate for the view). */
export function webglSupported(): boolean {
  try {
    const canvas = document.createElement("canvas")
    return !!(
      canvas.getContext("webgl2") ?? canvas.getContext("webgl")
    )
  } catch {
    return false
  }
}
