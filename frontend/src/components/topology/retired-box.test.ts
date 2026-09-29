import { describe, expect, it } from "vitest"

import type { TopoNode } from "@/lib/api"
import {
  CENTER_H,
  CENTER_W,
  FLAT_H,
  FLAT_W,
  flatW,
  retiredBox,
  stencilSize,
  statusPillReserve,
} from "./retired-box"

// The boxes the retired Wiring and Flat tabs drew their cards at, which a
// view arranged on them needs once more to carry its arrangement into the
// Diagram (canvas-spread.test.tsx, view-document.test.ts).

const port = (name: string) => ({ name, kind: "interface" as const })

describe("statusPillReserve", () => {
  it("reserves nothing without a status", () => {
    expect(statusPillReserve({})).toBe(0)
    expect(statusPillReserve({ status_mini: null })).toBe(0)
  })

  it("grows with the name and caps a long one", () => {
    const short = statusPillReserve({ status_mini: { name: "Active" } })
    const long = statusPillReserve({
      status_mini: { name: "Decommissioning" },
    })
    const huge = statusPillReserve({ status_mini: { name: "x".repeat(80) } })
    expect(short).toBeGreaterThan(0)
    expect(long).toBeGreaterThan(short)
    expect(huge).toBe(
      statusPillReserve({ status_mini: { name: "y".repeat(60) } })
    )
  })
})

describe("the retired cards' sizes", () => {
  it("widen for a long status", () => {
    const base = { name: "oob-con-01" }
    const withPill = {
      ...base,
      status_mini: {
        id: "s1",
        name: "Decommissioning",
        slug: "decommissioning",
        color: "#f59e0b",
        text_color: "#000000",
      },
    }
    expect(stencilSize(withPill).width).toBeGreaterThan(stencilSize(base).width)
    expect(flatW(withPill)).toBeGreaterThan(flatW(base))
  })

  it("grow a Wiring card along the side its ports sit on", () => {
    const d = { name: "sw", ports: [port("a"), port("b"), port("c")] }
    const left = stencilSize(d)
    const top = stencilSize({ ...d, portSide: { a: "T", b: "T", c: "T" } })
    expect(left.height).toBe(Math.max(CENTER_H, 3 * 16))
    expect(top.height).toBe(CENTER_H + 20)
    expect(top.width).toBeGreaterThanOrEqual(CENTER_W)
  })

  it("slim a dense Wiring card's side columns to a faceplate bar", () => {
    const ports = Array.from({ length: 100 }, (_, i) => port(`Gi1/${i}`))
    const { width, height } = stencilSize({ name: "big", ports })
    expect(height).toBe(100 * 16)
    expect(width).toBeLessThanOrEqual(320)
  })
})

describe("retiredBox", () => {
  const data = {
    name: "leaf-01",
    ports: [port("e1"), port("e2"), port("e3"), port("e4")],
  } as TopoNode["data"]

  it("is a Flat chip's box, sized to the name", () => {
    expect(retiredBox("flat", undefined, "LR")).toEqual({
      w: FLAT_W,
      h: FLAT_H,
    })
    expect(retiredBox("flat", { name: "x".repeat(40) }, "LR").w).toBe(
      flatW({ name: "x".repeat(40) })
    )
  })

  it("splits a Wiring card's ports over the layout axis", () => {
    expect(retiredBox("stencil", undefined, "LR")).toEqual({
      w: CENTER_W,
      h: CENTER_H,
    })
    const lr = retiredBox("stencil", data, "LR")
    const tb = retiredBox("stencil", data, "TB")
    // Two ports a side: left and right, or top and bottom.
    expect(lr.h).toBe(CENTER_H)
    expect(tb.h).toBe(CENTER_H + 2 * 20)
    expect(lr.w).toBeGreaterThan(tb.w)
  })
})
