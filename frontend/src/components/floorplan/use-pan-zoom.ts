import { useCallback, useRef, useState } from "react"

export interface Transform {
  x: number
  y: number
  k: number
}

/** The zoom-out floor for a small plan; a plan too big to fit at it gets a
 * lower one (see `fitTo`). */
export const MIN_ZOOM = 0.15
const MAX_ZOOM = 4

/** How far out a plan may zoom once `fitK` fits it on screen: half of that,
 * and never less room than a small plan gets. */
export function minZoomFor(fitK: number | null): number {
  return fitK == null ? MIN_ZOOM : Math.min(MIN_ZOOM, fitK / 2)
}

interface Point {
  x: number
  y: number
}

/** Where a two-finger pinch began: the transform, and the fingers' distance
 * and midpoint (container px). */
export interface PinchStart {
  t: Transform
  dist: number
  mid: Point
}

/**
 * The transform a pinch has reached: scaled by how far the fingers spread,
 * within the wheel's zoom limits, about the point first under their midpoint
 * - which then follows the midpoint, so two fingers pan as they zoom.
 */
export function pinchTransform(
  start: PinchStart,
  dist: number,
  mid: Point,
  minZoom: number = MIN_ZOOM
): Transform {
  const k = Math.min(
    MAX_ZOOM,
    Math.max(minZoom, start.t.k * (dist / start.dist))
  )
  const wx = (start.mid.x - start.t.x) / start.t.k
  const wy = (start.mid.y - start.t.y) / start.t.k
  return { k, x: mid.x - wx * k, y: mid.y - wy * k }
}

/**
 * Pan/zoom for a plain SVG canvas: wheel zooms about the cursor, pointer
 * drag on the background pans, and on a touch screen two fingers pinch to
 * zoom. The consumer applies the returned transform to a `<g>` and spreads
 * the handlers onto the `<svg>`.
 */
export function usePanZoom(initial: Transform = { x: 40, y: 40, k: 1 }) {
  const [t, setT] = useState<Transform>(initial)
  // The zoom-out floor: lowered by `fitTo` for a plan too big for the
  // fixed one, so a whole site can be seen at once.
  const minZoom = useRef(MIN_ZOOM)
  const tRef = useRef(t)
  tRef.current = t
  const panning = useRef<{
    px: number
    py: number
    ox: number
    oy: number
  } | null>(null)
  // Touch points down on the canvas (container px), and the pinch they make
  // once there are two. `pinched` holds from the second finger until the
  // last one lifts, so a finger left behind neither pans nor drags.
  const touches = useRef(new Map<number, Point>())
  const pinch = useRef<PinchStart | null>(null)
  const pinched = useRef(false)

  const onWheel = useCallback((e: React.WheelEvent<SVGSVGElement>) => {
    e.preventDefault()
    const rect = e.currentTarget.getBoundingClientRect()
    const cx = e.clientX - rect.left
    const cy = e.clientY - rect.top
    setT((prev) => {
      const k = Math.min(
        MAX_ZOOM,
        Math.max(minZoom.current, prev.k * Math.pow(1.0015, -e.deltaY))
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
      const fit = Math.min((rect.width - 64) / w, (rect.height - 64) / h)
      minZoom.current = minZoomFor(fit)
      const k = Math.min(MAX_ZOOM, Math.max(minZoom.current, fit))
      setT({ k, x: (rect.width - w * k) / 2, y: (rect.height - h * k) / 2 })
    },
    []
  )

  const touchAt = (e: React.PointerEvent<SVGSVGElement>): Point => {
    const rect = e.currentTarget.getBoundingClientRect()
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }
  const spread = () => {
    const [a, b] = [...touches.current.values()]
    return {
      dist: Math.hypot(b.x - a.x, b.y - a.y) || 1,
      mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
    }
  }

  /** A pointer goes down. True when it belongs to a pinch - the second
   * finger starts one - so the canvas drops whatever the first finger
   * began and leaves this press alone. Mouse and pen never pinch. */
  const pinchDown = useCallback(
    (e: React.PointerEvent<SVGSVGElement>): boolean => {
      if (e.pointerType !== "touch") return false
      touches.current.set(e.pointerId, touchAt(e))
      if (touches.current.size < 2) return pinched.current
      if (!pinched.current) {
        pinched.current = true
        panning.current = null
        pinch.current = { t: tRef.current, ...spread() }
      }
      return true
    },
    []
  )

  /** A pointer moves. True when the pinch took it. */
  const pinchMove = useCallback(
    (e: React.PointerEvent<SVGSVGElement>): boolean => {
      if (!touches.current.has(e.pointerId)) return false
      touches.current.set(e.pointerId, touchAt(e))
      if (!pinched.current) return false
      const start = pinch.current
      if (start && touches.current.size >= 2) {
        const { dist, mid } = spread()
        setT(pinchTransform(start, dist, mid, minZoom.current))
      }
      return true
    },
    []
  )

  /** A pointer lifts or leaves. True when it was part of a pinch. */
  const pinchUp = useCallback((e: React.PointerEvent): boolean => {
    if (!touches.current.delete(e.pointerId)) return pinched.current
    const was = pinched.current
    if (touches.current.size < 2) pinch.current = null
    if (touches.current.size === 0) pinched.current = false
    return was
  }, [])

  return {
    t,
    setT,
    onWheel,
    startPan,
    movePan,
    endPan,
    toWorld,
    fitTo,
    pinchDown,
    pinchMove,
    pinchUp,
  }
}
