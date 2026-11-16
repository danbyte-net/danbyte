import { useRef } from "react"
import type { ReactNode } from "react"
import { useFrame, useThree } from "@react-three/fiber"

/** The canvas edge a card keeps clear of, in CSS pixels. */
const MARGIN_PX = 8

/** How far to move a box so it lies inside `bounds` (less the margin):
 * pushed in from whichever edge it crosses, the left/top edge winning
 * when it is bigger than the bounds. */
export function shiftIntoView(
  box: { left: number; top: number; right: number; bottom: number },
  bounds: { left: number; top: number; right: number; bottom: number },
  margin = MARGIN_PX
): { x: number; y: number } {
  const axis = (lo: number, hi: number, min: number, max: number) => {
    if (lo < min + margin) return min + margin - lo
    if (hi > max - margin) return Math.max(max - margin - hi, min + margin - lo)
    return 0
  }
  return {
    x: axis(box.left, box.right, bounds.left, bounds.right),
    y: axis(box.top, box.bottom, bounds.top, bounds.bottom),
  }
}

/** Wraps a drei `<Html>` card so it stays inside the canvas: each frame it
 * measures the card where `<Html>` put it and moves it back in from any
 * edge it crosses (a port hovered at the panel's right end). */
export function KeepInView({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const shift = useRef({ x: 0, y: 0 })
  const gl = useThree((s) => s.gl)
  const invalidate = useThree((s) => s.invalidate)
  useFrame(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    if (!r.width) return
    const s = shift.current
    // Where the card would be without the current shift.
    const box = {
      left: r.left - s.x,
      right: r.right - s.x,
      top: r.top - s.y,
      bottom: r.bottom - s.y,
    }
    const next = shiftIntoView(box, gl.domElement.getBoundingClientRect())
    if (next.x === s.x && next.y === s.y) return
    shift.current = next
    el.style.transform = `translate(${next.x}px, ${next.y}px)`
    invalidate()
  })
  return (
    <div ref={ref} style={{ width: "max-content" }}>
      {children}
    </div>
  )
}
