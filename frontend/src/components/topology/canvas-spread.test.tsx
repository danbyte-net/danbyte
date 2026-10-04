// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react"
import { createRef } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { FAN_DEV, fanoutGraph } from "./__fixtures__/fanout-graph"
import { TopologyCanvas } from "./topology-canvas"
import type { CanvasHandle } from "./topology-canvas"

// A Wiring or Flat arrangement carried into the Diagram: its cards are
// drawn at the Diagram's sizes for the first time, and the canvas moves
// apart the ones that now overlap - once - and says where they went.

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  if (!("ResizeObserver" in globalThis))
    globalThis.ResizeObserver = ResizeObserverStub
})
afterEach(cleanup)

const settle = () =>
  act(async () => {
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0))
  })

const CARDS = Object.values(FAN_DEV).map((id) => `dev:${id}`)

type Pos = Record<string, [number, number]>

function overlaps(boxes: ReturnType<CanvasHandle["boxes"]>): string[] {
  const ids = CARDS.filter((id) => id in boxes)
  const out: string[] = []
  for (let i = 0; i < ids.length; i++)
    for (let j = i + 1; j < ids.length; j++) {
      const a = boxes[ids[i]]
      const b = boxes[ids[j]]
      if (
        a.x < b.x + b.w &&
        b.x < a.x + a.w &&
        a.y < b.y + b.h &&
        b.y < a.y + a.h
      )
        out.push(`${ids[i]}|${ids[j]}`)
    }
  return out
}

function draw(positions: Pos, spreadFrom: Pos | undefined, onSpread = vi.fn()) {
  const ref = createRef<CanvasHandle>()
  const ui = (p: Pos, s: Pos | undefined) => (
    <div style={{ width: 800, height: 600 }}>
      <TopologyCanvas
        ref={ref}
        graph={fanoutGraph}
        nodeStyle="diagram"
        diagramMode="detailed"
        positions={p}
        spreadFrom={s}
        onSpread={onSpread}
      />
    </div>
  )
  const r = render(ui(positions, spreadFrom))
  return {
    ref,
    onSpread,
    rerender: (p: Pos, s: Pos | undefined) => r.rerender(ui(p, s)),
  }
}

describe("spreading a carried arrangement", () => {
  it("moves overlapping cards apart once and reports every card", async () => {
    // A Flat map's chips stood this close; the Diagram's cards are larger.
    const carried: Pos = Object.fromEntries(
      CARDS.map((id, i) => [id, [i * 40, 0] as [number, number]])
    )
    const { ref, onSpread, rerender } = draw(carried, carried)
    await settle()
    expect(onSpread).toHaveBeenCalledTimes(1)
    const centres = onSpread.mock.calls[0][0] as Pos
    expect(Object.keys(centres).sort()).toEqual([...CARDS].sort())
    expect(overlaps(ref.current!.boxes())).toEqual([])
    // The canvas shows where it said they went.
    const shown = ref.current!.positions()
    for (const id of CARDS) expect(shown[id]).toEqual(centres[id])
    // The first card (top-left) stays where it was carried to.
    expect(centres[CARDS[0]]).toEqual(carried[CARDS[0]])

    // The page keeps them: the next build is pinned there, not spread.
    rerender(centres, undefined)
    await settle()
    expect(onSpread).toHaveBeenCalledTimes(1)
    expect(overlaps(ref.current!.boxes())).toEqual([])
    const again = ref.current!.positions()
    for (const id of CARDS) expect(again[id]).toEqual(centres[id])
  })

  it("reports an arrangement with room to spare unchanged", async () => {
    const carried: Pos = Object.fromEntries(
      CARDS.map((id, i) => [id, [i * 600, 0] as [number, number]])
    )
    const { onSpread } = draw(carried, carried)
    await settle()
    expect(onSpread).toHaveBeenCalledTimes(1)
    expect(onSpread.mock.calls[0][0]).toEqual(carried)
  })

  it("spreads only the build pinned at exactly that arrangement", async () => {
    const carried: Pos = Object.fromEntries(
      CARDS.map((id) => [id, [0, 0] as [number, number]])
    )
    const { ref, onSpread } = draw({ ...carried }, carried)
    await settle()
    expect(onSpread).not.toHaveBeenCalled()
    expect(overlaps(ref.current!.boxes()).length).toBeGreaterThan(0)
  })
})
