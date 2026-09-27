import { useEffect, useRef } from "react"
import { Panel, useStoreApi } from "@xyflow/react"
import type { MiniMapNodeProps, Node, ReactFlowState } from "@xyflow/react"

// The minimap's cards on one canvas, for a big map. React Flow's MiniMap
// draws an SVG rect per node: on a 2,400-device site that is 2,400 more
// elements to create and style when the map arrives, and again whenever
// the page recalculates styles. Above CANVAS_MINIMAP_AT nodes the MiniMap
// keeps its frame, viewport mask, panning and zooming but draws no nodes
// (`NoMiniMapNode`), and this panel - the same box, underneath it - paints
// them: the same rects, in the same colours, where the SVG put them.

/** Nodes above which the minimap's cards go on the canvas. */
export const CANVAS_MINIMAP_AT = 500

// React Flow's MiniMap defaults: its size, the margin it keeps round the
// map (offsetScale) and its nodes' corner radius (nodeBorderRadius).
const WIDTH = 200
const HEIGHT = 150
const OFFSET = 5
const RADIUS = 5
/** The fill a node gets when neither nodeColor nor its style names one. */
const DEFAULT_FILL =
  "var(--xy-minimap-node-background-color, var(--xy-minimap-node-background-color-default))"

/** The MiniMap's node, drawn by `MiniMapCanvas` instead. */
export function NoMiniMapNode(_: MiniMapNodeProps) {
  void _
  return null
}

export interface Frame {
  x: number
  y: number
  width: number
  height: number
}

/**
 * The flow area the MiniMap shows - its SVG's viewBox - as React Flow's
 * MiniMap works it out: the visible nodes and the viewport together,
 * widened to the MiniMap's shape, with a margin.
 */
export function miniMapFrame(
  s: Pick<ReactFlowState, "transform" | "width" | "height" | "nodeLookup">
): Frame {
  const [tx, ty, zoom] = s.transform
  const view = {
    x: -tx / zoom,
    y: -ty / zoom,
    width: s.width / zoom,
    height: s.height / zoom,
  }
  let bounds = view
  if (s.nodeLookup.size > 0) {
    let x = Infinity
    let y = Infinity
    let x2 = -Infinity
    let y2 = -Infinity
    let any = false
    for (const n of s.nodeLookup.values()) {
      if (n.hidden) continue
      const p = n.internals.positionAbsolute
      x = Math.min(x, p.x)
      y = Math.min(y, p.y)
      x2 = Math.max(
        x2,
        p.x + (n.measured.width ?? n.width ?? n.initialWidth ?? 0)
      )
      y2 = Math.max(
        y2,
        p.y + (n.measured.height ?? n.height ?? n.initialHeight ?? 0)
      )
      any = true
    }
    if (!any) x = y = x2 = y2 = 0
    // Through a rect and back, as React Flow's bounds go: the same floats.
    const nodes = { x, y, width: x2 - x, height: y2 - y }
    const left = Math.min(nodes.x, view.x)
    const top = Math.min(nodes.y, view.y)
    bounds = {
      x: left,
      y: top,
      width: Math.max(nodes.x + nodes.width, view.x + view.width) - left,
      height: Math.max(nodes.y + nodes.height, view.y + view.height) - top,
    }
  }
  const scale = Math.max(bounds.width / WIDTH, bounds.height / HEIGHT)
  const w = scale * WIDTH
  const h = scale * HEIGHT
  const offset = OFFSET * scale
  return {
    x: bounds.x - (w - bounds.width) / 2 - offset,
    y: bounds.y - (h - bounds.height) / 2 - offset,
    width: w + offset * 2,
    height: h + offset * 2,
  }
}

/**
 * The cards of the MiniMap it sits under: pass the MiniMap's `nodeColor`,
 * and the theme so the colours are looked up again when it changes.
 */
export function MiniMapCanvas({
  nodeColor,
  theme,
}: {
  nodeColor?: (n: Node) => string
  theme: string
}) {
  const store = useStoreApi()
  const canvas = useRef<HTMLCanvasElement>(null)
  const probe = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    const el = canvas.current
    const swatch = probe.current
    const ctx = el?.getContext("2d")
    if (!el || !swatch || !ctx) return
    // A CSS colour (a token, a var()) as the canvas can take it.
    const fills = new Map<string, string>()
    const fillOf = (css: string) => {
      let fill = fills.get(css)
      if (fill === undefined) {
        swatch.style.color = css
        fill = getComputedStyle(swatch).color
        fills.set(css, fill)
      }
      return fill
    }
    let frame = 0
    const draw = () => {
      frame = 0
      const s = store.getState()
      const dpr = window.devicePixelRatio || 1
      if (el.width !== Math.round(WIDTH * dpr)) {
        el.width = Math.round(WIDTH * dpr)
        el.height = Math.round(HEIGHT * dpr)
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.clearRect(0, 0, el.width, el.height)
      const box = miniMapFrame(s)
      // The SVG fits its view box into its size, centred (xMidYMid meet);
      // here in device pixels.
      const fit = Math.min(WIDTH / box.width, HEIGHT / box.height)
      if (!Number.isFinite(fit)) return
      const k = fit * dpr
      const ox = ((WIDTH - box.width * fit) / 2) * dpr
      const oy = ((HEIGHT - box.height * fit) / 2) * dpr

      let current = ""
      for (const user of s.nodes) {
        const n = s.nodeLookup.get(user.id)
        if (!n || n.hidden) continue
        const node = n.internals.userNode
        const w = node.measured?.width ?? node.width ?? node.initialWidth
        const h = node.measured?.height ?? node.height ?? node.initialHeight
        if (w === undefined || h === undefined) continue
        const style = node.style as
          | { background?: string; backgroundColor?: string }
          | undefined
        const fill = fillOf(
          nodeColor?.(node) ||
            style?.background ||
            style?.backgroundColor ||
            DEFAULT_FILL
        )
        if (fill !== current) {
          ctx.fillStyle = fill
          current = fill
        }
        const { x, y } = n.internals.positionAbsolute
        // Whole device pixels, as the SVG's crisp edges snap them.
        const left = Math.round((x - box.x) * k + ox)
        const top = Math.round((y - box.y) * k + oy)
        const right = Math.round((x + w - box.x) * k + ox)
        const bottom = Math.round((y + h - box.y) * k + oy)
        if (right <= left || bottom <= top) continue
        const r = RADIUS * k
        if (r >= 1 && right - left > 2 * r && bottom - top > 2 * r) {
          ctx.beginPath()
          ctx.roundRect(left, top, right - left, bottom - top, r)
          ctx.fill()
        } else ctx.fillRect(left, top, right - left, bottom - top)
      }
    }
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(draw)
    }
    // A frame on: a theme switch has put its colours in by then.
    schedule()
    const stop = store.subscribe(schedule)
    return () => {
      stop()
      if (frame) cancelAnimationFrame(frame)
    }
  }, [store, nodeColor, theme])
  return (
    // Under the MiniMap: the same panel box, and the card background the
    // MiniMap then leaves to it. Its border stays the MiniMap's.
    <Panel
      position="bottom-right"
      className="pointer-events-none rounded-md border !border-transparent !bg-card"
    >
      <canvas
        ref={canvas}
        aria-hidden
        className="block"
        style={{ width: WIDTH, height: HEIGHT }}
      />
      <span ref={probe} hidden />
    </Panel>
  )
}
