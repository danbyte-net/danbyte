// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type * as Measure from "@/lib/diagram/measure"
import { fanoutGraph } from "./__fixtures__/fanout-graph"
import type * as Build from "./diagram/build-diagram"

// The Diagram's cards are sized from measured text. When Inter is already
// loaded the map is built once; when it loads after the first build, the
// cards are measured again where they stand - no second layout.

const fonts = vi.hoisted(() => ({ changed: false }))

vi.mock("@/lib/diagram/measure", async (orig) => ({
  ...(await orig<typeof Measure>()),
  diagramFontsReady: vi.fn(() => Promise.resolve(fonts.changed)),
}))

vi.mock("./diagram/build-diagram", async (orig) => {
  const m = await orig<typeof Build>()
  return {
    ...m,
    buildDiagram: vi.fn(m.buildDiagram),
    remeasureDiagram: vi.fn(m.remeasureDiagram),
  }
})

const { buildDiagram, remeasureDiagram } =
  await import("./diagram/build-diagram")
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
  vi.mocked(remeasureDiagram).mockClear()
})
afterEach(cleanup)

async function mount() {
  render(
    <div style={{ width: 800, height: 600 }}>
      <TopologyCanvas graph={fanoutGraph} nodeStyle="diagram" />
    </div>
  )
  // Let the fonts promise settle and its effect run.
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe("Diagram fonts", () => {
  it("builds once when the font was ready all along", async () => {
    fonts.changed = false
    await mount()
    expect(buildDiagram).toHaveBeenCalledTimes(1)
    expect(remeasureDiagram).not.toHaveBeenCalled()
  })

  it("measures the cards again, without a new layout, when it loads late", async () => {
    fonts.changed = true
    await mount()
    expect(buildDiagram).toHaveBeenCalledTimes(1)
    expect(remeasureDiagram).toHaveBeenCalledTimes(1)
  })
})
