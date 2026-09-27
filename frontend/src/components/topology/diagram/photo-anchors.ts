import type { TopoNode, TopologyGraph } from "@/lib/api"
import { fit } from "@/lib/diagram/measure"
import type { Measure } from "@/lib/diagram/measure"
import { CARD, NUB, PILL, pillWidth } from "./card-layout"
import type { Anchor, PortRef, Rect } from "./types"

// Photo nodes: a device drawn as its type's front photo, to scale, with
// every cable landing on the port it is plugged into. Pure - the build, the
// worker and the exports all read it.
//
// A node is a photo when the view (or the node's own override) asks for
// one and the payload (`include=photo`) has one:
//   1. the front photo with port markers - a cable leaves its marker's
//      centre and runs straight up or down to the nearer image edge (its
//      lead), then routes like any other line;
//   2. the front photo without a marker for a port - the cable lands on a
//      stub lead along the image's top or bottom edge, facing its far end;
//   3. no photo but a schematic faceplate (`type_faceplate`) - drawn on
//      screen only, every port a stub lead (its ports have no coordinates);
//   4. neither - the normal card.
// The name is a caption under the image, placed clear of the leads that
// run down through it.

export const PHOTO = {
  /** A 19-inch device's width on the diagram: every photo is drawn to
   * this scale, a half-width one at half of it. */
  W: 480,
  /** A 19-inch panel and a rack unit, mm. */
  RACK_MM: 482.6,
  U_MM: 44.45,
  /** Between the image and the caption under it. */
  CAPTION_GAP: 4,
  /** The caption's line box: the card name's. */
  CAPTION_LH: CARD.TITLE_LH,
  /** Clear space the caption keeps from a lead running down through it. */
  CAPTION_PAD: 6,
  /** The least room the caption steps into between leads. */
  CAPTION_MIN: 40,
  /** The shortest image drawn, px. */
  MIN_H: 12,
  /** Below this zoom the image is a plain box - on a map with `MANY`
   * photos or more; a smaller one keeps its images down to `LOD_FEW`,
   * where a photo is still a hundred pixels wide. */
  LOD: 0.35,
  LOD_FEW: 0.12,
  MANY: 24,
} as const

/** The zoom a map's photos turn into plain boxes below. */
export const photoLod = (photos: number) =>
  photos >= PHOTO.MANY ? PHOTO.LOD : PHOTO.LOD_FEW

/** Card or photo: the view's default, or one node's override. */
export type Face = "card" | "photo"

/** The payload node as the page hands it to the Diagram: `face` marks a
 * device the view shows as its photo (`withFaces`). */
export type FacedData = TopoNode["data"] & { face?: "photo" }

type Overrides = Readonly<Record<string, { face?: Face } | undefined>>

/** The face a device is drawn with: its own override, else the view's. */
export function faceOf(
  deviceId: string | undefined,
  face: Face,
  nodes?: Overrides
): Face {
  return (deviceId && nodes?.[deviceId]?.face) || face
}

/** Does any device on the map want its photo (the query then asks for
 * `include=photo`)? */
export function wantsPhotos(face: Face, nodes?: Overrides): boolean {
  if (face === "photo") return true
  return Object.values(nodes ?? {}).some((v) => v?.face === "photo")
}

/**
 * The graph with the devices the view shows as photos marked (`face`).
 * The same graph back when nothing changes, so the map is not rebuilt.
 */
export function withFaces(
  graph: TopologyGraph,
  face: Face,
  nodes?: Overrides
): TopologyGraph {
  const out = graph.nodes.map((n) => {
    const data = n.data as FacedData
    const want =
      n.type === "device" && faceOf(data.device_id, face, nodes) === "photo"
    if (want === (data.face === "photo")) return n
    if (want) return { ...n, data: { ...data, face: "photo" as const } }
    const { face: _face, ...rest } = data
    return { ...n, data: rest }
  })
  return out.some((n, i) => n !== graph.nodes[i])
    ? { ...graph, nodes: out }
    : graph
}

/** A marker a cable lands on: its port's current name and kind, its box
 * as fractions of the image (centre and size). */
export interface PhotoMark {
  port: string
  /** The termination kind, underscored (`front_port`). */
  kind: string
  x: number
  y: number
  w: number
  h: number
}

/** A photo node's fixed geometry and its markers, from the payload. */
export interface PhotoFace {
  kind: "photo" | "faceplate"
  /** The front photo (`photo`). */
  url?: string
  /** The device type, for the faceplate. */
  typeId?: string
  vc?: number | null
  /** The node's box: the image, the gap and the caption under it. */
  w: number
  h: number
  /** The image's height; it spans the node's width from its top. */
  imgH: number
  marks: PhotoMark[]
  /** `marks` indexes by `<kind>:<component id>` and by bare id… */
  refs: Partial<Record<string, number>>
  /** …and by the port's name, exact then without case or spaces. */
  names: Partial<Record<string, number>>
}

const termKind = (kind: string) => kind.replace(/-/g, "_")
const loose = (name: string) => `~${name.toLowerCase().replace(/\s+/g, "")}`
const frac = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1

/** The height `u` rack units take at the photos' scale. */
function unitsTall(u: number | null | undefined): number {
  return (Math.max(1, u || 1) * PHOTO.W * PHOTO.U_MM) / PHOTO.RACK_MM
}

/**
 * The photo node a device is drawn as, or null for its card: not marked,
 * or nothing to draw (no photo, no faceplate). The image is `PHOTO.W`
 * wide (half that for a half-width type) at the photo's own aspect.
 */
export function photoFace(data: FacedData): PhotoFace | null {
  if (data.face !== "photo" || !data.photo) return null
  const p = data.photo
  const w = p.rack_width === "half" ? PHOTO.W / 2 : PHOTO.W
  const node = (imgH: number) => {
    const h = Math.max(PHOTO.MIN_H, Math.round(imgH))
    return { w, imgH: h, h: h + PHOTO.CAPTION_GAP + PHOTO.CAPTION_LH }
  }
  const vc = p.vc_position ?? null
  if (p.front) {
    const a = p.front.aspect
    const marks: PhotoMark[] = []
    const refs: Partial<Record<string, number>> = {}
    const names: Partial<Record<string, number>> = {}
    for (const m of p.front.markers) {
      if (![m.x, m.y, m.w, m.h].every(frac)) continue
      const i = marks.length
      const kind = termKind(m.kind || "interface")
      marks.push({ port: m.port, kind, x: m.x, y: m.y, w: m.w, h: m.h })
      if (m.port_id) {
        refs[`${kind}:${m.port_id}`] ??= i
        refs[m.port_id] ??= i
      }
      names[m.port] ??= i
      names[loose(m.port)] ??= i
    }
    return {
      kind: "photo",
      url: p.front.url,
      vc,
      ...node(a && a > 0 ? w * a : unitsTall(p.u_height)),
      marks,
      refs,
      names,
    }
  }
  if (p.type_faceplate && data.device_type_id)
    return {
      kind: "faceplate",
      typeId: data.device_type_id,
      vc,
      ...node(unitsTall(p.u_height)),
      marks: [],
      refs: {},
      names: {},
    }
  return null
}

/**
 * The marker a cable end lands on: by its component (`ref` - the id and
 * the termination kind the pair carries), else by its port name - exact,
 * then ignoring case and spaces - on a marker of the same kind.
 */
export function markerOf(
  face: PhotoFace,
  port?: string,
  ref?: PortRef
): number | undefined {
  if (ref?.id) {
    const i = ref.kind ? face.refs[`${ref.kind}:${ref.id}`] : face.refs[ref.id]
    if (i !== undefined) return i
  }
  if (!port) return undefined
  const i = face.names[port] ?? face.names[loose(port)]
  if (i === undefined) return undefined
  return !ref?.kind || face.marks[i].kind === ref.kind ? i : undefined
}

/** A point anchor on a photo node. */
export type PointAnchor = Extract<Anchor, { k: "point" }>

/** Marker `i`'s anchor: its centre as fractions of the node's box, out
 * through the nearer image edge. */
export function markAnchor(
  face: PhotoFace,
  i: number,
  port?: string
): PointAnchor {
  const m = face.marks[i]
  return {
    k: "point",
    fx: m.x,
    fy: (m.y * face.imgH) / face.h,
    exit: m.y < 0.5 ? "T" : "B",
    port: port ?? m.port,
  }
}

/** A link as the photo anchoring reads it (`AnchorLink`'s shape). */
export interface PhotoLink {
  id: string
  source: string
  target: string
  cables?: readonly {
    a?: string
    b?: string
    aRef?: PortRef
    bRef?: PortRef
  }[]
  junction?: { a?: unknown; b?: unknown }
}

const natural = (a: string, b: string) =>
  a.localeCompare(b, "en", { numeric: true, sensitivity: "base" })

/**
 * Every cable end on a photo node, keyed `<link>#<cable><end>`: its
 * marker, or a stub lead on the image edge facing its far end (the top
 * when the far node is above, else the bottom). A node's stub leads on
 * one edge are spread round its middle at the nub pitch, ordered by where
 * their far ends are, so they do not cross. Links without ports (LLDP
 * neighbours, BGP) keep the node's side midpoints.
 */
export function photoAnchors(
  photos: ReadonlyMap<string, PhotoFace>,
  boxes: ReadonlyMap<string, Rect>,
  links: readonly PhotoLink[]
): Map<string, PointAnchor> {
  const out = new Map<string, PointAnchor>()
  const stubs = new Map<
    string,
    {
      key: string
      face: PhotoFace
      side: "T" | "B"
      at: number
      port: string
    }[]
  >()
  const centre = (id: string) => {
    const r = boxes.get(id)
    return r ? { x: r.x + r.w / 2, y: r.y + r.h / 2 } : null
  }
  for (const l of links) {
    if (!l.cables?.length) continue
    l.cables.forEach((c, i) => {
      for (const end of ["a", "b"] as const) {
        if (l.junction?.[end]) continue
        const node = end === "a" ? l.source : l.target
        const face = photos.get(node)
        if (!face) continue
        const port = c[end]
        const key = `${l.id}#${i}${end}`
        const m = markerOf(face, port, end === "a" ? c.aRef : c.bRef)
        if (m !== undefined) {
          out.set(key, markAnchor(face, m, port))
          continue
        }
        const me = centre(node)
        const far = centre(end === "a" ? l.target : l.source)
        const side = me && far && far.y < me.y ? "T" : "B"
        const k = `${node}\u0000${side}`
        const list = stubs.get(k) ?? []
        list.push({ key, face, side, at: far?.x ?? 0, port: port ?? "" })
        stubs.set(k, list)
      }
    })
  }
  for (const list of stubs.values()) {
    list.sort(
      (x, y) =>
        x.at - y.at ||
        natural(x.port, y.port) ||
        (x.key < y.key ? -1 : x.key > y.key ? 1 : 0)
    )
    const { face, side } = list[0]
    const n = list.length
    const pitch =
      n > 1
        ? Math.max(
            0,
            Math.min(NUB.PITCH, (face.w - 2 * NUB.INSET - NUB.ALONG) / (n - 1))
          )
        : 0
    list.forEach((s, i) => {
      const off = face.w / 2 + (i - (n - 1) / 2) * pitch
      out.set(s.key, {
        k: "point",
        fx: off / face.w,
        fy: side === "T" ? 0 : face.imgH / face.h,
        exit: side,
        port: s.port,
        stub: true,
      })
    })
  }
  return out
}

/** What a photo node draws: its image, the markers and stub leads its
 * cables land on, and its caption. */
export interface PhotoShown {
  kind: "photo" | "faceplate"
  url?: string
  typeId?: string
  vc?: number | null
  imgH: number
  /** Below this zoom the image is drawn as a plain box (`photoLod`). */
  lod: number
  /** The markers a line lands on, as fractions of the image. */
  marks: PhotoMark[]
  /** Ports without a marker: px along the image edge they sit on. */
  stubs: { port: string; x: number; side: "T" | "B" }[]
  /** The name under the image, node-relative: the text cut to its room,
   * its measured width and where it starts; the pill follows it. */
  caption: { x: number; top: number; text: string; w: number }
}

/** Where a caption `need` px wide goes in `w`, clear of `blocked` spans:
 * at the left when it fits there, else the first gap it fits, else the
 * widest gap (it is cut to that) - or the left when no gap is worth it. */
export function captionRoom(
  w: number,
  blocked: readonly [number, number][],
  need: number
): { x: number; room: number } {
  const spans = [...blocked]
    .map(([a, b]) => [Math.max(0, a), Math.min(w, b)] as [number, number])
    .filter(([a, b]) => b > a)
    .sort((p, q) => p[0] - q[0])
  const gaps: [number, number][] = []
  let from = 0
  for (const [a, b] of spans) {
    if (a > from) gaps.push([from, a])
    from = Math.max(from, b)
  }
  if (w > from) gaps.push([from, w])
  const fits = gaps.find(([a, b]) => b - a >= need)
  if (fits) return { x: fits[0], room: need }
  const widest = gaps.reduce<[number, number] | null>(
    (best, g) => (!best || g[1] - g[0] > best[1] - best[0] ? g : best),
    null
  )
  if (widest && widest[1] - widest[0] >= PHOTO.CAPTION_MIN)
    return { x: widest[0], room: widest[1] - widest[0] }
  return { x: 0, room: Math.min(w, need) }
}

/**
 * A photo node as drawn for its anchored ends (`ends`: the point anchors
 * of every line landing on it). The caption - the name, then room for
 * the widest pill the card fields can show (`slot`) - steps round the
 * leads running down through it.
 */
export function photoShown(
  face: PhotoFace,
  ends: readonly Anchor[],
  name: string,
  slot: readonly string[],
  measure: Measure,
  lod: number = PHOTO.LOD
): PhotoShown {
  const points = ends.filter((a): a is PointAnchor => a.k === "point")
  const at = new Set(
    points.filter((a) => !a.stub).map((a) => `${a.fx}|${a.fy}`)
  )
  const marks = face.marks.filter((_, i) => {
    const a = markAnchor(face, i)
    return at.has(`${a.fx}|${a.fy}`)
  })
  const seen = new Set<string>()
  const stubs = points
    .filter((a) => a.stub)
    .map((a) => ({ port: a.port, x: a.fx * face.w, side: a.exit }))
    .filter((s) => {
      const k = `${s.x}|${s.side}`
      if (seen.has(k)) return false
      seen.add(k)
      return true
    })
    .sort((p, q) => p.x - q.x)
  const half = NUB.ALONG / 2 + PHOTO.CAPTION_PAD
  const blocked = points
    .filter((a) => a.exit === "B")
    .map((a): [number, number] => [a.fx * face.w - half, a.fx * face.w + half])
  const slotW = Math.max(0, ...slot.map((t) => pillWidth(t, measure)))
  const extra = slotW ? PILL.GAP + slotW : 0
  const nameW = Math.ceil(measure(name, CARD.TITLE_SIZE, CARD.TITLE_WEIGHT))
  const { x, room } = captionRoom(face.w, blocked, nameW + extra)
  const text = fit(
    name,
    Math.max(0, room - extra),
    CARD.TITLE_SIZE,
    CARD.TITLE_WEIGHT,
    measure
  )
  return {
    kind: face.kind,
    ...(face.url ? { url: face.url } : {}),
    ...(face.typeId ? { typeId: face.typeId } : {}),
    ...(face.vc != null ? { vc: face.vc } : {}),
    imgH: face.imgH,
    lod,
    marks,
    stubs,
    caption: {
      x,
      top: face.imgH + PHOTO.CAPTION_GAP,
      text,
      w: Math.ceil(measure(text, CARD.TITLE_SIZE, CARD.TITLE_WEIGHT)),
    },
  }
}

/** Where the pill goes after the caption, node-relative. */
export function captionPill(caption: PhotoShown["caption"], w: number): Rect {
  return {
    x: caption.x + caption.w + PILL.GAP,
    y: caption.top + (PHOTO.CAPTION_LH - PILL.H) / 2,
    w,
    h: PILL.H,
  }
}
