import type {
  ImageLed,
  ImageLeds,
  ImagePortMarker,
  ImagePorts,
} from "@/lib/api"

/**
 * Rack-face images from a 3D model ("studio", docs/dcim/model-packs.md):
 * the pure maths, with no three.js, so it tests without a canvas.
 * floorplan3d/studio renders the assembled model and feeds these.
 *
 * Everything is in the room's frame after the model is fitted
 * (floorplan3d/device-model `fittedModel`): metres, Y up, the model
 * centred on X and Z, standing on y = 0, its front facing −Z. A face image
 * covers the face frame exactly - the rack face (19 inches, or the type's
 * width) by its rack units - so it drops into a rack slot as it is.
 */

export type V3 = [number, number, number]
export type Face = "front" | "rear"

/** The face image's extent in metres. */
export interface FaceFrame {
  w: number
  h: number
}

/** Face images are this many pixels across (their long edge). */
export const FACE_WIDTH_PX = 2000
/** The ¾ view's size. */
export const ISO_SIZE_PX: [number, number] = [1600, 1200]

/** The face frame from the server's `frame_mm` ([width, height or null]);
 * a type with no rack units nor height takes the model's own height. */
export function faceFrame(
  frameMm: readonly [number, number | null],
  modelHeightM: number
): FaceFrame {
  const w = frameMm[0] / 1000
  const h = frameMm[1] != null ? frameMm[1] / 1000 : modelHeightM
  return { w, h: h > 0 ? h : modelHeightM }
}

/** A face image's pixel size: the frame's aspect, its long edge `px`. */
export function faceImagePx(
  frame: FaceFrame,
  px = FACE_WIDTH_PX
): [number, number] {
  if (frame.w >= frame.h)
    return [px, Math.max(1, Math.round((px * frame.h) / frame.w))]
  return [Math.max(1, Math.round((px * frame.w) / frame.h)), px]
}

/** The face a port points out of: its outward direction mostly toward −Z
 * (front) or +Z (rear). A port facing up or sideways shows on neither. */
export function faceOf(n: V3, min = 0.5): Face | null {
  const len = Math.hypot(n[0], n[1], n[2])
  if (len < 1e-9) return null
  const z = n[2] / len
  if (z <= -min) return "front"
  if (z >= min) return "rear"
  return null
}

/** The face nearest a point, when it lies within `slack` of the face
 * plane: what an LED (a small mesh, no direction) sits on. `depth` is the
 * model's depth; the front plane is at −depth/2. */
export function nearestFace(
  p: V3,
  depth: number,
  slack = Math.max(0.03, depth * 0.1)
): Face | null {
  const front = Math.abs(p[2] + depth / 2)
  const rear = Math.abs(p[2] - depth / 2)
  if (Math.min(front, rear) > slack) return null
  return front <= rear ? "front" : "rear"
}

/**
 * A point's place on a face image, 0..1 from the image's top-left corner.
 * Looking at the front (from −Z) the room's +X is on the left; looking at
 * the rear it is on the right.
 */
export function projectToFace(
  p: V3,
  face: Face,
  frame: FaceFrame
): { x: number; y: number } {
  const half = frame.w / 2
  const x = face === "front" ? (half - p[0]) / frame.w : (p[0] + half) / frame.w
  const y = (frame.h - p[1]) / frame.h
  return { x, y }
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v))
const round5 = (v: number) => Math.round(v * 1e5) / 1e5

/**
 * The size of a port's box on the face (mm, width × height), from its
 * component kind and type slug. The cage or jack outline as seen head-on;
 * close enough to click and to colour, never a measurement.
 */
export const PORT_BOX_MM = {
  sfp: [14, 9.5],
  qsfp: [19, 9.5],
  osfp: [23, 13],
  cfp: [42, 14],
  rj45: [14, 12],
  usb: [13, 6],
  usbc: [9, 4],
  serial: [31, 12],
  lc: [13, 9],
  mpo: [13, 8],
  coax: [10, 10],
  iec: [28, 20],
  iec_c20: [32, 22],
  other: [12, 10],
} as const satisfies Record<string, readonly [number, number]>

export type PortBoxKind = keyof typeof PORT_BOX_MM

/** Which box a component wears: by its type slug first, then its kind. */
export function portBoxKind(
  kind: string,
  type: string | null | undefined
): PortBoxKind {
  const t = (type ?? "").toLowerCase()
  if (/osfp/.test(t)) return "osfp"
  if (/qsfp|qsfpdd|qsfp-dd/.test(t)) return "qsfp"
  if (/cfp/.test(t)) return "cfp"
  if (/sfp|xfp|x2|gbic/.test(t)) return "sfp"
  if (/usb-c|usb-type-c/.test(t)) return "usbc"
  if (/usb/.test(t)) return "usb"
  if (/c20|c19/.test(t)) return "iec_c20"
  if (/iec-60320|c14|c16|c13|c15|nema|cee/.test(t)) return "iec"
  if (/de-9|db-9|db-25|de9|serial/.test(t)) return "serial"
  if (/mpo|mtp/.test(t)) return "mpo"
  if (/lc|sc|st|fc|e2000|splice/.test(t)) return "lc"
  if (/bnc|f-type|coax|smb|sma|n-type/.test(t)) return "coax"
  if (
    /base-t|rj-?45|8p8c|rj-?11|base-tx|-t$|^1000base|^100base|^10gbase-t/.test(
      t
    )
  )
    return "rj45"
  if (kind === "console-port" || kind === "console-server-port") return "rj45"
  if (kind === "power-port" || kind === "power-outlet") return "iec"
  if (kind === "front-port" || kind === "rear-port") return "lc"
  return "other"
}

/** The largest opening (m) the size extras may name - a typo guard, as
 * the server's scan has it (api.model_anchors.MAX_OPENING_M). */
export const MAX_OPENING_M = 0.5

/**
 * A `port:` empty's opening from its glTF extras (export spec v1.4):
 * `danbyte_w` × `danbyte_h` (m, along the empty's local X and Y as seen
 * from the front) and an optional corner radius `danbyte_r`, capped at half
 * the short side. Null without both sizes or with one out of range - the
 * caller falls back to `PORT_BOX_MM`. The same rules as the server's scan.
 */
export function openingFromExtras(
  extras: unknown
): { w: number; h: number; r: number } | null {
  if (!extras || typeof extras !== "object") return null
  const e = extras as Record<string, unknown>
  const num = (v: unknown) =>
    typeof v === "number" && Number.isFinite(v) ? v : null
  const w = num(e.danbyte_w)
  const h = num(e.danbyte_h)
  if (w == null || h == null) return null
  if (!(w > 0 && w <= MAX_OPENING_M && h > 0 && h <= MAX_OPENING_M)) return null
  const r = num(e.danbyte_r)
  return { w, h, r: r != null && r > 0 ? Math.min(r, w / 2, h / 2) : 0 }
}

/**
 * An opening's axis-aligned extent on a face seen along Z (X and Y spans):
 * `w` along `u` by `h` along `n × u`, however the port is turned. A port
 * on its side swaps them.
 */
export function openingExtent(
  u: V3,
  n: V3,
  w: number,
  h: number
): [number, number] {
  const v: V3 = [
    n[1] * u[2] - n[2] * u[1],
    n[2] * u[0] - n[0] * u[2],
    n[0] * u[1] - n[1] * u[0],
  ]
  const lv = Math.hypot(...v) || 1
  return [
    Math.abs(u[0]) * w + (Math.abs(v[0]) / lv) * h,
    Math.abs(u[1]) * w + (Math.abs(v[1]) / lv) * h,
  ]
}

/** One `port:` anchor found in the assembled model. */
export interface PortAnchor {
  /** The port's name, `{module}` already resolved. */
  name: string
  p: V3
  /** Its outward direction. */
  n: V3
  /** The opening's exact width × height (m, room frame) from the model's
   * size extras, and its width axis; absent, the box comes from
   * `PORT_BOX_MM`. */
  size?: [number, number]
  u?: V3
}

export interface Placed<T> {
  doc: { front: T[]; rear: T[] }
  /** Names that matched no component, kept anyway as interfaces. */
  unknown: string[]
  /** Names facing neither face. */
  offFace: string[]
}

/**
 * `image_ports` from the model's port anchors: each projected onto the
 * face it points out of, its box the model's exact opening (`size`) or,
 * without one, sized by `portBoxKind`, centre-anchored and normalised. `index` names each port's component `[kind, type]`.
 */
export function imagePortsFromAnchors(
  anchors: readonly PortAnchor[],
  index: Readonly<Record<string, readonly [string, string] | undefined>>,
  frame: FaceFrame
): Placed<ImagePortMarker> {
  const doc: { front: ImagePortMarker[]; rear: ImagePortMarker[] } = {
    front: [],
    rear: [],
  }
  const unknown: string[] = []
  const offFace: string[] = []
  const seen = new Set<string>()
  for (const a of anchors) {
    if (!a.name || a.name.length > 64 || seen.has(a.name)) continue
    seen.add(a.name)
    const face = faceOf(a.n)
    if (!face) {
      offFace.push(a.name)
      continue
    }
    const known = index[a.name]
    if (!known) unknown.push(a.name)
    const kind = known?.[0] ?? "interface"
    // The model's exact opening where it names one, else the type's box.
    const box = PORT_BOX_MM[portBoxKind(kind, known?.[1])]
    const [wm, hm] =
      a.size && a.u
        ? openingExtent(a.u, a.n, a.size[0], a.size[1])
        : [box[0] / 1000, box[1] / 1000]
    const { x, y } = projectToFace(a.p, face, frame)
    if (x < 0 || x > 1 || y < 0 || y > 1) {
      offFace.push(a.name)
      continue
    }
    doc[face].push({
      kind,
      name: a.name,
      x: round5(x),
      y: round5(y),
      w: round5(clamp01(wm / frame.w)),
      h: round5(clamp01(hm / frame.h)),
    })
  }
  return { doc, unknown, offFace }
}

export type { ImageLed, ImageLeds }

/** One `led:` node found in the assembled model, with its world box. */
export interface LedBox {
  id: string
  bay?: string
  min: V3
  max: V3
}

/** An LED's source from a `leds:` block: its own key, else `port:*` for a
 * port LED. */
export function ledSource(
  id: string,
  leds:
    Readonly<Record<string, { source?: string } | undefined>> | null | undefined
): string | undefined {
  if (!leds) return undefined
  const own = leds[id]?.source
  if (own) return own
  if (id.startsWith("port:")) return leds["port:*"]?.source
  return undefined
}

/**
 * `image_leds` from the LED meshes' boxes: each on the face it sits on,
 * its box the mesh's own outline on that face. `depth` is the model's.
 */
export function imageLedsFromBoxes(
  boxes: readonly LedBox[],
  sources: (b: LedBox) => string | undefined,
  frame: FaceFrame,
  depth: number
): Placed<ImageLed> {
  const doc: ImageLeds = { front: [], rear: [] }
  const offFace: string[] = []
  const seen = new Set<string>()
  for (const b of boxes) {
    const key = `${b.bay ?? ""}\u0000${b.id}`
    if (seen.has(key)) continue
    seen.add(key)
    const c: V3 = [
      (b.min[0] + b.max[0]) / 2,
      (b.min[1] + b.max[1]) / 2,
      (b.min[2] + b.max[2]) / 2,
    ]
    const face = nearestFace(c, depth)
    const label = b.bay ? `${b.bay}: ${b.id}` : b.id
    if (!face) {
      offFace.push(label)
      continue
    }
    const { x, y } = projectToFace(c, face, frame)
    if (x < 0 || x > 1 || y < 0 || y > 1) {
      offFace.push(label)
      continue
    }
    const source = sources(b)
    doc[face].push({
      kind: "led",
      name: b.id,
      ...(b.bay ? { bay: b.bay } : {}),
      ...(source ? { source } : {}),
      x: round5(x),
      y: round5(y),
      w: round5(clamp01(Math.max(b.max[0] - b.min[0], 0.001) / frame.w)),
      h: round5(clamp01(Math.max(b.max[1] - b.min[1], 0.001) / frame.h)),
    })
  }
  return { doc, unknown: [], offFace }
}

/** The ¾ view's camera direction (from the model toward the camera): the
 * front, from the right and a little above - the 3D card's view. */
export const ISO_DIRECTION: V3 = [0.45, 0.35, -0.85]

/**
 * The orthographic window that holds every point (in camera space: x right,
 * y up) at the image's aspect, with a margin: `[left, right, top, bottom]`.
 */
export function fitWindow(
  points: readonly V3[],
  aspect: number,
  margin = 0.04
): [number, number, number, number] {
  let x0 = Infinity
  let x1 = -Infinity
  let y0 = Infinity
  let y1 = -Infinity
  for (const [x, y] of points) {
    x0 = Math.min(x0, x)
    x1 = Math.max(x1, x)
    y0 = Math.min(y0, y)
    y1 = Math.max(y1, y)
  }
  if (!Number.isFinite(x0)) return [-1, 1, 1, -1]
  let w = Math.max(x1 - x0, 1e-6) * (1 + 2 * margin)
  let h = Math.max(y1 - y0, 1e-6) * (1 + 2 * margin)
  if (w / h > aspect) h = w / aspect
  else w = h * aspect
  const cx = (x0 + x1) / 2
  const cy = (y0 + y1) / 2
  return [cx - w / 2, cx + w / 2, cy + h / 2, cy - h / 2]
}

/** What generation would replace that was made by hand. */
export type StudioTarget = "front" | "rear" | "iso" | "image_ports"

/** The hand-made targets a save replaces: only those the user ticked. The
 * server holds the same rule (api.model_studio.store). */
export function overwriteList(
  handMade: readonly string[],
  confirmed: ReadonlySet<string>
): string[] {
  return handMade.filter((t) => confirmed.has(t))
}

/** `image_ports` as the server stores it, with each face's calibration:
 * a generated face is exactly the frame's width. */
export function generatedImagePorts(
  doc: { front: ImagePortMarker[]; rear: ImagePortMarker[] },
  frameMm: number
): ImagePorts {
  const cal = {
    left: 0,
    right: 1,
    span_mm: Math.round(frameMm * 10) / 10,
    rail: null,
  }
  return {
    ...doc,
    view: { front: { cal }, rear: { cal } },
  }
}
