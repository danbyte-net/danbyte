import type {
  FloorPlanDrawing,
  FloorPlanDrawingLayer,
  FloorPlanDrawingPlacement,
} from "@/lib/api"

// Placement maths for a plan's CAD drawing - the client twin of
// api/cad_render.py (placed_box_mm, transform_mm). The canvas computes the
// transform itself so a rotation or offset shows the moment it is picked;
// the server's `transform_mm` is the same formula.
//
// Spaces: the rendered SVG is in drawing units (viewBox "0 0 W H", y down);
// the plan is in millimetres from its top-left corner; the 2D canvas draws
// the plan at `pxPerMm` (CELL / cell_mm).

export type Rotation = FloorPlanDrawingPlacement["rotation"]

export const ROTATIONS: readonly Rotation[] = [0, 90, 180, 270]

/** Above this many rendered elements the canvas shows a server render as
 * one image instead of the inline SVG: tens of thousands of live nodes make
 * every pan and zoom crawl, and the PNG export clones each one. */
export const INLINE_ELEMENT_BUDGET = 60_000

/** The drawing's placement with the defaults a fresh record lacks. */
export function placementOf(
  d: Pick<FloorPlanDrawing, "placement">,
  local?: Partial<FloorPlanDrawingPlacement>
): FloorPlanDrawingPlacement {
  const p = { ...d.placement, ...(local ?? {}) }
  const rot = Number(p.rotation ?? 0)
  return {
    x_mm: Number(p.x_mm ?? 0) || 0,
    y_mm: Number(p.y_mm ?? 0) || 0,
    rotation: (ROTATIONS.includes(rot as Rotation) ? rot : 0) as Rotation,
    opacity: p.opacity == null ? 60 : Number(p.opacity),
    hidden_layers: Array.isArray(p.hidden_layers) ? p.hidden_layers : [],
    hide_text: Boolean(p.hide_text),
  }
}

export interface Size {
  width: number
  height: number
}

export interface Box {
  x: number
  y: number
  width: number
  height: number
}

/** The drawing's box on the plan in mm, after rotation. */
export function placedBoxMm(
  size: Size,
  mmPerUnit: number,
  p: Pick<FloorPlanDrawingPlacement, "x_mm" | "y_mm" | "rotation">
): Box {
  let w = size.width
  let h = size.height
  if (p.rotation === 90 || p.rotation === 270) [w, h] = [h, w]
  return { x: p.x_mm, y: p.y_mm, width: w * mmPerUnit, height: h * mmPerUnit }
}

/** An affine map [a b c d e f] as SVG's matrix(): x' = a·x + c·y + e,
 * y' = b·x + d·y + f. */
export type Matrix = [number, number, number, number, number, number]

/** Drawing units → plan mm: translate(centre) rotate(r) scale(s)
 * translate(-W/2, -H/2), exactly the server's `transform_mm`. */
export function placementMatrix(
  size: Size,
  mmPerUnit: number,
  p: Pick<FloorPlanDrawingPlacement, "x_mm" | "y_mm" | "rotation">
): Matrix {
  const box = placedBoxMm(size, mmPerUnit, p)
  const cx = box.x + box.width / 2
  const cy = box.y + box.height / 2
  const s = mmPerUnit
  const rad = (p.rotation * Math.PI) / 180
  // Quarter turns only: snap cos/sin so 90° is exact, not 6e-17.
  const cos = Math.round(Math.cos(rad))
  const sin = Math.round(Math.sin(rad))
  const ox = -size.width / 2
  const oy = -size.height / 2
  return [
    cos * s,
    sin * s,
    -sin * s,
    cos * s,
    cx + s * (cos * ox - sin * oy),
    cy + s * (sin * ox + cos * oy),
  ]
}

export function applyMatrix(m: Matrix, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]
}

export function invertMatrix(m: Matrix): Matrix {
  const [a, b, c, d, e, f] = m
  const det = a * d - b * c
  if (!det) throw new Error("Singular placement")
  return [
    d / det,
    -b / det,
    -c / det,
    a / det,
    (c * f - d * e) / det,
    (b * e - a * f) / det,
  ]
}

/** Prefix a matrix with a uniform scale (mm → canvas px). */
export function scaleMatrix(m: Matrix, k: number): Matrix {
  return [m[0] * k, m[1] * k, m[2] * k, m[3] * k, m[4] * k, m[5] * k]
}

const n = (v: number) => {
  const s = v.toFixed(6).replace(/\.?0+$/, "")
  return s === "" || s === "-0" ? "0" : s
}

/** The server's `transform_mm` string, for the same inputs. */
export function transformMm(
  size: Size,
  mmPerUnit: number,
  p: Pick<FloorPlanDrawingPlacement, "x_mm" | "y_mm" | "rotation">
): string {
  const box = placedBoxMm(size, mmPerUnit, p)
  return (
    `translate(${n(box.x + box.width / 2)} ${n(box.y + box.height / 2)}) ` +
    `rotate(${p.rotation}) scale(${n(mmPerUnit)}) ` +
    `translate(${n(-size.width / 2)} ${n(-size.height / 2)})`
  )
}

/** The transform for the canvas group: `scale(pxPerMm)` in front of the
 * mm placement (pxPerMm = CELL / cell_mm). */
export function canvasTransform(
  size: Size,
  mmPerUnit: number,
  p: Pick<FloorPlanDrawingPlacement, "x_mm" | "y_mm" | "rotation">,
  pxPerMm: number
): string {
  return `scale(${n(pxPerMm)}) ${transformMm(size, mmPerUnit, p)}`
}

/** A canvas point (world px) → the drawing's viewBox units, through the
 * inverse of the placement: where a calibration click lands in the file. */
export function canvasToDrawing(
  pt: { x: number; y: number },
  size: Size,
  mmPerUnit: number,
  p: Pick<FloorPlanDrawingPlacement, "x_mm" | "y_mm" | "rotation">,
  pxPerMm: number
): [number, number] {
  const inv = invertMatrix(
    scaleMatrix(placementMatrix(size, mmPerUnit, p), pxPerMm)
  )
  return applyMatrix(inv, pt.x, pt.y)
}

/** The other way: a drawing point onto the canvas (world px). */
export function drawingToCanvas(
  pt: [number, number],
  size: Size,
  mmPerUnit: number,
  p: Pick<FloorPlanDrawingPlacement, "x_mm" | "y_mm" | "rotation">,
  pxPerMm: number
): [number, number] {
  return applyMatrix(
    scaleMatrix(placementMatrix(size, mmPerUnit, p), pxPerMm),
    pt[0],
    pt[1]
  )
}

// ── Layer presets ──────────────────────────────────────────────────────────

/** A layer that holds only hatches, dimensions or text - annotation, not
 * the building. */
export function isAnnotationLayer(l: FloorPlanDrawingLayer): boolean {
  return l.kinds.geometry === 0
}

export type LayerPreset = "all" | "architecture"

/** The hidden set a preset gives. "Architecture only" hides the layers with
 * no plain geometry (hatch-, dimension- and text-only layers). */
export function presetHidden(
  layers: FloorPlanDrawingLayer[],
  preset: LayerPreset
): string[] {
  if (preset === "all") return []
  return layers.filter(isAnnotationLayer).map((l) => l.name)
}

/** Toggle one layer in a hidden set, keeping it sorted like the server. */
export function toggleHidden(hidden: string[], name: string): string[] {
  const s = new Set(hidden)
  if (s.has(name)) s.delete(name)
  else s.add(name)
  return [...s].sort()
}

/** Whether the canvas should use a server render image rather than the
 * inline SVG. */
export function wantsServerRender(
  d: Pick<FloorPlanDrawing, "rendered_elements">,
  budget = INLINE_ELEMENT_BUDGET
): boolean {
  return d.rendered_elements > budget
}

/** "12.4 × 8 m" (or mm under a metre) for a size in mm. */
export function fmtSizeMm(s: Size): string {
  const big = Math.max(s.width, s.height) >= 1000
  const f = (v: number) =>
    big
      ? `${(v / 1000).toFixed(v >= 100_000 ? 0 : 1).replace(/\.0$/, "")}`
      : `${Math.round(v)}`
  return `${f(s.width)} × ${f(s.height)} ${big ? "m" : "mm"}`
}
