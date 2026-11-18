import { useEffect, useMemo } from "react"
import { useFrame, useThree } from "@react-three/fiber"

/**
 * A developer's readout of what a 3D canvas costs (docs/features/
 * floor-plans.md → Level of detail): the draw calls and triangles of the
 * last frame - every pass of it, the shadow map and ambient occlusion
 * included - in the canvas' corner. Off unless this browser's
 * `danbyte:3d-stats` key is set; nothing is mounted otherwise.
 *
 * The figures are also left on `window.__danbyte3dStats` for a headless
 * browser to read.
 */

/** `localStorage` switch: any value shows the readout. */
export const RENDER_STATS_KEY = "danbyte:3d-stats"

export interface RenderStats {
  calls: number
  triangles: number
  geometries: number
  programs: number
}

declare global {
  interface Window {
    __danbyte3dStats?: RenderStats
  }
}

export function renderStatsOn(): boolean {
  try {
    return !!localStorage.getItem(RENDER_STATS_KEY)
  } catch {
    return false
  }
}

/** Mounted inside the canvas. Counts every render call of a frame (the
 * renderer's own counters reset per call), and publishes once the frame
 * is drawn. */
export function RenderStatsProbe() {
  const gl = useThree((s) => s.gl)
  const box = useMemo(() => {
    const el = document.createElement("div")
    el.style.cssText =
      "position:absolute;left:8px;bottom:8px;z-index:5;pointer-events:none;" +
      "font:11px/1.4 ui-monospace,monospace;padding:4px 6px;border-radius:6px;" +
      "background:rgba(9,9,11,.75);color:#fafafa;white-space:pre"
    return el
  }, [])
  useEffect(() => {
    const host = gl.domElement.parentElement
    host?.appendChild(box)
    const was = gl.info.autoReset
    gl.info.autoReset = false
    return () => {
      gl.info.autoReset = was
      box.remove()
    }
  }, [gl, box])
  useFrame(() => {
    gl.info.reset()
    // After this frame's render calls, which run once the callbacks have.
    setTimeout(() => {
      const s: RenderStats = {
        calls: gl.info.render.calls,
        triangles: gl.info.render.triangles,
        geometries: gl.info.memory.geometries,
        programs: gl.info.programs?.length ?? 0,
      }
      window.__danbyte3dStats = s
      box.textContent =
        `calls ${s.calls}\ntris  ${s.triangles.toLocaleString()}\n` +
        `geoms ${s.geometries}  progs ${s.programs}`
    }, 0)
  })
  return null
}
