import { MODEL_PORT_SELECTED, MODEL_PORT_UNDEFINED } from "@/lib/model-ports"
import { PORT_BOX_MM, portBoxKind } from "@/lib/model-studio"

/**
 * How a port marker on a 3D model draws: a thin rim round the port's
 * opening and, where the port carries something, a faint wash - never a
 * solid block over the port's own geometry. The model's own geometry and
 * its port LEDs show the ports, so the default is quiet: a free port draws
 * nothing until it is hovered or selected. A cabled or marked port gets a
 * light wash of its state colour, a held one an amber rim (the 2D
 * faceplate's colours, components/device-faceplate). "Outline all" (the
 * viewers' Ports toggle) rims every port for mapping and inspection.
 *
 * Each marker is the opening's own shape: the exact size the model's
 * `port:` anchor names (export spec size extras), else the standard box
 * for the port's type, turned with the anchor.
 */

/** A directly held port, as the faceplate draws it. */
export const MODEL_PORT_RESERVED = "#f59e0b"
/** The fill's opacity: a wash, the port stays readable through it. */
export const MARKER_FILL_OPACITY = 0.2
/** The fill while pluggables are ghosted: it lies over a pale see-through
 * part, not a dark cage, so a light wash would wash out. */
export const MARKER_FILL_OPACITY_OVER_PART = 0.55

export type MarkerMode = "idle" | "hover" | "selected"

export interface MarkerLook {
  /** The rim, or null for none. */
  rim: string | null
  /** The wash, or null for none. */
  fill: string | null
}

/** What the look needs from a port: whether it resolves, its cable state,
 * and the state colour modelPortHex gives it. */
export interface MarkerPort {
  id?: string | null
  connected?: boolean
  /** free | connected | reserved | marked. */
  cable_state?: string
}

/** `hex` mixed toward white by `t` (0..1). */
export function lighten(hex: string, t: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex)
  if (!m) return hex
  const n = parseInt(m[1], 16)
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) =>
    Math.round(c + (255 - c) * Math.max(0, Math.min(1, t)))
  )
  return `#${ch.map((c) => c.toString(16).padStart(2, "0")).join("")}`
}

/**
 * A marker's rim and wash for `port` in `mode`; `hex` is its state colour.
 * Quiet (the default) draws a free or unresolved port not at all, a cabled
 * or marked one as a wash, a held one as an amber rim; `outlineAll` adds a
 * rim to every port. Hover and selection always show.
 */
export function markerLook(
  port: MarkerPort,
  hex: string,
  mode: MarkerMode = "idle",
  outlineAll = false
): MarkerLook {
  if (mode === "selected")
    return { rim: MODEL_PORT_SELECTED, fill: MODEL_PORT_SELECTED }
  let state: string
  let fill: string | null = null
  let quietRim: string | null = null
  if (port.id === null) state = MODEL_PORT_UNDEFINED
  else if (port.cable_state === "reserved" && !port.connected) {
    state = MODEL_PORT_RESERVED
    quietRim = MODEL_PORT_RESERVED
  } else if (port.connected || port.cable_state === "marked") {
    state = hex
    fill = hex
  } else state = hex
  if (mode === "hover")
    return { rim: lighten(state, 0.45), fill: fill ?? state }
  return { rim: outlineAll ? state : quietRim, fill }
}

export type V3 = [number, number, number]

/** A marker's shape in the room: the opening's width, height and corner
 * radius (m) and its frame - `u` across, `v` up, `n` out of the port. */
export interface MarkerShape {
  w: number
  h: number
  r: number
  u: V3
  v: V3
  n: V3
}

/** What a marker's shape is built from: a mapped port's normal and, from a
 * model's anchors, its opening (`s`/`r` shares of the longest edge, `u`
 * the width axis); kind and type for the standard box. */
export interface ShapedPort {
  n: V3
  s?: readonly [number, number] | null
  u?: V3 | null
  r?: number | null
  kind?: string | null
  type?: string | null
}

const unit = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2])
  return l < 1e-12 ? [0, 0, -1] : [a[0] / l, a[1] / l, a[2] / l]
}
const cross = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
]
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

/** A width axis in the plane facing `n`: `u` with its share along `n`
 * taken out, or - without one, or one along `n` - level (horizontal), so a
 * standard box stands upright on a front or rear face. */
export function acrossAxis(n: V3, u?: V3 | null): V3 {
  if (u) {
    const d = dot(u, n)
    const flat: V3 = [u[0] - d * n[0], u[1] - d * n[1], u[2] - d * n[2]]
    if (Math.hypot(...flat) > 1e-6) return unit(flat)
  }
  if (Math.abs(n[1]) < 0.9) return unit(cross([0, 1, 0], n))
  const d = n[0]
  return unit([1 - d * n[0], -d * n[1], -d * n[2]])
}

/**
 * The marker for `port` on a model fitted to `size` (m): the opening the
 * model's anchor names, scaled by the fitted box's longest edge, else the
 * standard box for its kind and type (`PORT_BOX_MM`). The corner radius is
 * capped at half the short side.
 */
export function markerShape(port: ShapedPort, size: V3): MarkerShape {
  const n = unit(port.n)
  const u = acrossAxis(n, port.u ?? null)
  const v = cross(n, u)
  const longest = Math.max(size[0], size[1], size[2])
  let w: number
  let h: number
  let r = 0
  const s = port.s
  if (s && s[0] > 0 && s[1] > 0 && longest > 0) {
    w = s[0] * longest
    h = s[1] * longest
    r = Math.max(0, (port.r ?? 0) * longest)
  } else {
    const box = PORT_BOX_MM[portBoxKind(port.kind ?? "interface", port.type)]
    w = box[0] / 1000
    h = box[1] / 1000
  }
  return { w, h, r: Math.min(r, w / 2, h / 2), u, v, n }
}

/** The rim's width (m) for an opening `w`×`h`: thin, but never a hairline
 * on a small port nor heavy on a big one. `thick` (the Ports overlay on,
 * or the parts ghosted) about doubles it, so the colour reads at rack
 * distance too. */
export function rimWidth(w: number, h: number, thick = false): number {
  const e = Math.min(w, h)
  return thick
    ? Math.min(0.0025, Math.max(0.0008, e * 0.15))
    : Math.min(0.0012, Math.max(0.0004, e * 0.08))
}

/** How far each marker's rim may reach outside its opening (m) before it
 * touches a neighbour's: half the clear gap to the nearest marker on the
 * same face. `Infinity` for a marker with none. Ports that sit closer
 * than a rim's width - SFP cages 14.25 mm apart, 13.8 mm wide - would
 * otherwise have one port's rim drawn over the next port. */
export function rimRoom(
  markers: readonly { at: V3; shape: MarkerShape }[]
): number[] {
  const room = markers.map(() => Infinity)
  for (let i = 0; i < markers.length; i++) {
    const a = markers[i]
    for (let j = i + 1; j < markers.length; j++) {
      const b = markers[j]
      // Another face of the device: no shared edge to run into.
      if (dot(a.shape.n, b.shape.n) < 0.99) continue
      const d: V3 = [b.at[0] - a.at[0], b.at[1] - a.at[1], b.at[2] - a.at[2]]
      if (Math.abs(dot(d, a.shape.n)) > 0.005) continue
      const dx = Math.abs(dot(d, a.shape.u)) - (a.shape.w + b.shape.w) / 2
      const dy = Math.abs(dot(d, a.shape.v)) - (a.shape.h + b.shape.h) / 2
      const gap = dx > 0 && dy > 0 ? Math.hypot(dx, dy) : Math.max(dx, dy, 0)
      room[i] = Math.min(room[i], gap / 2)
      room[j] = Math.min(room[j], gap / 2)
    }
  }
  return room
}

/** Markers sharing one geometry: the same size and radius, to 0.01 mm. */
export function shapeKey(s: Pick<MarkerShape, "w" | "h" | "r">): string {
  const q = (x: number) => Math.round(x * 1e5)
  return `${q(s.w)}:${q(s.h)}:${q(s.r)}`
}

/**
 * A rounded rectangle's outline, centred, `w`×`h` with corner radius `r`,
 * counter-clockwise from the bottom edge: `seg` points per corner. A zero
 * radius gives the four corners.
 */
export function roundedRect(
  w: number,
  h: number,
  r: number,
  seg = 4
): [number, number][] {
  const hw = w / 2
  const hh = h / 2
  const rr = Math.max(0, Math.min(r, hw, hh))
  if (rr <= 1e-9)
    return [
      [-hw, -hh],
      [hw, -hh],
      [hw, hh],
      [-hw, hh],
    ]
  const out: [number, number][] = []
  const corners: [number, number, number][] = [
    [hw - rr, -hh + rr, -Math.PI / 2],
    [hw - rr, hh - rr, 0],
    [-hw + rr, hh - rr, Math.PI / 2],
    [-hw + rr, -hh + rr, Math.PI],
  ]
  for (const [cx, cy, a0] of corners)
    for (let i = 0; i <= seg; i++) {
      const a = a0 + (i / seg) * (Math.PI / 2)
      out.push([cx + rr * Math.cos(a), cy + rr * Math.sin(a)])
    }
  return out
}
