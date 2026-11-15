import { MODEL_PORT_SELECTED, MODEL_PORT_UNDEFINED } from "@/lib/model-ports"

/**
 * How a port marker on a 3D model draws: a thin rim round the port's
 * opening and, where the port carries something, a faint fill - never a
 * solid block over the port's own geometry. The 2D faceplate's language
 * (components/device-faceplate): a cabled port gets its tier colour as
 * rim and a light wash, an idle one an outline only, a held one an amber
 * outline. Hover lightens the rim; the selected port takes the canvases'
 * selection colour.
 */

/** A directly held port, as the faceplate draws it. */
export const MODEL_PORT_RESERVED = "#f59e0b"
/** The fill's opacity: a wash, the port stays readable through it. */
export const MARKER_FILL_OPACITY = 0.22
/** The rim's width, a share of the marker's edge. */
export const MARKER_RIM = 0.1

export type MarkerMode = "idle" | "hover" | "selected"

export interface MarkerLook {
  rim: string
  /** The wash, or null for an outline only. */
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

/** A marker's rim and fill for `port` in `mode`; `hex` is its state colour. */
export function markerLook(
  port: MarkerPort,
  hex: string,
  mode: MarkerMode = "idle"
): MarkerLook {
  if (mode === "selected")
    return { rim: MODEL_PORT_SELECTED, fill: MODEL_PORT_SELECTED }
  let idle: MarkerLook
  if (port.id === null) idle = { rim: MODEL_PORT_UNDEFINED, fill: null }
  else if (port.cable_state === "reserved" && !port.connected)
    idle = { rim: MODEL_PORT_RESERVED, fill: null }
  else if (port.connected || port.cable_state === "marked")
    idle = { rim: hex, fill: hex }
  else idle = { rim: hex, fill: null }
  if (mode === "hover")
    return { rim: lighten(idle.rim, 0.45), fill: idle.fill ?? idle.rim }
  return idle
}
