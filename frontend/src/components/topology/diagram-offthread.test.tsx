// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { approxMeasure } from "@/lib/diagram/measure"
import { fanoutGraph } from "./__fixtures__/fanout-graph"
import type * as Build from "./diagram/build-diagram"
import type * as Client from "./diagram/diagram-client"
import type { WorkerLike } from "./diagram/diagram-client"
import { diagramHost } from "./diagram/diagram-host"
import type { HostReply, HostRequest } from "./diagram/diagram-host"

// A browser with workers: the Diagram is built off the main thread. The
// page shows "Loading..." until the build lands, never builds in place,
// and builds in place after all when the worker fails.

const worker = vi.hoisted(() => ({ fail: false, builds: 0 }))

vi.mock("./diagram/build-diagram", async (orig) => {
  const m = await orig<typeof Build>()
  return { ...m, buildDiagram: vi.fn(m.buildDiagram) }
})

vi.mock("./diagram/diagram-client", async (orig) => {
  const m = await orig<typeof Client>()
  // The real handler behind a fake worker: messages are copied, and
  // answers come a task later, as from a real one.
  const start = (): WorkerLike => {
    const handle = diagramHost(() =>
      Promise.resolve({ measure: approxMeasure, kind: "approx" as const })
    )
    const w: WorkerLike = {
      onmessage: null,
      onerror: null,
      terminate: () => undefined,
      postMessage: (msg: HostRequest) => {
        const copy = structuredClone(msg)
        setTimeout(() => {
          if (worker.fail) {
            w.onerror?.({
              message: "blocked",
              preventDefault: () => undefined,
            } as ErrorEvent)
            return
          }
          if (copy.kind === "build") worker.builds++
          void handle(copy).then((reply: HostReply) =>
            w.onmessage?.({ data: structuredClone(reply) } as MessageEvent)
          )
        }, 0)
      },
    }
    return w
  }
  class FakeWorker extends m.DiagramWorker {
    constructor() {
      super(start)
    }
  }
  return { ...m, canBuildOffThread: () => true, DiagramWorker: FakeWorker }
})

const { buildDiagram } = await import("./diagram/build-diagram")
const { TopologyCanvas } = await import("./topology-canvas")

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  if (!("ResizeObserver" in globalThis))
    globalThis.ResizeObserver = ResizeObserverStub
  vi.mocked(buildDiagram).mockClear()
  worker.fail = false
  worker.builds = 0
})
afterEach(cleanup)

const settle = () =>
  act(async () => {
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0))
  })

describe("Diagram built off the main thread", () => {
  it("shows Loading... until the worker's build lands", async () => {
    const { container } = render(
      <div style={{ width: 800, height: 600 }}>
        <TopologyCanvas graph={fanoutGraph} nodeStyle="diagram" />
      </div>
    )
    await act(async () => {
      await Promise.resolve()
    })
    expect(screen.getByText("Loading...")).toBeTruthy()
    await settle()
    expect(screen.queryByText("Loading...")).toBeNull()
    expect(worker.builds).toBe(1)
    // Only the worker built it (the handler runs in this test's thread).
    expect(buildDiagram).toHaveBeenCalledTimes(1)
    expect(container.querySelectorAll("[data-card]").length).toBe(
      fanoutGraph.nodes.length
    )
  })

  it("builds in place when the worker fails", async () => {
    worker.fail = true
    const { container } = render(
      <div style={{ width: 800, height: 600 }}>
        <TopologyCanvas graph={fanoutGraph} nodeStyle="diagram" />
      </div>
    )
    await settle()
    expect(worker.builds).toBe(0)
    expect(buildDiagram).toHaveBeenCalledTimes(1)
    expect(screen.queryByText("Loading...")).toBeNull()
    expect(container.querySelectorAll("[data-card]").length).toBe(
      fanoutGraph.nodes.length
    )
  })
})
