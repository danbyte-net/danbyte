import { useCallback, useState } from "react"

// How the cabinet page draws its plate (#277): the display mode, the zoom
// and whether the drawing writes its labels - remembered per browser, like
// the other view toggles, so the page reopens as it was left. One setting
// for every cabinet, as a rack's elevation would have.

/** Names: role-coloured boxes. Images: the type's front photos. Render:
 * each device's live faceplate. */
export type PlateMode = "names" | "images" | "render"

/** "fit": the plate fills its column, no taller than `FIT_MAX_PX` - how it
 * was drawn before it could zoom. A number: screen pixels per plate mm. */
export type PlateZoom = "fit" | number

export interface PlateView {
  mode: PlateMode
  zoom: PlateZoom
  labels: boolean
}

export const PLATE_MODES: readonly PlateMode[] = ["names", "images", "render"]

/** The zoom steps, px per mm: the rack's, and on up, since a DIN device's
 * ports are small. */
export const PLATE_ZOOM_STEPS: readonly number[] = [
  0.45, 0.6, 0.8, 1, 1.3, 1.6, 2, 2.5, 3,
]

/** Render's zoom, px per mm: about life size for a port's marker on a
 * screen. Render starts here, or at fit where fit is larger. */
export const RENDER_ZOOM = 1.3

/** The tallest a fitted plate is drawn, px: 28rem. */
export const FIT_MAX_PX = 448

export const DEFAULT_PLATE_VIEW: PlateView = {
  mode: "images",
  zoom: "fit",
  labels: true,
}

const KEY = "danbyte.cabinetPlate.view"

/** Stops closer than this share of a step are one stop. */
const SAME = 0.02

/** The plate's fitted scale, px per mm: as wide as the column and no
 * taller than `FIT_MAX_PX`. `view` is the drawing's frame in mm. */
export function fitScale(
  columnPx: number,
  view: { w: number; h: number }
): number {
  return Math.min(columnPx / view.w, FIT_MAX_PX / view.h)
}

/** The px per mm a zoom draws at. */
export function zoomScale(zoom: PlateZoom, fit: number): number {
  return zoom === "fit" ? fit : zoom
}

/** The zoom a mode starts at, as on the rack: fit, but Render no smaller
 * than its own. */
export function defaultZoom(mode: PlateMode, fit: number): PlateZoom {
  return mode === "render" && fit < RENDER_ZOOM ? RENDER_ZOOM : "fit"
}

/** The stops − and + step through, smallest first: the steps, with fit
 * among them - a step that close to fit gives way to it. */
export function zoomLadder(fit: number): PlateZoom[] {
  const steps = PLATE_ZOOM_STEPS.filter(
    (s) => Math.abs(s - fit) > fit * SAME
  ).map((s): PlateZoom => s)
  return [...steps, "fit" as const].sort(
    (a, b) => zoomScale(a, fit) - zoomScale(b, fit)
  )
}

/** The zoom one stop out (-1) or in (1) from `zoom`; null at either end. */
export function stepZoom(
  zoom: PlateZoom,
  fit: number,
  dir: -1 | 1
): PlateZoom | null {
  const at = zoomScale(zoom, fit)
  const ladder = zoomLadder(fit)
  const next =
    dir > 0
      ? ladder.find((z) => zoomScale(z, fit) > at * (1 + SAME))
      : [...ladder].reverse().find((z) => zoomScale(z, fit) < at * (1 - SAME))
  return next ?? null
}

/** The stored view, anything unrecognised read as its default. */
export function storedPlateView(): PlateView {
  try {
    const raw = JSON.parse(window.localStorage.getItem(KEY) ?? "{}") as Partial<
      Record<keyof PlateView, unknown>
    > | null
    const mode = PLATE_MODES.find((m) => m === raw?.mode)
    const zoom =
      raw?.zoom === "fit"
        ? "fit"
        : PLATE_ZOOM_STEPS.find((s) => s === raw?.zoom)
    return {
      mode: mode ?? DEFAULT_PLATE_VIEW.mode,
      zoom: zoom ?? DEFAULT_PLATE_VIEW.zoom,
      labels:
        typeof raw?.labels === "boolean"
          ? raw.labels
          : DEFAULT_PLATE_VIEW.labels,
    }
  } catch {
    return DEFAULT_PLATE_VIEW
  }
}

export function storePlateView(view: PlateView): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(view))
  } catch {
    // Storage blocked or full: the choice lasts this visit.
  }
}

/** The plate's view, read once from this browser and written back on every
 * change. */
export function usePlateView(): [PlateView, (view: PlateView) => void] {
  const [view, setState] = useState<PlateView>(storedPlateView)
  const set = useCallback((next: PlateView) => {
    setState(next)
    storePlateView(next)
  }, [])
  return [view, set]
}
