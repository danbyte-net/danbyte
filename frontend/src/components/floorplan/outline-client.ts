import { detectRegion } from "./outline-detect"
import type { DetectOptions, DetectResult, Raster } from "./outline-detect"
import type { Pt } from "./shapes"

// The page's side of Detect outline's worker (outline.worker.ts): the
// background is read into pixels once, handed to the worker, and each
// click comes back as a promise. Without workers (the server, tests, an old
// browser) or when the worker fails, the same code runs in place.

/** The most pixels a background is read at: larger pictures are scaled
 * down to this, which is still several pixels a cell on the largest grid. */
export const MAX_PICTURE_PIXELS = 4_000_000

export type OutlineRequest =
  | { kind: "picture"; key: string; raster: Raster }
  | { kind: "detect"; id: number; key: string; seed: Pt; opts: DetectOptions }

export type OutlineReply =
  | { id: number; result: DetectResult }
  | { id: number; missing: true }
  | { id: number; error: string }

/** What `OutlineDetector` talks to. */
export interface WorkerLike {
  postMessage: (msg: OutlineRequest, transfer: Transferable[]) => void
  terminate: () => void
  onmessage: ((e: MessageEvent<OutlineReply>) => void) | null
  onerror: ((e: ErrorEvent) => void) | null
}

function startWorker(): WorkerLike | null {
  if (typeof window === "undefined" || typeof Worker === "undefined")
    return null
  try {
    return new Worker(new URL("./outline.worker.ts", import.meta.url), {
      type: "module",
      name: "outline",
    })
  } catch {
    return null
  }
}

/** One editor's detector: a worker while it works, in place after. */
export class OutlineDetector {
  private worker: WorkerLike | null | undefined = undefined
  private sent: string | null = null
  private seq = 0
  private waiting = new Map<number, (r: OutlineReply) => void>()

  constructor(private readonly start: () => WorkerLike | null = startWorker) {}

  private live(): WorkerLike | null {
    if (this.worker === undefined) {
      const w = this.start()
      if (w) {
        w.onmessage = (e) => {
          const done = this.waiting.get(e.data.id)
          this.waiting.delete(e.data.id)
          done?.(e.data)
        }
        w.onerror = (e) => {
          e.preventDefault()
          this.fail()
        }
      }
      this.worker = w
    }
    return this.worker
  }

  private fail() {
    this.worker?.terminate()
    this.worker = null
    for (const done of this.waiting.values())
      done({ id: -1, error: "worker failed" })
    this.waiting.clear()
  }

  /** The region round `seed` (a pixel of `raster`) and its contour. */
  async detect(
    key: string,
    raster: Raster,
    seed: Pt,
    opts: DetectOptions
  ): Promise<DetectResult> {
    const w = this.live()
    if (!w) return detectRegion(raster, seed, opts)
    if (this.sent !== key) {
      // A copy, so the page keeps its pixels for the next worker.
      const copy = new Uint8ClampedArray(raster.data)
      w.postMessage(
        {
          kind: "picture",
          key,
          raster: { width: raster.width, height: raster.height, data: copy },
        },
        [copy.buffer]
      )
      this.sent = key
    }
    const id = ++this.seq
    const reply = await new Promise<OutlineReply>((resolve) => {
      this.waiting.set(id, resolve)
      w.postMessage({ kind: "detect", id, key, seed, opts }, [])
    })
    if ("result" in reply) return reply.result
    if ("missing" in reply) this.sent = null
    else this.fail()
    return detectRegion(raster, seed, opts)
  }

  dispose() {
    this.worker?.terminate()
    this.worker = null
    this.waiting.clear()
  }
}

/** A background picture as pixels, scaled to at most `maxPixels`. Rejects
 * when the browser cannot read it (no canvas, or a picture from another
 * site that does not allow it). */
export async function loadPicture(
  url: string,
  maxPixels = MAX_PICTURE_PIXELS
): Promise<Raster> {
  const img = new Image()
  img.crossOrigin = "anonymous"
  img.decoding = "async"
  img.src = url
  await img.decode()
  const w0 = img.naturalWidth
  const h0 = img.naturalHeight
  if (!w0 || !h0) throw new Error("empty picture")
  const k = Math.min(1, Math.sqrt(maxPixels / (w0 * h0)))
  const width = Math.max(1, Math.round(w0 * k))
  const height = Math.max(1, Math.round(h0 * k))
  const canvas = document.createElement("canvas")
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext("2d", { willReadFrequently: true })
  if (!ctx) throw new Error("no canvas")
  ctx.drawImage(img, 0, 0, width, height)
  const data = ctx.getImageData(0, 0, width, height).data
  return { width, height, data }
}
