import { detectRegion } from "./outline-detect"
import type { OutlineReply, OutlineRequest } from "./outline-client"
import type { Raster } from "./outline-detect"

// Detect outline's region growing and contour tracing, off the page's main
// thread (outline-client.ts starts it). The picture comes once per
// background; each click then names it by its key.

let picture: { key: string; raster: Raster } | null = null

const scope = globalThis as unknown as {
  onmessage: ((e: MessageEvent<OutlineRequest>) => void) | null
  postMessage: (msg: OutlineReply) => void
}

scope.onmessage = (e) => {
  const m = e.data
  if (m.kind === "picture") {
    picture = { key: m.key, raster: m.raster }
    return
  }
  if (!picture || picture.key !== m.key) {
    scope.postMessage({ id: m.id, missing: true })
    return
  }
  try {
    scope.postMessage({
      id: m.id,
      result: detectRegion(picture.raster, m.seed, m.opts),
    })
  } catch (err) {
    scope.postMessage({
      id: m.id,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}
