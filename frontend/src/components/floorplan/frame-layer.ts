import L from "leaflet"

import { mercX, mercY } from "@/components/site-map/plan-from-map"

import {
  FRAME_HANDLES,
  frameBbox,
  handleAt,
  innerBbox,
  moveFrame,
  moveInner,
  resizeFrame,
} from "./plan-geo"
import type { CellFrame, FrameHandle } from "./plan-geo"

// SVG can't resolve CSS variables: literal zinc and blue, like the Site
// map's own outlines and frame.
const GRID = "#71717a"
const FRAME = "#2563eb"

const CURSOR: Record<FrameHandle, string> = {
  n: "ns-resize",
  s: "ns-resize",
  e: "ew-resize",
  w: "ew-resize",
  ne: "nesw-resize",
  sw: "nesw-resize",
  nw: "nwse-resize",
  se: "nwse-resize",
}

export interface FrameLayerOptions {
  /** Drag the frame by its inside (the grid moves with it). */
  movable: boolean
  /** Drag the dashed grid inside the frame. */
  innerMovable: boolean
  onChange: (f: CellFrame, what: "resize" | "move" | "inner") => void
}

const bounds = (b: ReturnType<typeof frameBbox>): L.LatLngBoundsExpression => [
  [b.south, b.west],
  [b.north, b.east],
]

/**
 * The frame on a Leaflet map - Expand's and From site map's: the grid as it
 * is (dashed) inside the frame, a handle on each corner and edge that
 * resizes it in whole cells, and - when allowed - the frame and the dashed
 * grid dragged by their insides. Call `update` with each new frame.
 */
export function frameLayer(
  map: L.Map,
  first: CellFrame,
  opts: FrameLayerOptions
) {
  let cur = first
  const group = L.layerGroup().addTo(map)
  const outer = L.rectangle(bounds(frameBbox(cur)), {
    color: FRAME,
    weight: 2,
    fillOpacity: 0.06,
    interactive: opts.movable,
  }).addTo(group)
  const inner = L.rectangle(bounds(innerBbox(cur)), {
    color: GRID,
    weight: 1.5,
    dashArray: "4 4",
    fillOpacity: opts.innerMovable ? 0.08 : 0,
    fill: opts.innerMovable,
    interactive: opts.innerMovable,
  }).addTo(group)
  const handles = new Map<FrameHandle, L.Marker>()
  for (const h of FRAME_HANDLES) {
    const at = handleAt(cur, h)
    const corner = h.length === 2
    const m = L.marker([at.lat, at.lng], {
      keyboard: false,
      icon: L.divIcon({
        className: "",
        html: `<span data-handle="${h}" style="display:block;width:12px;height:12px;border-radius:${corner ? 2 : 3}px;background:#fff;border:2px solid ${FRAME};cursor:${CURSOR[h]};touch-action:none"></span>`,
        iconSize: [12, 12],
        iconAnchor: [6, 6],
      }),
    }).addTo(group)
    handles.set(h, m)
  }

  // One drag at a time: the pointer is followed on the window so a fast
  // drag that leaves the handle keeps going, and the map stays put.
  const drag = (
    e: PointerEvent,
    step: (dx: number, dy: number, at: L.LatLng) => void
  ) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    map.dragging.disable()
    const start = map.mouseEventToLatLng(e)
    const sx = mercX(start.lng)
    const sy = mercY(start.lat)
    const move = (ev: PointerEvent) => {
      const at = map.mouseEventToLatLng(ev)
      step(mercX(at.lng) - sx, mercY(at.lat) - sy, at)
    }
    const up = () => {
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", up)
      window.removeEventListener("pointercancel", up)
      map.dragging.enable()
    }
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", up)
    window.addEventListener("pointercancel", up)
  }

  const off: (() => void)[] = []
  const on = (
    el: Element | undefined | null,
    fn: (e: PointerEvent) => void
  ) => {
    if (!el) return
    const h = (e: Event) => fn(e as PointerEvent)
    el.addEventListener("pointerdown", h)
    off.push(() => el.removeEventListener("pointerdown", h))
  }

  for (const [h, m] of handles)
    on(m.getElement(), (e) => {
      const from = cur
      drag(e, (_dx, _dy, at) =>
        opts.onChange(resizeFrame(from, h, at), "resize")
      )
    })
  if (opts.movable) {
    const el = outer.getElement() as HTMLElement | undefined
    if (el) el.style.cursor = "move"
    on(el, (e) => {
      const from = cur
      drag(e, (dx, dy) => opts.onChange(moveFrame(from, dx, dy), "move"))
    })
  }
  if (opts.innerMovable) {
    const el = inner.getElement() as HTMLElement | undefined
    if (el) el.style.cursor = "grab"
    on(el, (e) => {
      const from = cur
      drag(e, (dx, dy) => opts.onChange(moveInner(from, dx, dy), "inner"))
    })
  }

  return {
    update(f: CellFrame) {
      cur = f
      outer.setBounds(bounds(frameBbox(f)))
      inner.setBounds(bounds(innerBbox(f)))
      for (const [h, m] of handles) {
        const at = handleAt(f, h)
        m.setLatLng([at.lat, at.lng])
      }
    },
    remove() {
      for (const f of off) f()
      group.remove()
    },
  }
}
