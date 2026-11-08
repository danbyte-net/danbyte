import type { ImagePortMarker } from "@/lib/api"
import { liveHex, portHex } from "@/lib/faceplate-colors"
import { naturalCompare } from "@/lib/natural-sort"

/**
 * Ports mapped onto a device's 3D model (`model_ports`, api.model_ports):
 * the photo-port idea on the model instead of a photo. Pure maths shared by
 * the editor, the room's markers and the cable ends - no three.js here, so
 * it tests without a canvas.
 *
 * A port's `p` is its spot in the model's UPRIGHT bounding box (after the
 * up/front fix that stands it on the floor, front on −Z), 0..1 on each
 * axis: x along +X, y bottom to top, z front (0) to back (1). `n` is the
 * outward surface normal in the same frame, unit length. `bounds` is the
 * upright box's size in model units, what the room fits the model with
 * before its file has loaded.
 */

export type V3 = [number, number, number]

export interface ModelPort {
  kind: string
  name: string
  p: V3
  n: V3
}

export interface ModelPortsDoc {
  bounds: V3
  ports: ModelPort[]
}

/** The kinds a model port can be: what carries a cable. */
export const MODEL_PORT_KINDS = [
  "interface",
  "front-port",
  "rear-port",
  "console-port",
  "console-server-port",
  "power-port",
  "power-outlet",
] as const
export type ModelPortKind = (typeof MODEL_PORT_KINDS)[number]

export const MODEL_PORT_KIND_LABEL: Record<ModelPortKind, string> = {
  interface: "Interfaces",
  "front-port": "Front ports",
  "rear-port": "Rear ports",
  "console-port": "Console ports",
  "console-server-port": "Console server ports",
  "power-port": "Power ports",
  "power-outlet": "Power outlets",
}

/** A marker's edge in the room (m): small enough for a 48-port row. */
export const PORT_MARKER_M = 0.008
/** Markers show inside this distance (m) and hide past the far one - the
 * gap keeps them from flickering at the edge. */
export const PORT_MARKER_SHOW_M = 3.5
export const PORT_MARKER_HIDE_M = 4.5

export const portKey = (p: { kind: string; name: string }) =>
  `${p.kind}:${p.name}`

const clamp01 = (v: number) => Math.max(0, Math.min(1, v))
const round = (v: number, d = 5) => Math.round(v * 10 ** d) / 10 ** d

export function unit(v: V3): V3 {
  const l = Math.hypot(v[0], v[1], v[2])
  if (l < 1e-9) return [0, 0, -1]
  return [v[0] / l, v[1] / l, v[2] / l]
}

/** A point in the upright frame → its 0..1 spot in the box `min`..`max`. */
export function normalisePoint(point: V3, min: V3, max: V3): V3 {
  return [0, 1, 2].map((i) => {
    const span = max[i] - min[i]
    return round(span > 1e-12 ? clamp01((point[i] - min[i]) / span) : 0.5)
  }) as V3
}

/** A 0..1 spot back to a point in the box `min`..`max`. */
export function denormalisePoint(p: V3, min: V3, max: V3): V3 {
  return [0, 1, 2].map((i) => min[i] + p[i] * (max[i] - min[i])) as V3
}

/** A raycast hit on the upright model as a port: its 0..1 spot and its
 * outward unit normal. */
export function portFromHit(
  hit: { point: V3; normal: V3 },
  min: V3,
  max: V3
): { p: V3; n: V3 } {
  const n = unit(hit.normal)
  return {
    p: normalisePoint(hit.point, min, max),
    n: n.map((v) => round(v)) as V3,
  }
}

/**
 * Where a mapped port sits on the model as the room places it (m), local to
 * the device's group: the fitted model is centred on X and Z and stands on
 * y = 0, its upright size `size` (fittedModel's). Front is −Z.
 */
export function portLocal(p: V3, size: V3): V3 {
  return [(p[0] - 0.5) * size[0], p[1] * size[1], (p[2] - 0.5) * size[2]]
}

/**
 * The room's fitted size (m) for a model whose upright size is `bounds`:
 * the same uniform scale `modelScale` gives (`scale`), so a cable can end at
 * a port before the model has loaded.
 */
export function fittedSize(bounds: V3, scale: number): V3 {
  return [bounds[0] * scale, bounds[1] * scale, bounds[2] * scale]
}

/** Whether a device's markers draw at `dist` (m), given whether they do now. */
export function markersVisible(dist: number, showing: boolean): boolean {
  return showing ? dist <= PORT_MARKER_HIDE_M : dist <= PORT_MARKER_SHOW_M
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t
const lerp3 = (a: V3, b: V3, t: number): V3 => [
  lerp(a[0], b[0], t),
  lerp(a[1], b[1], t),
  lerp(a[2], b[2], t),
]

/**
 * A row of ports between two placed ones, evenly spaced: `names` is the
 * run in order, first and last included, `a` and `b` where the first and
 * last went. One row lays them on the line from `a` to `b`. Two rows lay
 * the common switch layout - odd ports on `a`'s row, even ports on `b`'s,
 * one column per pair: the first port top-left, the last bottom-right.
 * Positions come out on the straight line; the editor drops each onto the
 * surface after.
 */
export function rowFill(
  a: Pick<ModelPort, "p" | "n">,
  b: Pick<ModelPort, "p" | "n">,
  names: string[],
  kind: string,
  rows: 1 | 2
): ModelPort[] {
  const n = names.length
  if (n === 0) return []
  const normal = unit(lerp3(a.n, b.n, 0.5))
  const at = (p: V3, t: number, q: V3): ModelPort["p"] =>
    lerp3(p, q, t).map((v) => round(clamp01(v))) as V3
  if (rows === 1 || n < 3) {
    return names.map((name, i) => {
      const t = n > 1 ? i / (n - 1) : 0
      return { kind, name, p: at(a.p, t, b.p), n: unit(lerp3(a.n, b.n, t)) }
    })
  }
  // Two rows: a's row runs from a to b's column at a's height; b's row from
  // a's column at b's height to b.
  const cols = Math.ceil(n / 2)
  const topEnd: V3 = [b.p[0], a.p[1], b.p[2]]
  const bottomStart: V3 = [a.p[0], b.p[1], a.p[2]]
  return names.map((name, i) => {
    const col = Math.floor(i / 2)
    const t = cols > 1 ? col / (cols - 1) : 0
    const top = i % 2 === 0
    return {
      kind,
      name,
      p: top ? at(a.p, t, topEnd) : at(bottomStart, t, b.p),
      n: normal,
    }
  })
}

/** The names from `from` to `to` (either order) in `all`'s natural order. */
export function runBetween(all: string[], from: string, to: string): string[] {
  const sorted = [...all].sort(naturalCompare)
  const i = sorted.indexOf(from)
  const j = sorted.indexOf(to)
  if (i < 0 || j < 0) return []
  return i <= j ? sorted.slice(i, j + 1) : sorted.slice(j, i + 1).reverse()
}

/**
 * A photo port as a starting point on the model: the front photo is the
 * box's front face (z = 0, normal −Z) seen from in front, so the photo's
 * left is the model's +X side; the rear photo is the back face (z = 1,
 * normal +Z) seen from behind. Photo y runs down, the model's up.
 */
export function photoToModel(
  m: Pick<ImagePortMarker, "x" | "y">,
  side: "front" | "rear"
): { p: V3; n: V3 } {
  const x = clamp01(m.x)
  const y = round(clamp01(1 - m.y))
  return side === "front"
    ? { p: [round(1 - x), y, 0], n: [0, 0, -1] }
    : { p: [round(x), y, 1], n: [0, 0, 1] }
}

/** The type's photo ports as model ports of the mappable kinds, front and
 * rear; ports already mapped are left as they are. */
export function portsFromPhotos(
  photo: { front?: ImagePortMarker[]; rear?: ImagePortMarker[] } | null,
  mapped: ModelPort[]
): ModelPort[] {
  if (!photo) return []
  const have = new Set(mapped.map(portKey))
  const out: ModelPort[] = []
  for (const side of ["front", "rear"] as const) {
    for (const m of photo[side] ?? []) {
      const kind = m.kind || "interface"
      if (!(MODEL_PORT_KINDS as readonly string[]).includes(kind)) continue
      const key = portKey({ kind, name: m.name })
      if (have.has(key)) continue
      have.add(key)
      out.push({ kind, name: m.name, ...photoToModel(m, side) })
    }
  }
  return out
}

/** The port after `current` in `list` order that has no mapping yet,
 * wrapping round; null when every port is mapped. */
export function nextUnmapped<T extends { kind: string; name: string }>(
  list: T[],
  mapped: ReadonlySet<string>,
  current: T | null
): T | null {
  if (list.length === 0) return null
  const start = current
    ? list.findIndex((p) => portKey(p) === portKey(current)) + 1
    : 0
  for (let k = 0; k < list.length; k++) {
    const p = list[(start + k) % list.length]
    if (!mapped.has(portKey(p))) return p
  }
  return null
}

/** `ports` with `next` placed: a port mapped again moves, it never
 * doubles. */
export function placePorts(ports: ModelPort[], next: ModelPort[]): ModelPort[] {
  const keys = new Set(next.map(portKey))
  return [...ports.filter((p) => !keys.has(portKey(p))), ...next]
}

/** What the editor's Save sends: the whole mapping and the version it was
 * opened at. No ports left on a type clears it. */
export function savePayload(
  bounds: V3,
  ports: ModelPort[],
  version: string
): { version: string; model_ports: ModelPortsDoc | null } {
  return {
    version,
    model_ports: ports.length
      ? {
          bounds: bounds.map((b) => round(b, 6)) as V3,
          ports: ports.map((p) => ({
            kind: p.kind,
            name: p.name,
            p: p.p.map((v) => round(clamp01(v))) as V3,
            n: unit(p.n).map((v) => round(v)) as V3,
          })),
        }
      : null,
  }
}

/** Whether a mapping made on a model of upright size `a` carries over to
 * one of size `b`: the same proportions, each axis within 5% of the
 * longest. The server checks the same. */
export function similarBounds(
  a: V3 | null | undefined,
  b: V3 | null | undefined
): boolean {
  if (!a || !b || Math.min(...a) <= 0 || Math.min(...b) <= 0) return false
  const ma = Math.max(...a)
  const mb = Math.max(...b)
  return a.every((x, i) => Math.abs(x / ma - b[i] / mb) <= 0.05)
}

// ─── Marker colour ───────────────────────────────────────────────────────────

/** A mapped name no component on the device answers to. */
export const MODEL_PORT_UNDEFINED = "#3f3f46"
/** The selected port. */
export const MODEL_PORT_SELECTED = "#fbbf24"

/** A mapped port's colour in the room - the port-state colours every
 * faceplate uses: live SNMP when the device was polled (up by speed, down
 * red, shut grey), else intent - cabled by speed, free and disabled grey. */
export function modelPortHex(
  fp: {
    id: string | null
    enabled: boolean
    connected: boolean
    speed: string
    type: string
  } | null,
  observed?: { oper_status: string; admin_status: string; speed_mbps?: string }
): string {
  if (!fp?.id) return MODEL_PORT_UNDEFINED
  if (observed) return liveHex(observed)
  return portHex({
    enabled: fp.enabled,
    cable: fp.connected,
    speed: fp.speed,
    type: fp.type,
  })
}

// ─── Undo / redo ─────────────────────────────────────────────────────────────

export interface History<T> {
  past: T[]
  present: T
  future: T[]
}

export const historyOf = <T>(present: T): History<T> => ({
  past: [],
  present,
  future: [],
})

export function pushHistory<T>(h: History<T>, next: T): History<T> {
  if (next === h.present) return h
  return { past: [...h.past, h.present].slice(-200), present: next, future: [] }
}

export function undo<T>(h: History<T>): History<T> {
  if (!h.past.length) return h
  return {
    past: h.past.slice(0, -1),
    present: h.past[h.past.length - 1],
    future: [h.present, ...h.future],
  }
}

export function redo<T>(h: History<T>): History<T> {
  if (!h.future.length) return h
  return {
    past: [...h.past, h.present],
    present: h.future[0],
    future: h.future.slice(1),
  }
}
