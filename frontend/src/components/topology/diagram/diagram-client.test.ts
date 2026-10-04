import { describe, expect, it } from "vitest"

import { approxMeasure, measureOf } from "@/lib/diagram/measure"
import { aarhusGraph } from "../__fixtures__/aarhus-graph"
import { fanoutGraph } from "../__fixtures__/fanout-graph"
import { DiagramWorker, relinkedModel } from "./diagram-client"
import type { WorkerLike } from "./diagram-client"
import { diagramHost } from "./diagram-host"
import type { HostReply, HostRequest, WireOptions } from "./diagram-host"

// The page's side of the worker, against the real handler run behind a
// fake worker that copies every message as a real one would.

function fakeWorker(opts: { fail?: boolean } = {}) {
  const sent: HostRequest[] = []
  const handle = diagramHost(() =>
    Promise.resolve({ measure: approxMeasure, kind: "canvas" as const })
  )
  const w: WorkerLike = {
    onmessage: null,
    onerror: null,
    terminate: () => undefined,
    postMessage: (msg) => {
      sent.push(structuredClone(msg))
      setTimeout(() => {
        if (opts.fail) {
          w.onerror?.({
            message: "no worker",
            preventDefault: () => undefined,
          } as ErrorEvent)
          return
        }
        void handle(structuredClone(msg)).then((reply: HostReply) =>
          w.onmessage?.({ data: structuredClone(reply) } as MessageEvent)
        )
      }, 0)
    },
  }
  return { w, sent }
}

const OPTS: WireOptions = { mode: "simple", line: "elbow", colorMode: "cable" }

describe("DiagramWorker", () => {
  it("builds with the worker's measure kind, sending a graph once", async () => {
    const { w, sent } = fakeWorker()
    const client = new DiagramWorker(() => w)
    const a = await client.build(aarhusGraph, OPTS)
    const b = await client.build(aarhusGraph, { ...OPTS, mode: "detailed" })
    const c = await client.build(fanoutGraph, OPTS)
    expect(a?.model.measure).toBe(measureOf("canvas"))
    expect(b?.nodes.length).toBe(a?.nodes.length)
    expect(c?.modelId).toBe(3)
    expect(sent.map((r) => r.kind === "build" && !!r.graph)).toEqual([
      true,
      false,
      true,
    ])
  })

  it("runs only the newest of the builds asked for while one runs", async () => {
    const { w, sent } = fakeWorker()
    const client = new DiagramWorker(() => w)
    const first = client.build(aarhusGraph, OPTS)
    const second = client.build(aarhusGraph, { ...OPTS, line: "bendy" })
    const third = client.build(aarhusGraph, { ...OPTS, line: "straight" })
    expect(await second).toBeNull()
    expect((await first)?.modelId).toBe(1)
    expect((await third)?.modelId).toBe(2)
    expect(
      sent.map((r) => (r.kind === "build" ? r.opts.line : r.kind))
    ).toEqual(["elbow", "straight"])
  })

  it("relinks by the model's name and keeps the page's model in step", async () => {
    const { w } = fakeWorker()
    const client = new DiagramWorker(() => w)
    const built = await client.build(aarhusGraph, OPTS)
    if (!built) throw new Error("no build")
    const moved = built.nodes.map((n, i) =>
      i === 1
        ? { ...n, position: { x: n.position.x, y: n.position.y + 300 } }
        : n
    )
    const re = await client.relink(built.modelId, moved)
    expect(re.edges).toHaveLength(built.edges.length)
    const next = relinkedModel(built.model, re.cards)
    for (const [id, card] of re.cards) expect(next.shown.get(id)).toBe(card)
    expect(next.measure).toBe(built.model.measure)
  })

  it("rejects everything once the worker fails, so the page builds in place", async () => {
    const { w } = fakeWorker({ fail: true })
    const client = new DiagramWorker(() => w)
    await expect(client.build(aarhusGraph, OPTS)).rejects.toThrow("no worker")
    await expect(client.build(aarhusGraph, OPTS)).rejects.toThrow("no worker")
  })
})
