import { describe, expect, it } from "vitest"

import { STACK_U_M as U, stackLayout } from "./stack-view"
import type { StackViewMember } from "./stack-view"

const m = (
  device: string,
  position: number,
  rack: string | null,
  u: number | null,
  uHeight = 1,
  desc = false
): StackViewMember => ({
  device,
  position,
  rack: rack ? { id: rack, desc_units: desc } : null,
  u,
  uHeight,
})

const at = (layout: Map<string, number>) =>
  Object.fromEntries([...layout].map(([k, v]) => [k, +(v / U).toFixed(6)]))

describe("stack layout", () => {
  it("keeps the real U positions of members in the current rack", () => {
    const layout = stackLayout(
      [m("a", 1, "r", 40), m("b", 2, "r", 39), m("c", 3, "r", 36)],
      "b"
    )
    expect(at(layout)).toEqual({ a: 4, b: 3, c: 0 })
  })

  it("reads a descending rack the right way up", () => {
    const layout = stackLayout(
      [m("a", 1, "r", 2, 1, true), m("b", 2, "r", 3, 2, true)],
      "a"
    )
    // a takes U2 (higher), b U3-U4 below it.
    expect(at(layout)).toEqual({ a: 2, b: 0 })
  })

  it("stacks members elsewhere below, 1U apart, by member number", () => {
    const layout = stackLayout(
      [
        m("c", 3, "other", 10),
        m("a", 1, "r", 20),
        m("d", 4, null, null),
        m("b", 2, "r", 21),
      ],
      "a"
    )
    // a, b in the rack; c then d below, each 1U under the one above.
    expect(at(layout)).toEqual({ b: 5, a: 4, c: 2, d: 0 })
  })

  it("stacks every member when none shares the current one's rack", () => {
    const layout = stackLayout(
      [m("a", 1, null, null), m("b", 2, null, null, 2), m("c", 3, "x", 4)],
      "a"
    )
    expect(at(layout)).toEqual({ a: 5, b: 2, c: 0 })
  })

  it("uses the rack with the most members when the current one is not racked", () => {
    const layout = stackLayout(
      [m("a", 1, null, null), m("b", 2, "r", 10), m("c", 3, "r", 12)],
      "a"
    )
    expect(at(layout)).toEqual({ b: 2, c: 4, a: 0 })
  })
})
