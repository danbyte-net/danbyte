/**
 * 3D render-quality tiers: what the effects stack (shadows, ambient
 * occlusion, device-pixel ratio) is allowed to cost on this machine.
 *
 * Deliberately a PER-DEVICE setting (localStorage), not a plan preference —
 * the workstation's High must not follow the plan onto a weak laptop. And
 * deliberately three-free: the route imports this for its View-popover
 * control, and the 3D stack must stay in its own lazy chunk.
 */

export type RenderQuality = "low" | "medium" | "high"
export type RenderQualitySetting = "auto" | RenderQuality

export const RENDER_QUALITY_SETTINGS = [
  "auto",
  "low",
  "medium",
  "high",
] as const satisfies readonly RenderQualitySetting[]

const STORAGE_KEY = "danbyte.3d.quality"

/**
 * Classify a WEBGL_debug_renderer_info string into a tier. Software
 * rasterisers get Low (shadows alone would slideshow them); known discrete
 * GPUs and Apple silicon get High; everything else — typically integrated
 * graphics behind an ANGLE string — gets Medium, nudged up on a hi-DPI
 * display since those ship on capable machines. Pure and unit-tested.
 */
export function classifyRenderer(renderer: string, dpr: number): RenderQuality {
  const r = renderer.toLowerCase()
  if (/swiftshader|llvmpipe|softpipe|software|microsoft basic render/.test(r))
    return "low"
  if (/nvidia|geforce|rtx|quadro|radeon|\brx\s?\d|apple m\d|arc\s?a\d/.test(r))
    return "high"
  return dpr >= 2 ? "high" : "medium"
}

let detected: RenderQuality | null = null

/** Probe the GPU once (cached) — the "auto" tier resolves through this. */
export function detectRenderQuality(): RenderQuality {
  if (detected) return detected
  let renderer = ""
  try {
    const canvas = document.createElement("canvas")
    const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl")
    if (gl) {
      // Modern browsers expose the real renderer via RENDERER; older ones
      // hide it behind the debug extension.
      const ext = gl.getExtension("WEBGL_debug_renderer_info") as {
        UNMASKED_RENDERER_WEBGL: number
      } | null
      renderer = String(
        gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER) ?? ""
      )
      gl.getExtension("WEBGL_lose_context")?.loseContext()
    }
  } catch {
    // Headless / test environments: fall through to the dpr heuristic.
  }
  detected = classifyRenderer(
    renderer,
    typeof window === "undefined" ? 1 : window.devicePixelRatio || 1
  )
  return detected
}

/** The stored setting, sanitised — anything unrecognised reads as "auto". */
export function storedQualitySetting(): RenderQualitySetting {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    return RENDER_QUALITY_SETTINGS.includes(raw as RenderQualitySetting)
      ? (raw as RenderQualitySetting)
      : "auto"
  } catch {
    return "auto"
  }
}

export function storeQualitySetting(v: RenderQualitySetting): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, v)
  } catch {
    // Storage full/blocked — the session keeps the in-memory choice.
  }
}
