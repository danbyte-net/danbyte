import { describe, expect, it } from "vitest"

import type { Prefix } from "@/lib/api"
import { annotateNesting } from "@/lib/prefix-tree"
import {
  blocksByParent,
  carveSizes,
  freeSizeLabel,
  isFreeRow,
  layoutFreeRows,
  parseSize,
  scopeError,
  withLength
  
} from "@/lib/prefix-free"
import type {FreeBlock} from "@/lib/prefix-free";

const pfx = (id: string, cidr: string, vrf: string | null = null) =>
  ({
    id,
    cidr,
    family: cidr.includes(":") ? 6 : 4,
    vrf: vrf ? { id: vrf, name: vrf } : null,
    site: null,
    tags: [],
  }) as unknown as Prefix

const free = (parent: string, cidr: string): FreeBlock => ({
  kind: "free",
  cidr,
  prefixlen: Number(cidr.split("/")[1]),
  family: cidr.includes(":") ? 6 : 4,
  parent,
  vrf: null,
})

const label = (r: { cidr: string; _free?: { kind: string } }) =>
  r._free ? `${r._free.kind === "more" ? "more" : "free"} ${r.cidr}` : r.cidr

describe("layoutFreeRows", () => {
  const rows = annotateNesting([
    pfx("root", "10.20.0.0/16"),
    pfx("a", "10.20.0.0/24"),
    pfx("b", "10.20.1.0/24"),
    pfx("c", "10.20.4.0/22"),
  ])
  const blocks = blocksByParent([
    free("root", "10.20.2.0/23"),
    free("root", "10.20.8.0/21"),
    free("root", "10.20.16.0/20"),
  ])
  const base = {
    blocks,
    totals: { root: 6 },
    expanded: new Set<string>(),
    collapsed: 8,
    sized: false,
    nextOnly: false,
  }

  it("lays free blocks between the children in address order", () => {
    const out = layoutFreeRows(rows, base)
    expect(out.map(label)).toEqual([
      "10.20.0.0/16",
      "10.20.0.0/24",
      "10.20.1.0/24",
      "free 10.20.2.0/23",
      "10.20.4.0/22",
      "free 10.20.8.0/21",
      "free 10.20.16.0/20",
      "more 10.20.0.0/16",
    ])
    const freeRow = out[3]
    expect(isFreeRow(freeRow)).toBe(true)
    expect(freeRow._depth).toBe(1)
    expect(freeRow.id).not.toBe("root")
    expect(out[7]._free?.more).toBe(3)
  })

  it("collapses to the first N and expands", () => {
    const out = layoutFreeRows(rows, { ...base, collapsed: 1 })
    expect(out.filter(isFreeRow).map(label)).toEqual([
      "free 10.20.2.0/23",
      "more 10.20.0.0/16",
    ])
    expect(out.at(-1)?._free?.more).toBe(5)
    expect(out.at(-1)?._free?.expandable).toBe(true)
  })

  it("with a size lists only parents with a block, and Next available one", () => {
    const sized = blocksByParent([
      free("root", "10.20.2.0/29"),
      free("root", "10.20.2.8/29"),
    ])
    const out = layoutFreeRows(rows, {
      ...base,
      blocks: sized,
      totals: { root: 320 },
      collapsed: 16,
      sized: true,
    })
    expect(out.map(label)).toEqual([
      "10.20.0.0/16",
      "free 10.20.2.0/29",
      "free 10.20.2.8/29",
      "more 10.20.0.0/16",
    ])
    const next = layoutFreeRows(rows, {
      ...base,
      blocks: sized,
      totals: { root: 320 },
      sized: true,
      nextOnly: true,
    })
    expect(next.map(label)).toEqual(["10.20.0.0/16", "free 10.20.2.0/29"])
    expect(next[1]._free?.next).toBe(true)
  })

  it("Next available takes the lowest block of the first VRF", () => {
    const nested = annotateNesting([
      pfx("big", "10.0.0.0/8"),
      pfx("small", "10.0.0.0/16"),
    ])
    const out = layoutFreeRows(nested, {
      ...base,
      blocks: blocksByParent([
        free("big", "10.1.0.0/29"),
        free("small", "10.0.0.0/29"),
      ]),
      totals: { big: 1, small: 1 },
      sized: true,
      nextOnly: true,
    })
    expect(out.map(label)).toEqual(["10.0.0.0/16", "free 10.0.0.0/29"])
  })
})

describe("helpers", () => {
  it("sizes and labels", () => {
    expect(parseSize("/29")).toBe(29)
    expect(parseSize("29")).toBe(29)
    expect(parseSize("x")).toBeNull()
    expect(freeSizeLabel(23, 4)).toBe("512 addresses")
    expect(freeSizeLabel(32, 4)).toBe("1 address")
    expect(freeSizeLabel(48, 6)).toBe("65,536 /64s")
    expect(scopeError("10.0.0.0/19")).toBeNull()
    expect(scopeError("10.0.0.0")).not.toBeNull()
    expect(carveSizes("10.20.2.0/23").slice(0, 3)).toEqual([23, 24, 25])
    expect(carveSizes("10.20.2.0/23").at(-1)).toBe(32)
    expect(carveSizes("2001:db8::/62")).toContain(64)
    expect(withLength("10.20.2.0/23", 25)).toBe("10.20.2.0/25")
  })

  it("orders siblings by address", () => {
    const out = annotateNesting([
      pfx("r", "10.0.0.0/16"),
      pfx("x", "10.0.10.0/24"),
      pfx("y", "10.0.2.0/24"),
    ])
    expect(out.map((r) => r.cidr)).toEqual([
      "10.0.0.0/16",
      "10.0.2.0/24",
      "10.0.10.0/24",
    ])
  })
})
