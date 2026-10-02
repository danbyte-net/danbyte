import type { Device, DinProfile, DinRail } from "@/lib/api"
import { PROFILE_HEIGHT_MM, deviceBody } from "@/lib/din-geometry"
import type { PlateBox } from "@/lib/photo-calibration"

import { mm } from "./world"

// A DIN-rail cabinet opened up in 3D (#277): its door, the mounting plate,
// the rails and the devices on them, placed from the same millimetres the
// 2D plate is drawn from. Three-free, so the numbers are unit-tested.
//
// The cabinet's own frame is the room's: metres, the box standing on y = 0,
// centred on x and z, its front to −Z. Facing the front you look along +Z,
// so your left is +x - the plate's x (from its left edge, as the API
// measures rails and devices) runs toward −x, and its y (from its top) runs
// down.

/** The enclosure's sheet steel where the open box shows its edges, m. */
export const CABINET_WALL_M = 0.004
/** The door's thickness - folded steel, m. The closed door fills the
 * box's front this deep, so shut it is the plain box again. */
export const CABINET_DOOR_M = 0.018
/** The mounting plate's thickness, and how far its stand-offs hold it off
 * the back wall, m. */
export const PLATE_T_M = 0.003
export const PLATE_STANDOFF_M = 0.012
/** How far each rail profile stands proud of the plate, mm: the TS 35 top
 * hat 7.5, the TS 15 5.5, the G rail 15. Its height on the plate is the
 * band the 2D drawing gives it (`PROFILE_HEIGHT_MM`). */
export const RAIL_DEPTH_MM: Record<DinProfile, number> = {
  ts35: 7.5,
  ts15: 5.5,
  g32: 15,
}
/** How deep a device is drawn when its type records no depth, mm. */
export const DEVICE_DEPTH_FALLBACK_MM = 90
/** How far the door swings open about its hinge, and how long it takes. */
export const DOOR_OPEN_RAD = (110 * Math.PI) / 180
export const DOOR_SWING_S = 0.6

/** An axis-aligned box in the cabinet's frame: its centre and size, m. */
export interface Box3M {
  center: [number, number, number]
  size: [number, number, number]
}

/** The cabinet's outer box, m. */
export interface CabinetBoxM {
  width: number
  height: number
  depth: number
}

/** Where the mounting plate stands in the cabinet, m: `left` is the x of
 * its left edge as you face it, `top` the y of its top edge, `front` the z
 * of its face. Centred across the front, as the 2D drawing centres the
 * plate in the box; its back on stand-offs in front of the back wall. */
export interface PlateFrameM {
  left: number
  top: number
  front: number
  width: number
  height: number
}

export function plateFrameM(
  box: CabinetBoxM,
  plate: { width_mm: number; height_mm: number }
): PlateFrameM {
  const width = mm(plate.width_mm)
  const height = mm(plate.height_mm)
  const back = box.depth / 2 - CABINET_WALL_M - PLATE_STANDOFF_M
  return {
    left: width / 2,
    top: (box.height + height) / 2,
    front: back - PLATE_T_M,
    width,
    height,
  }
}

/** The plate itself as a box. */
export function plateBoxM(frame: PlateFrameM): Box3M {
  return {
    center: [
      frame.left - frame.width / 2,
      frame.top - frame.height / 2,
      frame.front + PLATE_T_M / 2,
    ],
    size: [frame.width, frame.height, PLATE_T_M],
  }
}

/** A point on the plate - mm from its top-left corner, as rails and devices
 * are placed - in the cabinet's frame (x, y). */
export function platePointM(
  frame: PlateFrameM,
  xMm: number,
  yMm: number
): [number, number] {
  return [frame.left - mm(xMm), frame.top - mm(yMm)]
}

/** A rail as a bar: as long as the rail, as high as its profile's band,
 * standing its profile's depth proud of the plate. */
export function railBoxM(
  frame: PlateFrameM,
  rail: Pick<DinRail, "profile" | "x_mm" | "y_mm" | "length_mm">
): Box3M {
  const depth = mm(RAIL_DEPTH_MM[rail.profile])
  const [x, y] = platePointM(frame, rail.x_mm + rail.length_mm / 2, rail.y_mm)
  return {
    center: [x, y, frame.front - depth / 2],
    size: [mm(rail.length_mm), mm(PROFILE_HEIGHT_MM[rail.profile]), depth],
  }
}

/** A device on its rail as a box: its body where the 2D plate draws it,
 * its back on the rail's face, as deep as its type (or the fallback). */
export function deviceBoxM(
  frame: PlateFrameM,
  body: PlateBox,
  profile: DinProfile,
  depthMm: number | null | undefined
): Box3M {
  const depth = mm(depthMm && depthMm > 0 ? depthMm : DEVICE_DEPTH_FALLBACK_MM)
  const back = frame.front - mm(RAIL_DEPTH_MM[profile])
  const [x, y] = platePointM(
    frame,
    body.x + body.width / 2,
    body.y + body.height / 2
  )
  return {
    center: [x, y, back - depth / 2],
    size: [mm(body.width), mm(body.height), depth],
  }
}

/** One device the interior draws: its row, its rail, its body on the plate
 * (mm) and its box in the cabinet. */
export interface PlacedDevice {
  device: Device
  rail: DinRail
  body: PlateBox
  box: Box3M
}

/** The devices on the cabinet's rails, placed. A device off a rail, or of
 * a type with no size, has no place on the plate and is left out - as the
 * 2D plate leaves it out. `depthOf` gives a device type's depth, mm. */
export function placeDevices(
  frame: PlateFrameM,
  rails: DinRail[],
  devices: Device[],
  depthOf: (typeId: string) => number | null | undefined
): PlacedDevice[] {
  const railById = new Map(rails.map((r) => [r.id, r]))
  const out: PlacedDevice[] = []
  for (const device of devices) {
    const rail = device.din_rail ? railById.get(device.din_rail.id) : undefined
    const body = rail
      ? deviceBody(rail, device.din_offset_mm, device.device_type)
      : null
    if (!rail || !body) continue
    const typeId = device.device_type?.id
    out.push({
      device,
      rail,
      body,
      box: deviceBoxM(
        frame,
        body,
        rail.profile,
        typeId ? depthOf(typeId) : null
      ),
    })
  }
  return out
}

/** The part of a device's front its photo covers, and the photo's share of
 * that part: the photo's box on the plate (`cabinetPhotoBox`, or the body
 * itself for a photo stretched over it) clipped to the body, as the 2D
 * drawing clips it. `uv` is [u0, v0, u1, v1] - u from the photo's left, v
 * from its bottom, a texture's way round. Null where they do not meet. */
export function photoFace(
  body: PlateBox,
  photo: PlateBox
): { rect: PlateBox; uv: [number, number, number, number] } | null {
  if (photo.width <= 0 || photo.height <= 0) return null
  const x0 = Math.max(body.x, photo.x)
  const x1 = Math.min(body.x + body.width, photo.x + photo.width)
  const y0 = Math.max(body.y, photo.y)
  const y1 = Math.min(body.y + body.height, photo.y + photo.height)
  if (x1 - x0 <= 1e-6 || y1 - y0 <= 1e-6) return null
  const u = (x: number) => (x - photo.x) / photo.width
  const v = (y: number) => 1 - (y - photo.y) / photo.height
  return {
    rect: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 },
    uv: [u(x0), v(y1), u(x1), v(y0)],
  }
}

/** Where a part of a body's front sits from the body's centre, m (x, y in
 * the cabinet's frame) - the photo's plane on the device's face. */
export function offsetOnBodyM(
  body: PlateBox,
  rect: PlateBox
): [number, number] {
  const dx = rect.x + rect.width / 2 - (body.x + body.width / 2)
  const dy = rect.y + rect.height / 2 - (body.y + body.height / 2)
  return [-mm(dx), -mm(dy)]
}

/** The enclosure with its front taken off - for while the door is not
 * shut: two sides the full depth behind the door, the top and bottom
 * between them, the back wall in the frame they leave. No two walls
 * overlap, so no face is drawn twice, and with the door shut they make the
 * whole box again. */
export function shellWallsM(box: CabinetBoxM): Box3M[] {
  const { width: w, height: h, depth: d } = box
  const t = CABINET_WALL_M
  // Everything behind the door: the sides, top and bottom run to the
  // back; the back wall fills the frame they leave.
  const from = -d / 2 + CABINET_DOOR_M
  const run = d / 2 - from
  const z = from + run / 2
  return [
    { center: [w / 2 - t / 2, h / 2, z], size: [t, h, run] },
    { center: [-w / 2 + t / 2, h / 2, z], size: [t, h, run] },
    { center: [0, h - t / 2, z], size: [w - 2 * t, t, run] },
    { center: [0, t / 2, z], size: [w - 2 * t, t, run] },
    { center: [0, h / 2, d / 2 - t / 2], size: [w - 2 * t, h - 2 * t, t] },
  ]
}

/** Can an eye at `p`, in the cabinet's frame, see the insides of the open
 * box? Only through the opening - from in front of the front plane - or
 * from inside the box. From anywhere else they are behind steel. */
export function seesInside(
  p: [number, number, number],
  box: CabinetBoxM
): boolean {
  const [x, y, z] = p
  if (z < -box.depth / 2) return true
  return (
    Math.abs(x) < box.width / 2 && y > 0 && y < box.height && z < box.depth / 2
  )
}

/** The door's hinge line: its left edge as you face it (+x), on the front
 * plane (x, z). The door swings about it. */
export function doorHingeM(box: CabinetBoxM): [number, number] {
  return [box.width / 2, -box.depth / 2]
}

/** The door's swing `dt` seconds on, toward open (1) or shut (0). */
export function doorStep(
  progress: number,
  open: boolean,
  dt: number,
  seconds = DOOR_SWING_S
): number {
  const step = seconds > 0 ? dt / seconds : 1
  return open ? Math.min(1, progress + step) : Math.max(0, progress - step)
}

/** The door's angle about its hinge for a swing `progress`, eased in and
 * out: 0 shut, −DOOR_OPEN_RAD open. Negative, so the free edge comes out
 * toward you (−Z) as it turns. */
export function doorAngle(progress: number): number {
  const t = Math.min(1, Math.max(0, progress))
  const k = t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2
  return -DOOR_OPEN_RAD * k
}

/** Where a corner of the door ends up, from the hinge, after turning it by
 * `angle` - for the tests, and for whoever needs to know where the free
 * edge is. Local point (x, z) from the hinge. */
export function swingPoint(
  x: number,
  z: number,
  angle: number
): [number, number] {
  const c = Math.cos(angle)
  const s = Math.sin(angle)
  return [x * c + z * s, -x * s + z * c]
}
