import { describe, expect, it } from "vitest"

import type { SpaceMapCell } from "@/lib/api"
import {
  cellActions,
  cellNote,
  formatUsed,
  isDescendable,
  zoomStep,
} from "@/lib/space-map"

function cell(over: Partial<SpaceMapCell> & { cidr: string }): SpaceMapCell {
  return {
    state: "free",
    used: false,
    exact: false,
    dirty: false,
    ip_count: 0,
    overlap_with: [],
    overlap_count: 0,
    used_fraction: 0,
    used_spans: [],
    ...over,
  }
}

// The owner's case: a /28 taken inside a /26 of a /18.
const partial26 = cell({
  cidr: "10.196.238.128/26",
  state: "partial",
  used: true,
  overlap_with: ["10.196.238.128/28"],
  overlap_count: 1,
  used_fraction: 0.25,
  used_spans: [[0, 0.25]],
  prefix_id: "p28",
})
const exact28 = cell({
  cidr: "10.196.238.128/28",
  state: "full",
  used: true,
  exact: true,
  overlap_with: ["10.196.238.128/28"],
  overlap_count: 1,
  used_fraction: 1,
  used_spans: [[0, 1]],
  prefix_id: "p28",
})
const covered = cell({
  cidr: "10.196.200.64/26",
  state: "full",
  used: true,
  overlap_with: ["10.196.200.0/24"],
  overlap_count: 1,
  used_fraction: 1,
  used_spans: [[0, 1]],
  prefix_id: "p24",
})

describe("isDescendable", () => {
  it("stops IPv4 at /31 and IPv6 at /128", () => {
    expect(isDescendable("10.0.0.0/30")).toBe(true)
    expect(isDescendable("10.0.0.0/31")).toBe(false)
    expect(isDescendable("2001:db8::/127")).toBe(true)
    expect(isDescendable("2001:db8::1/128")).toBe(false)
    expect(isDescendable("junk")).toBe(false)
  })
})

describe("cellActions", () => {
  it("zooms straight into a partly used block", () => {
    expect(cellActions(partial26)).toEqual([
      { kind: "zoom", cidr: "10.196.238.128/26" },
    ])
  })

  it("offers open and zoom on a block that is a prefix", () => {
    expect(cellActions(exact28)).toEqual([
      { kind: "open", prefix: { cidr: "10.196.238.128/28", id: "p28" } },
      { kind: "zoom", cidr: "10.196.238.128/28" },
    ])
  })

  it("opens the enclosing prefix from a block inside it", () => {
    expect(cellActions(covered)[0]).toEqual({
      kind: "open",
      prefix: { cidr: "10.196.200.0/24", id: "p24" },
    })
  })

  it("keeps the free-cell menu", () => {
    expect(
      cellActions(cell({ cidr: "10.196.238.192/26" })).map((a) => a.kind)
    ).toEqual(["zoom", "new-prefix", "new-ip"])
    expect(
      cellActions(cell({ cidr: "10.0.0.0/31" }), { allowIp: false })
    ).toEqual([{ kind: "new-prefix", cidr: "10.0.0.0/31" }])
  })

  it("falls back to opening the child when a partial block can't zoom", () => {
    const tiny = cell({
      cidr: "10.255.0.0/31",
      state: "partial",
      used: true,
      overlap_with: ["10.255.0.1/32"],
      overlap_count: 1,
      used_fraction: 0.5,
      prefix_id: "h1",
    })
    expect(cellActions(tiny)).toEqual([
      { kind: "open", prefix: { cidr: "10.255.0.1/32", id: "h1" } },
    ])
  })

  it("only opens a /31 prefix - there is nothing below it to map", () => {
    const p2p = cell({
      cidr: "10.0.1.0/31",
      state: "full",
      used: true,
      exact: true,
      overlap_with: ["10.0.1.0/31"],
      overlap_count: 1,
      prefix_id: "l1",
    })
    expect(cellActions(p2p).map((a) => a.kind)).toEqual(["open"])
  })

  it("treats IPv6 the same way", () => {
    const v6 = cell({
      cidr: "2001:db8:0:100::/56",
      state: "partial",
      used: true,
      overlap_with: ["2001:db8:0:140::/64"],
      overlap_count: 1,
      used_fraction: 1 / 256,
      used_spans: [[0.25, 0.25390625]],
      prefix_id: "v6",
    })
    expect(cellActions(v6)).toEqual([
      { kind: "zoom", cidr: "2001:db8:0:100::/56" },
    ])
  })
})

describe("zoomStep", () => {
  it("enters the prefix a full cell belongs to", () => {
    expect(zoomStep(covered, undefined)).toEqual({
      cidr: "10.196.200.64/26",
      prefix: { cidr: "10.196.200.0/24", id: "p24" },
    })
  })

  it("keeps the current prefix for a partial or free cell", () => {
    const inside = {
      cidr: "10.196.200.0/24",
      prefix: { cidr: "10.196.200.0/24", id: "p24" },
    }
    expect(zoomStep(partial26, undefined)).toEqual({
      cidr: "10.196.238.128/26",
      prefix: null,
    })
    expect(
      zoomStep(cell({ cidr: "10.196.200.128/25" }), inside).prefix
    ).toEqual(inside.prefix)
  })
})

describe("cellNote", () => {
  it("names what uses the block", () => {
    expect(cellNote(partial26)).toBe("25% used · 10.196.238.128/28")
    expect(cellNote(exact28)).toBe("Existing prefix")
    expect(cellNote(covered)).toBe("In 10.196.200.0/24")
    expect(
      cellNote(cell({ cidr: "10.0.0.0/26", dirty: true, ip_count: 2 }))
    ).toBe("Free · 2 IPs inside")
  })

  it("counts children past the listed three", () => {
    expect(
      cellNote({
        ...partial26,
        overlap_with: ["a/28", "b/28", "c/28"],
        overlap_count: 5,
      })
    ).toBe("25% used · a/28, b/28, c/28 +2")
  })
})

describe("formatUsed", () => {
  it("never rounds a sliver to zero or a near-full block to 100%", () => {
    expect(formatUsed(0.25)).toBe("25%")
    expect(formatUsed(0.001)).toBe("<1%")
    expect(formatUsed(0.999)).toBe(">99%")
    expect(formatUsed(1)).toBe("100%")
  })
})
