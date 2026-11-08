import { describe, expect, it } from "vitest"

import { OutlineDetector } from "./outline-client"
import type { OutlineReply, OutlineRequest, WorkerLike } from "./outline-client"
import { detectRegion } from "./outline-detect"
import type { DetectOptions, Raster } from "./outline-detect"
import { mapTile } from "./outline-detect.fixtures"

const OPTS: DetectOptions = {
  mode: "colour",
  tolerance: 8,
  threshold: 128,
  gapPx: 0,
}

/** A worker in the same thread: what outline.worker.ts does, with the
 * messages it was sent. */
function fakeWorker(opts: { crash?: boolean } = {}) {
  const sent: OutlineRequest[] = []
  let picture: Raster | null = null
  const w: WorkerLike = {
    onmessage: null,
    onerror: null,
    terminate: () => {},
    postMessage: (m) => {
      sent.push(m)
      if (m.kind === "picture") {
        picture = m.raster
        return
      }
      queueMicrotask(() => {
        if (opts.crash) {
          w.onerror?.({ preventDefault() {} } as ErrorEvent)
          return
        }
        const reply: OutlineReply = picture
          ? { id: m.id, result: detectRegion(picture, m.seed, m.opts) }
          : { id: m.id, missing: true }
        w.onmessage?.({ data: reply } as MessageEvent<OutlineReply>)
      })
    },
  }
  return { w, sent }
}

describe("the outline worker's client", () => {
  const { raster } = mapTile()

  it("sends the picture once per background, then only clicks", async () => {
    const { w, sent } = fakeWorker()
    const d = new OutlineDetector(() => w)
    const a = await d.detect("/bg.png", raster, [70, 70], OPTS)
    const b = await d.detect("/bg.png", raster, [200, 40], OPTS)
    expect(a.ok && b.ok).toBe(true)
    expect(sent.map((m) => m.kind)).toEqual(["picture", "detect", "detect"])
    // A copy went: the page keeps its pixels.
    expect(raster.data.byteLength).toBeGreaterThan(0)
  })

  it("works in place without a worker, or when the worker fails", async () => {
    const inline = new OutlineDetector(() => null)
    expect((await inline.detect("k", raster, [70, 70], OPTS)).ok).toBe(true)
    const { w } = fakeWorker({ crash: true })
    const crashing = new OutlineDetector(() => w)
    expect((await crashing.detect("k", raster, [70, 70], OPTS)).ok).toBe(true)
  })
})
