import type { TopoNode, TopologyGraph, TopologyPhotoAnchor } from "@/lib/api"
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
//      centre and runs straight up or down (its lead) - towards its far
//      end, else to the nearer image edge - then routes like any other
//      line;
//   2. the front photo without a marker for a port - the cable lands on a
//      stub lead along the image's top or bottom edge, facing its far end;
//   3. no photo but a schematic faceplate (`type_faceplate`) - drawn on
//      screen only, every port a stub lead (its ports have no coordinates);
//   4. neither - the normal card.
// The name is a caption under the image, placed clear of the leads that
// run down through it, with the device's card lines after it on the same
// line (muted, `· `-separated) as far as they fit.
//
// A photo can instead take its cables at its edge (the view's
// `photo_anchor`, or the device's own `anchor`): it is anchored like a
// card on its image - Simple lines meet at the facing side's midpoint,
// Detailed ones spread along it on nubs - and its ports are not used.

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
  /** Between the name and the card lines after it (the tail). */
  TAIL_GAP: 4,
  /** The least room the tail is drawn in; less, it is left off. */
  TAIL_MIN: 40,
  /** The shortest image drawn, px. */
  MIN_H: 12,
  /** A size saved with the layout is kept between these widths, px. */
  MIN_W: 24,
  MAX_W: 1920,
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

/** Where a photo's cables meet it: its ports, or its edge. */
export type PhotoAnchor = TopologyPhotoAnchor

/** The payload node as the page hands it to the Diagram: `face` marks a
 * device the view shows as its photo, `anchor` one whose cables meet the
 * photo's edge (`withFaces`). */
export type FacedData = TopoNode["data"] & {
  face?: "photo"
  anchor?: "edge"
}

type Overrides = Readonly<
  Record<string, { face?: Face; anchor?: PhotoAnchor } | undefined>
>

/** The face a device is drawn with: its own override, else the view's. */
export function faceOf(
  deviceId: string | undefined,
  face: Face,
  nodes?: Overrides
): Face {
  return (deviceId && nodes?.[deviceId]?.face) || face
}

/** Where a device's cables meet its photo: its own override, else the
 * view's. */
export function anchorOf(
  deviceId: string | undefined,
  anchor: PhotoAnchor,
  nodes?: Overrides
): PhotoAnchor {
  return (deviceId && nodes?.[deviceId]?.anchor) || anchor
}

/** Does any device on the map want its photo (the query then asks for
 * `include=photo`)? */
export function wantsPhotos(face: Face, nodes?: Overrides): boolean {
  if (face === "photo") return true
  return Object.values(nodes ?? {}).some((v) => v?.face === "photo")
}

/**
 * The graph with the devices the view shows as photos marked (`face`),
 * and those of them taking their cables at their edge (`anchor`). The
 * same graph back when nothing changes, so the map is not rebuilt.
 */
export function withFaces(
  graph: TopologyGraph,
  face: Face,
  nodes?: Overrides,
  anchor: PhotoAnchor = "ports"
): TopologyGraph {
  const out = graph.nodes.map((n) => {
    const data = n.data as FacedData
    const want =
      n.type === "device" && faceOf(data.device_id, face, nodes) === "photo"
    const edge = want && anchorOf(data.device_id, anchor, nodes) === "edge"
    if (want === (data.face === "photo") && edge === (data.anchor === "edge"))
      return n
    const { face: _face, anchor: _anchor, ...rest } = data
    return {
      ...n,
      data: {
        ...rest,
        ...(want ? { face: "photo" as const } : {}),
        ...(edge ? { anchor: "edge" as const } : {}),
      },
    }
  })
  return out.some((n, i) => n !== graph.nodes[i])
    ? { ...graph, nodes: out }
    : graph
}

/** Can a device be drawn as its photo (or faceplate)? From the payload's
 * photo (`include=photo`); undefined when the map did not ask for it. */
export function canShowPhoto(data: TopoNode["data"]): boolean | undefined {
  const p = data.photo
  if (p === undefined) return undefined
  return !!p.front || (p.type_faceplate && !!data.device_type_id)
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
  /** Its cables meet its edge, not its ports: it is anchored like a card
   * on its image (`Anchor.cap`). */
  edge?: true
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

/** A photo's own width: its true size when it is calibrated (`mm`, at the
 * scale every photo is drawn to - a 19-inch device is `PHOTO.W`), else the
 * size its layout saved for every surface (Use this size everywhere), else
 * its upload size; null when unknown. */
export function ownPhotoWidth(
  front:
    | { width?: number | null; scale: number | null; mm?: number | null }
    | null
    | undefined
): number | null {
  const bound = (w: number) =>
    Math.round(Math.min(PHOTO.MAX_W, Math.max(PHOTO.MIN_W, w)))
  const mm = front?.mm
  if (mm && mm > 0) return bound((PHOTO.W * mm) / PHOTO.RACK_MM)
  const width = front?.width
  if (!width || width <= 0) return null
  const scale = front.scale && front.scale > 0 ? front.scale : 1
  return bound(width * scale)
}

/**
 * The photo node a device is drawn as, or null for its card: not marked,
 * or nothing to draw (no photo, no faceplate). The image is `PHOTO.W`
 * wide (half that for a half-width type) at the photo's own aspect - or,
 * when the device's photo size is `own`, at the photo's own width: its
 * true size when calibrated (`ownPhotoWidth`).
 */
export function photoFace(data: FacedData): PhotoFace | null {
  if (data.face !== "photo" || !data.photo) return null
  const p = data.photo
  const w =
    (p.size === "own" ? ownPhotoWidth(p.front) : null) ??
    (p.rack_width === "half" ? PHOTO.W / 2 : PHOTO.W)
  const node = (imgH: number) => {
    const h = Math.max(PHOTO.MIN_H, Math.round(imgH))
    return { w, imgH: h, h: h + PHOTO.CAPTION_GAP + PHOTO.CAPTION_LH }
  }
  const vc = p.vc_position ?? null
  const edge = data.anchor === "edge" ? { edge: true as const } : {}
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
      ...edge,
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
      ...edge,
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
 * through `exit` - by default the nearer image edge. */
export function markAnchor(
  face: PhotoFace,
  i: number,
  port?: string,
  exit?: "T" | "B"
): PointAnchor {
  const m = face.marks[i]
  return {
    k: "point",
    fx: m.x,
    fy: (m.y * face.imgH) / face.h,
    exit: exit ?? (m.y < 0.5 ? "T" : "B"),
    port: port ?? m.port,
  }
}

/** The edge a port leaves its photo `me` by for a far end in `far`:
 * towards it when it lies wholly above or below the photo - a lead over
 * the photo is shorter than a line round it - else the edge nearer the
 * port (`y`, as a fraction of the image). */
export function exitTowards(
  me: Rect | undefined,
  far: Rect | undefined,
  y: number
): "T" | "B" {
  if (me && far) {
    if (far.y + far.h <= me.y) return "T"
    if (far.y >= me.y + me.h) return "B"
  }
  return y < 0.5 ? "T" : "B"
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

/** Leads closer than this, px, would read as one line. */
const LEAD_GAP = 8

/**
 * Every cable end on a photo node, keyed `<link>#<cable><end>`: its
 * marker, leaving by the edge facing its far end (`exitTowards`; with
 * `towards` false, always the nearer edge), or a
 * stub lead on the image edge facing its far end (the top when the far
 * node is above, else the bottom). A node's stub leads on
 * one edge are spread round its middle at the nub pitch, ordered by where
 * their far ends are, so they do not cross. Links without ports (LLDP
 * neighbours, BGP) keep the node's side midpoints.
 */
export function photoAnchors(
  photos: ReadonlyMap<string, PhotoFace>,
  boxes: ReadonlyMap<string, Rect>,
  links: readonly PhotoLink[],
  towards = true
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
  // The marked ports each photo has cables on: a lead may not run over
  // another's port - the two would share a line.
  const cabled = new Map<string, Set<number>>()
  const ends: {
    key: string
    node: string
    face: PhotoFace
    m: number
    port?: string
    far: string
  }[] = []
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
          const far = end === "a" ? l.target : l.source
          ends.push({ key, node, face, m, port, far })
          const set = cabled.get(node) ?? new Set<number>()
          set.add(m)
          cabled.set(node, set)
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
  for (const { key, node, face, m, port, far } of ends) {
    const mark = face.marks[m]
    const near = mark.y < 0.5 ? "T" : "B"
    let exit = towards
      ? exitTowards(boxes.get(node), boxes.get(far), mark.y)
      : near
    if (exit !== near) {
      // Away from its nearer edge only while no other cabled port is in
      // its column on the way.
      for (const o of cabled.get(node) ?? []) {
        const other = face.marks[o]
        if (o === m || Math.abs(other.x - mark.x) * face.w >= LEAD_GAP) continue
        if (exit === "B" ? other.y > mark.y : other.y < mark.y) {
          exit = near
          break
        }
      }
    }
    out.set(key, markAnchor(face, m, port, exit))
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
  /** The caption under the image, node-relative: the name cut to its room,
   * its measured width and where it starts; the card lines after it
   * (`tail`, from `x`), then the pill. */
  caption: PhotoCaption
}

/** A caption's card lines as drawn: `· `-led, whole values joined by
 * ` · `, ending `· …` when some are left off; from `x`, `w` wide. */
export interface CaptionTail {
  text: string
  x: number
  w: number
}

export interface PhotoCaption {
  x: number
  top: number
  text: string
  w: number
  /** The card lines after the name while no pill shows. */
  tail?: CaptionTail
  /** The whole caption - the name and every line - when the drawn one is
   * cut: its tooltip. */
  full?: string
  /** The lines and tooltip with a pill after them, when those differ: no
   * gap held the name, the pill and a whole line, so the lines took the
   * pill's room, and a pill that shows wins it back (`captionWith`). */
  pilled?: { tail?: CaptionTail; full?: string }
}

/** The caption as drawn with a pill after it, or without one. */
export function captionWith(
  caption: PhotoCaption,
  pill: boolean
): PhotoCaption {
  const p = caption.pilled
  if (!pill || !p) return caption
  return {
    x: caption.x,
    top: caption.top,
    text: caption.text,
    w: caption.w,
    ...(p.tail ? { tail: p.tail } : {}),
    ...(p.full ? { full: p.full } : {}),
  }
}

/** The gaps a caption may take in `w`, left to right, between the
 * `blocked` spans. */
function captionGaps(
  w: number,
  blocked: readonly [number, number][]
): [number, number][] {
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
  return gaps
}

/** Where a caption `need` px wide goes in `w`, clear of `blocked` spans:
 * at the left when it fits there, else the first gap it fits, else the
 * widest gap (it is cut to that) - or the left when no gap is worth it.
 * `to` is where the gap it took ends. */
export function captionRoom(
  w: number,
  blocked: readonly [number, number][],
  need: number
): { x: number; room: number; to: number } {
  const gaps = captionGaps(w, blocked)
  const fits = gaps.find(([a, b]) => b - a >= need)
  if (fits) return { x: fits[0], room: need, to: fits[1] }
  const widest = gaps.reduce<[number, number] | null>(
    (best, g) => (!best || g[1] - g[0] > best[1] - best[0] ? g : best),
    null
  )
  if (widest && widest[1] - widest[0] >= PHOTO.CAPTION_MIN)
    return { x: widest[0], room: widest[1] - widest[0], to: widest[1] }
  const room = Math.min(w, need)
  return { x: 0, room, to: room }
}

/** Between the values in a caption's tail, and before the first. */
const SEP = " · "
const LEAD = "· "

/** A card line as a caption value: its own ` · ` (a rack's unit) would
 * read as two values. */
const tailValue = (line: string) => line.replace(/\s+·\s+/g, " ").trim()

const tailWidth = (text: string, measure: Measure) =>
  Math.ceil(measure(text, CARD.LINE_SIZE, CARD.LINE_WEIGHT))

/** The tail of the first `k` of `values`, `· …` for the rest. */
const tailOf = (values: readonly string[], k: number) =>
  LEAD + values.slice(0, k).join(SEP) + (k < values.length ? `${SEP}…` : "")

/**
 * The card lines after a photo's name, in `room` px: as many whole values
 * as fit, then `· …` for the rest - an address is never cut in two. Only
 * a first value that could never fit whole - wider than `widest`, the
 * room the caption has with no lead in its way - is cut, when there are
 * `PHOTO.TAIL_MIN` px to cut it to. Null for no lines, or nothing worth
 * drawing.
 */
export function captionTail(
  values: readonly string[],
  room: number,
  widest: number,
  measure: Measure
): { text: string; w: number; cut: boolean } | null {
  if (!values.length) return null
  for (let k = values.length; k >= 1; k--) {
    const text = tailOf(values, k)
    const w = tailWidth(text, measure)
    if (w <= room) return { text, w, cut: k < values.length }
  }
  if (room < PHOTO.TAIL_MIN) return null
  if (tailWidth(LEAD + values[0], measure) <= widest) return null
  const text = fit(
    LEAD + values[0],
    room,
    CARD.LINE_SIZE,
    CARD.LINE_WEIGHT,
    measure
  )
  // Nothing of the value left but the ellipsis: not worth drawing.
  if (Array.from(text).length < LEAD.length + 2) return null
  return { text, w: tailWidth(text, measure), cut: true }
}

/** The px of a photo node's box under its image: the caption's room. A
 * photo taking its cables at its edge is anchored on the image above it. */
export const captionCap = (face: Pick<PhotoFace, "h" | "imgH">) =>
  face.h - face.imgH

/**
 * A photo node as drawn for its anchored ends (`ends`: the anchors of
 * every line landing on it). The caption - the name, its card lines
 * (`lines`) after it, then room for the widest pill the card fields can
 * show (`slot`) - steps round the leads running down through it: from its
 * ports, or from its bottom edge. It takes the first gap the whole of it
 * fits; else the first that fits the name, the pill and as many whole
 * lines as any gap holds (`· …` for the rest). With no gap holding the
 * name, the pill and a whole line, the lines may take the pill's room: the
 * first gap that fits the name and the pill, and the name and the most
 * whole lines; else where the name and pill fit, the lines getting what
 * is left of that gap. A pill that shows then wins its room back, and the
 * lines it drops go to the tooltip (`pilled`). A status pill (`statusPill`)
 * always shows, so its room is never lent.
 */
export function photoShown(
  face: PhotoFace,
  ends: readonly Anchor[],
  name: string,
  slot: readonly string[],
  measure: Measure,
  lod: number = PHOTO.LOD,
  lines: readonly string[] = [],
  statusPill = false
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
  const blocked = [
    ...points.filter((a) => a.exit === "B").map((a) => a.fx * face.w),
    ...ends.flatMap((a) => (a.k === "side" && a.side === "B" ? [a.off] : [])),
  ].map((x): [number, number] => [x - half, x + half])
  const slotW = Math.max(0, ...slot.map((t) => pillWidth(t, measure)))
  const extra = slotW ? PILL.GAP + slotW : 0
  const nameW = Math.ceil(measure(name, CARD.TITLE_SIZE, CARD.TITLE_WEIGHT))
  const values = lines.map(tailValue).filter(Boolean)
  const gaps = captionGaps(face.w, blocked)
  const tailNeed = (k: number) =>
    PHOTO.TAIL_GAP + tailWidth(tailOf(values, k), measure)
  // The first gap `need` px fit, for the most whole lines `need` takes.
  const place = (need: (k: number) => number) => {
    for (let k = values.length; k >= 1; k--) {
      const g = gaps.find(([a, b]) => b - a >= need(k))
      if (g) return { x: g[0], room: nameW + extra, to: g[1] }
    }
    return undefined
  }
  // The name, the pill's room and whole lines; else the lines in the
  // pill's room (`borrow`).
  const kept = place((k) => nameW + tailNeed(k) + extra)
  const borrow = !kept && extra > 0 && !statusPill
  const spot =
    kept ??
    (borrow ? place((k) => nameW + Math.max(tailNeed(k), extra)) : undefined)
  const { x, room, to } = spot ?? captionRoom(face.w, blocked, nameW + extra)
  const text = fit(
    name,
    Math.max(0, room - extra),
    CARD.TITLE_SIZE,
    CARD.TITLE_WEIGHT,
    measure
  )
  const w = Math.ceil(measure(text, CARD.TITLE_SIZE, CARD.TITLE_WEIGHT))
  const tailX = x + w + PHOTO.TAIL_GAP
  // The lines in `pill` px less: a value is cut only when it could never
  // fit whole beside the whole name.
  const tailIn = (pill: number) => {
    const t = captionTail(
      values,
      to - tailX - pill,
      face.w - nameW - PHOTO.TAIL_GAP - pill,
      measure
    )
    const cut = text !== name || !!t?.cut || (values.length > 0 && !t)
    return {
      ...(t ? { tail: { text: t.text, x: tailX, w: t.w } } : {}),
      ...(cut ? { full: [name, ...values].join(SEP) } : {}),
    }
  }
  const free = tailIn(borrow ? 0 : extra)
  const pilled = borrow ? tailIn(extra) : free
  const same =
    pilled.tail?.text === free.tail?.text && pilled.full === free.full
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
      w,
      ...free,
      ...(same ? {} : { pilled }),
    },
  }
}

/** Where the pill goes after the caption - its lines, else its name -
 * node-relative; `caption` as drawn with the pill (`captionWith`). */
export function captionPill(caption: PhotoCaption, w: number): Rect {
  const end = caption.tail
    ? caption.tail.x + caption.tail.w
    : caption.x + caption.w
  return {
    x: end + PILL.GAP,
    y: caption.top + (PHOTO.CAPTION_LH - PILL.H) / 2,
    w,
    h: PILL.H,
  }
}
