import { useCallback, useRef, useState } from "react"

export interface Transform {
  x: number
  y: number
  k: number
}

const MIN_ZOOM = 0.15
const MAX_ZOOM = 4

/**
 * Pan/zoom for a plain SVG canvas: wheel zooms about the cursor, pointer
 * drag on the background pans. The consumer applies the returned transform
 * to a `<g>` and spreads the handlers onto the `<svg>`.
 */
export function usePanZoom(initial: Transform = { x: 40, y: 40, k: 1 }) {
  const [t, setT] = useState<Transform>(initial)
  const panning = useRef<{
    px: number
    py: number
    ox: number
    oy: number
  } | null>(null)

  const onWheel = useCallback((e: React.WheelEvent<SVGSVGElement>) => {
    e.preventDefault()
    const rect = e.currentTarget.getBoundingClientRect()
    const cx = e.clientX - rect.left
    const cy = e.clientY - rect.top
    setT((prev) => {
      const k = Math.min(
        MAX_ZOOM,
        Math.max(MIN_ZOOM, prev.k * Math.pow(1.0015, -e.deltaY))
      )
      // Keep the world point under the cursor fixed while scaling.
      const wx = (cx - prev.x) / prev.k
      const wy = (cy - prev.y) / prev.k
      return { k, x: cx - wx * k, y: cy - wy * k }
    })
  }, [])

  const startPan = useCallback(
    (e: React.PointerEvent) => {
      panning.current = { px: e.clientX, py: e.clientY, ox: t.x, oy: t.y }
    },
    [t]
  )

  const movePan = useCallback((e: React.PointerEvent) => {
    const p = panning.current
    if (!p) return false
    setT((prev) => ({
      ...prev,
      x: p.ox + (e.clientX - p.px),
      y: p.oy + (e.clientY - p.py),
    }))
    return true
  }, [])

  const endPan = useCallback(() => {
    const was = !!panning.current
    panning.current = null
    return was
  }, [])

  /** Client coords → world (pre-transform) coords. */
  const toWorld = useCallback(
    (svg: SVGSVGElement, clientX: number, clientY: number) => {
      const rect = svg.getBoundingClientRect()
      return {
        x: (clientX - rect.left - t.x) / t.k,
        y: (clientY - rect.top - t.y) / t.k,
      }
    },
    [t]
  )

  /** Fit a w×h world box into the container with a margin. */
  const fitTo = useCallback(
    (svg: SVGSVGElement | null, w: number, h: number) => {
      if (!svg) return
      const rect = svg.getBoundingClientRect()
      if (!rect.width || !rect.height) return
      const k = Math.min(
        MAX_ZOOM,
        Math.max(
          MIN_ZOOM,
          Math.min((rect.width - 64) / w, (rect.height - 64) / h)
        )
      )
      setT({ k, x: (rect.width - w * k) / 2, y: (rect.height - h * k) / 2 })
    },
    []
  )

  return { t, setT, onWheel, startPan, movePan, endPan, toWorld, fitTo }
}
