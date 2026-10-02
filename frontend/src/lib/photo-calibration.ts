import type {
  DeviceTypeMini,
  ImagePorts,
  PhotoCalibration,
  PhotoView,
  ResolvedPhotoCalibration,
} from "@/lib/api"

// Photo calibration (#277): two guides across a device photo, at fractions of
// its width, with the real distance between them, give the photo's true
// width; the rail line, a fraction of its height, says where the DIN rail
// runs across it. The TS twin of the calibration half of api/face_ports.py,
// plus the geometry the photo editor and the cabinet drawing share.

export type PhotoSide = "front" | "rear"

const SIDES: PhotoSide[] = ["front", "rear"]

/** The guides stand at least this far apart, a fraction of the photo's
 * width - the server's minimum. */
export const MIN_GUIDE_GAP = 0.02
/** The distance between the guides, mm - the server's bounds. */
export const SPAN_MIN_MM = 1
export const SPAN_MAX_MM = 5000
/** An arrow key moves a guide this far, a fraction of the photo; Shift
 * five times as far. The markers' steps. */
export const GUIDE_STEP = 0.002
export const GUIDE_STEP_COARSE = 0.01

// The editor keeps the guides a hair further apart than the server's
// minimum, so a gap that rounds to exactly 0.02 never reads as 0.0199….
const KEEP_APART = MIN_GUIDE_GAP + 0.001

const isNum = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v)
const clamp = (v: number, lo: number, hi: number) =>
  Math.min(Math.max(v, lo), hi)
const round = (v: number, places: number) => {
  const f = 10 ** places
  return Math.round(v * f) / f
}

// ── sizes ───────────────────────────────────────────────────────────────────

/** The photo's true width, mm: the distance between the guides over the
 * share of the photo between them. */
export function photoWidthMm(
  cal: Pick<PhotoCalibration, "left" | "right" | "span_mm">
): number {
  return cal.span_mm / (cal.right - cal.left)
}

/** The photo's true height, mm, from its width and its aspect (natural
 * height over width). */
export function photoHeightMm(widthMm: number, aspect: number): number {
  return widthMm * aspect
}

/** "Photo 60.0 × 146.6 mm". */
export function fmtPhotoSize(widthMm: number, heightMm: number): string {
  return `Photo ${widthMm.toFixed(1)} × ${heightMm.toFixed(1)} mm`
}

// ── reading a calibration ───────────────────────────────────────────────────

/** A calibration as the server reads one (`calibration` in
 * api/face_ports.py): the guides default to the photo's edges, and it needs
 * a distance and its guides left before right. With the photo's true width
 * (the server's `photo_mm` when it sent one); null when unusable. */
export function resolveCalibration(
  raw: unknown
): ResolvedPhotoCalibration | null {
  if (!raw || typeof raw !== "object") return null
  const c = raw as Record<string, unknown>
  const left = c.left ?? 0
  const right = c.right ?? 1
  const span = c.span_mm
  if (!isNum(span) || !isNum(left) || !isNum(right) || right - left <= 0)
    return null
  return {
    left,
    right,
    span_mm: span,
    rail: isNum(c.rail) ? c.rail : null,
    photo_mm: isNum(c.photo_mm)
      ? c.photo_mm
      : round(photoWidthMm({ left, right, span_mm: span }), 1),
  }
}

/** The calibration a device's front photo uses: its own `image_ports`
 * override's, else its type's (`front_cal`) - `effective_calibration` in
 * api/face_ports.py. */
export function effectiveFrontCal(device: {
  image_ports?: ImagePorts | null
  device_type: Pick<DeviceTypeMini, "front_cal"> | null
}): ResolvedPhotoCalibration | null {
  return (
    resolveCalibration(device.image_ports?.view?.front?.cal) ??
    resolveCalibration(device.device_type?.front_cal)
  )
}

// ── the guides ──────────────────────────────────────────────────────────────

/** A guide: the two across the photo's width, or the rail line. */
export type Guide = "left" | "right" | "rail"

/** Where the guides stand, as fractions of the photo: `left` and `right`
 * of its width, `rail` of its height. */
export interface Guides {
  left: number
  right: number
  rail: number
}

/** `guides` with one moved to `at`: kept on the photo, and the two across
 * it apart, left before right. Four decimals. */
export function moveGuide<T extends Guides>(
  guides: T,
  guide: Guide,
  at: number
): T {
  const v =
    guide === "left"
      ? clamp(at, 0, guides.right - KEEP_APART)
      : guide === "right"
        ? clamp(at, guides.left + KEEP_APART, 1)
        : clamp(at, 0, 1)
  return { ...guides, [guide]: round(v, 4) }
}

/** One arrow-key step of a guide, `coarse` with Shift. */
export function nudgeGuide<T extends Guides>(
  guides: T,
  guide: Guide,
  direction: -1 | 1,
  coarse = false
): T {
  const step = coarse ? GUIDE_STEP_COARSE : GUIDE_STEP
  return moveGuide(guides, guide, guides[guide] + direction * step)
}

// ── the editor's draft ──────────────────────────────────────────────────────

/** A calibration as the editor holds it: the distance as typed, so a
 * cleared field stays blank instead of turning into 0. */
export interface CalibrationDraft extends Guides {
  span: string
}

/** What the drafts read off the device type. */
export type CalibrationType = Pick<
  DeviceTypeMini,
  "width_mm" | "height_mm" | "din_rail_mm"
>

/** The rail line's default: the type's rail position over its height, the
 * middle when it has none - where the cabinet drawing hangs the body. */
export function defaultRail(type: CalibrationType): number {
  if (type.din_rail_mm == null || !type.height_mm) return 0.5
  return round(clamp(type.din_rail_mm / type.height_mm, 0, 1), 4)
}

/** A new calibration: the guides on the photo's edges with the type's width
 * between them, and the rail line at the type's rail position. */
export function newDraft(type: CalibrationType): CalibrationDraft {
  return {
    left: 0,
    right: 1,
    rail: defaultRail(type),
    span: type.width_mm ? String(type.width_mm) : "",
  }
}

/** A saved calibration as a draft; a missing rail line starts at the
 * type's rail position. */
export function draftOf(
  cal: PhotoCalibration,
  type: CalibrationType
): CalibrationDraft {
  return {
    left: cal.left,
    right: cal.right,
    rail: cal.rail ?? defaultRail(type),
    span: String(cal.span_mm),
  }
}

/** The distance field's value, mm; null while it is not a number from 1 to
 * 5000. */
export function parseSpan(text: string): number | null {
  const t = text.trim()
  if (!t) return null
  const v = Number(t)
  return Number.isFinite(v) && v >= SPAN_MIN_MM && v <= SPAN_MAX_MM ? v : null
}

/** The calibration a draft saves; null while its distance does not parse. */
export function draftCalibration(d: CalibrationDraft): PhotoCalibration | null {
  const span = parseSpan(d.span)
  if (span == null) return null
  return { left: d.left, right: d.right, span_mm: span, rail: d.rail }
}

// ── the photo document ──────────────────────────────────────────────────────

/** `doc` with one key of `side`'s view set, or removed when `value` is
 * undefined. A side's entry left empty is dropped, and so is an empty
 * `view`; markers and the other side stay as they are. */
function withViewKey<TKey extends keyof PhotoView>(
  doc: ImagePorts,
  side: PhotoSide,
  key: TKey,
  value: PhotoView[TKey] | undefined
): ImagePorts {
  const entry: PhotoView = { ...doc.view?.[side] }
  if (value === undefined) delete entry[key]
  else entry[key] = value
  const view = { ...doc.view }
  if (Object.keys(entry).length > 0) view[side] = entry
  else delete view[side]
  const rest = { ...doc }
  delete rest.view
  return Object.keys(view).length > 0 ? { ...rest, view } : rest
}

/** `doc` with `side`'s display size set (a fraction, or null for fit), or
 * removed (undefined) - its calibration kept. */
export function withScale(
  doc: ImagePorts,
  side: PhotoSide,
  scale: number | null | undefined
): ImagePorts {
  return withViewKey(doc, side, "scale", scale)
}

/** `doc` with `side`'s calibration set, or removed (null) - its display
 * size kept. */
export function withCalibration(
  doc: ImagePorts,
  side: PhotoSide,
  cal: PhotoCalibration | null
): ImagePorts {
  return withViewKey(doc, side, "cal", cal ?? undefined)
}

/** `doc` without a calibration on either side. */
export function withoutCalibrations(doc: ImagePorts): ImagePorts {
  return SIDES.reduce((d, s) => withCalibration(d, s, null), doc)
}

/** Does `side` keep a display size ("Use this size everywhere")? A `scale`
 * key - null is Fit - not merely a view entry, which may hold only a
 * calibration. */
export function hasSavedSize(
  doc: ImagePorts | null | undefined,
  side: PhotoSide
): boolean {
  return doc?.view?.[side]?.scale !== undefined
}

/** The size a side's photo draws at on every surface: its saved size - a
 * fraction of its natural width, null to fit - else its upload size, 1. A
 * view holding only a calibration keeps the upload size. */
export function displayScale(
  view: PhotoView | null | undefined
): number | null {
  return view?.scale === undefined ? 1 : view.scale
}

/** What Save sends: the document while it holds anything - markers on
 * either side, a saved size or a calibration - else null, which clears it. */
export function photoDocToSave(doc: ImagePorts): ImagePorts | null {
  const marked = doc.front.length > 0 || doc.rear.length > 0
  const viewed = SIDES.some(
    (s) => hasSavedSize(doc, s) || resolveCalibration(doc.view?.[s]?.cal)
  )
  return marked || viewed ? doc : null
}

// ── on a cabinet's plate ────────────────────────────────────────────────────

/** A box on the plate, mm. */
export interface PlateBox {
  x: number
  y: number
  width: number
  height: number
}

/** Where a calibrated photo goes on a cabinet's plate, mm: at its true
 * size, its left guide on the body's left edge, its rail line on the rail's
 * centreline - its top on the body's top when it has no rail line. The
 * drawing clips it to the body. `aspect` is the photo's height over its
 * width. Hundredths of a millimetre. */
export function cabinetPhotoBox(
  body: Pick<PlateBox, "x" | "y">,
  cal: Pick<ResolvedPhotoCalibration, "left" | "rail" | "photo_mm">,
  aspect: number,
  railY: number
): PlateBox {
  const width = cal.photo_mm
  const height = photoHeightMm(width, aspect)
  return {
    x: round(body.x - cal.left * width, 2),
    y: round(cal.rail != null ? railY - cal.rail * height : body.y, 2),
    width: round(width, 2),
    height: round(height, 2),
  }
}
