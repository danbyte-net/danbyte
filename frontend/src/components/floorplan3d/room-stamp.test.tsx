// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { CAPACITY_HEX } from "@/lib/rack-capacity"

import { rackFrameColor } from "./rack-mesh"
import { roomStamp } from "./room-stamp"
import { InvalidateOnToggle } from "./stage"

// The 3D room draws only on demand. A rack's Color by tint (#247) reaches it
// as a prop, which the frameloop does not see: unless the tint is in the
// room's frame stamp, the canvas keeps showing the old colours.

const { invalidate } = vi.hoisted(() => ({ invalidate: vi.fn() }))
vi.mock("@react-three/fiber", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useThree: (pick: (s: { invalidate: () => void }) => unknown) =>
    pick({ invalidate }),
}))

beforeEach(() => invalidate.mockReset())
afterEach(cleanup)

const VIEW = {
  showWalls: true,
  showCables: false,
  showCeiling: false,
  showAirflow: false,
  showNames: false,
  namesScope: "all",
  namesAtEdge: false,
  showUNumbers: false,
  floorPeek: false,
  shellMode: "cutaway",
  quality: "medium",
}

const tints = (t2: string) =>
  new Map([
    ["t1", CAPACITY_HEX.good],
    ["t2", t2],
  ])

describe("the room's frame stamp", () => {
  it("changes with a rack's tint and with the rack pointed at", () => {
    const base = roomStamp({ ...VIEW, tints: tints(CAPACITY_HEX.warn) })
    expect(roomStamp({ ...VIEW, tints: tints(CAPACITY_HEX.warn) })).toBe(base)
    expect(
      roomStamp({ ...VIEW, tints: tints(CAPACITY_HEX.critical) })
    ).not.toBe(base)
    expect(
      roomStamp({
        ...VIEW,
        tints: tints(CAPACITY_HEX.warn),
        pointed: new Set(["t2"]),
      })
    ).not.toBe(base)
    // Colouring switched off clears every tint: that redraws too.
    expect(roomStamp({ ...VIEW, tints: new Map() })).not.toBe(base)
  })

  it("draws a frame when a tint changes, and only then", () => {
    const stamp = (t2: string) =>
      roomStamp({ ...VIEW, tints: tints(t2), pointed: new Set() })
    const { rerender } = render(
      <InvalidateOnToggle stamp={stamp(CAPACITY_HEX.warn)} />
    )
    expect(invalidate).toHaveBeenCalledTimes(1)
    // A refetch that brings the same colours in new objects: no frame.
    rerender(<InvalidateOnToggle stamp={stamp(CAPACITY_HEX.warn)} />)
    expect(invalidate).toHaveBeenCalledTimes(1)
    // The rack filled up: one frame, so the new colour shows.
    rerender(<InvalidateOnToggle stamp={stamp(CAPACITY_HEX.critical)} />)
    expect(invalidate).toHaveBeenCalledTimes(2)
  })
})

describe("a cabinet's body colour", () => {
  it("is its tint, a shade lighter under the pointer", () => {
    expect(
      rackFrameColor({
        tint: CAPACITY_HEX.good,
        selected: false,
        hovered: false,
      })
    ).toBe(CAPACITY_HEX.good)
    const hover = rackFrameColor({
      tint: CAPACITY_HEX.good,
      selected: false,
      hovered: true,
    })
    expect(hover).toMatch(/^#[0-9a-f]{6}$/)
    expect(hover).not.toBe(CAPACITY_HEX.good)
  })

  it("is the selection blue while selected or pointed at from the table", () => {
    expect(
      rackFrameColor({
        tint: CAPACITY_HEX.critical,
        selected: true,
        hovered: false,
      })
    ).toBe("#0ea5e9")
  })

  it("is painted steel with no colouring, as before", () => {
    expect(
      rackFrameColor({ tint: null, selected: false, hovered: false })
    ).toBe("#18181b")
    expect(rackFrameColor({ tint: null, selected: false, hovered: true })).toBe(
      "#3f3f46"
    )
  })
})
