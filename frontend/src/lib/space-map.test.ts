import { describe, expect, it } from "vitest"

import type { SpaceMapCell } from "@/lib/api"
import {
  cellActions,
  cellNote,
  formatUsed,
  blockAt,
  isDescendable,
  outerLevels,
  parseOutView,
  parseZoomPath,
  runAt,
  supernetOf,
  zoomParam,
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
    range_count: 0,
    ranges: [],
    range_spans: [],
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
  used_spans: [[0, 0.25, 1]],
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
  used_spans: [[0, 1, 1]],
  prefix_id: "p28",
})
const covered = cell({
  cidr: "10.196.200.64/26",
  state: "full",
  used: true,
  overlap_with: ["10.196.200.0/24"],
  overlap_count: 1,
  used_fraction: 1,
  used_spans: [[0, 1, 1]],
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
      used_spans: [[0.25, 0.25390625, 1]],
      prefix_id: "v6",
    })
    expect(cellActions(v6)).toEqual([
      { kind: "zoom", cidr: "2001:db8:0:100::/56" },
    ])
  })
})

describe("parseZoomPath", () => {
  const root = "10.196.192.0/18"

  it("reads a path of nested blocks", () => {
    expect(parseZoomPath("10.196.224.0/19,10.196.238.128/26", root)).toEqual([
      "10.196.224.0/19",
      "10.196.238.128/26",
    ])
    expect(zoomParam(["10.196.224.0/19", "10.196.238.128/26"])).toBe(
      "10.196.224.0/19,10.196.238.128/26"
    )
    expect(zoomParam([])).toBeUndefined()
  })

  it("cuts the path at the first block that isn't inside the one before", () => {
    expect(parseZoomPath("10.196.238.128/26,10.0.0.0/28", root)).toEqual([
      "10.196.238.128/26",
    ])
    expect(parseZoomPath("10.0.0.0/24", root)).toEqual([])
    expect(parseZoomPath("10.196.192.0/18", root)).toEqual([])
    expect(parseZoomPath("2001:db8::/64", root)).toEqual([])
    expect(parseZoomPath("10.196.238.128/40", root)).toEqual([])
    expect(parseZoomPath("10.196.238.128/31", root)).toEqual([])
    expect(parseZoomPath("junk", root)).toEqual([])
    expect(parseZoomPath(undefined, root)).toEqual([])
    expect(parseZoomPath(42, root)).toEqual([])
  })

  it("reads IPv6 paths", () => {
    expect(
      parseZoomPath("2001:db8:0:100::/56,2001:db8:0:140::/64", "2001:db8::/48")
    ).toEqual(["2001:db8:0:100::/56", "2001:db8:0:140::/64"])
  })
})

describe("cellActions permissions", () => {
  it("drops the create actions the user may not use", () => {
    const free = cell({ cidr: "10.196.238.192/26" })
    expect(cellActions(free, { allowPrefix: false, allowIp: false })).toEqual([
      { kind: "zoom", cidr: "10.196.238.192/26" },
    ])
    expect(
      cellActions(free, { allowPrefix: false }).map((a) => a.kind)
    ).toEqual(["zoom", "new-ip"])
    expect(
      cellActions(cell({ cidr: "10.0.0.0/31" }), {
        allowPrefix: false,
        allowIp: false,
      })
    ).toEqual([])
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

  it("names the IP ranges in a block", () => {
    const pool = { range_count: 1, ranges: ["10.196.196.10–50"] }
    expect(cellNote(cell({ cidr: "10.196.196.0/26", ...pool }))).toBe(
      "Free · range 10.196.196.10–50"
    )
    expect(
      cellNote(
        cell({ cidr: "10.196.196.0/26", dirty: true, ip_count: 1, ...pool })
      )
    ).toBe("Free · 1 IP inside · range 10.196.196.10–50")
    expect(
      cellNote({ ...partial26, range_count: 4, ranges: ["a", "b", "c"] })
    ).toBe("25% used · 10.196.238.128/28 · 4 ranges")
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

describe("zooming out of a prefix", () => {
  it("takes the block one bit up, or any size up to its master", () => {
    expect(supernetOf("10.196.238.128/28", 27)).toBe("10.196.238.128/27")
    expect(supernetOf("10.196.238.128/28", 26)).toBe("10.196.238.128/26")
    expect(supernetOf("10.196.238.128/28", 24)).toBe("10.196.238.0/24")
    expect(supernetOf("2001:db8:0:ff00::/56", 48)).toBe("2001:db8::/48")
    expect(supernetOf("10.0.0.0/24", 24)).toBeNull()
    expect(outerLevels("10.196.238.128/28", "10.196.192.0/18")).toEqual([
      "10.196.192.0/18",
      "10.196.224.0/19",
      "10.196.224.0/20",
      "10.196.232.0/21",
      "10.196.236.0/22",
      "10.196.238.0/23",
      "10.196.238.0/24",
      "10.196.238.128/25",
      "10.196.238.128/26",
      "10.196.238.128/27",
      "10.196.238.128/28",
    ])
    expect(outerLevels("10.0.0.0/24", "192.168.0.0/16")).toEqual([])
  })

  it("keeps an ?out= view only when it holds the prefix inside its master", () => {
    const at = (raw: unknown) =>
      parseOutView(raw, "10.196.238.128/28", "10.196.192.0/18")
    expect(at("10.196.238.0/24")).toBe("10.196.238.0/24")
    expect(at("10.196.192.0/18")).toBe("10.196.192.0/18")
    expect(at("10.196.238.128/28")).toBeNull()
    expect(at("10.196.0.0/16")).toBeNull()
    expect(at("10.196.239.0/24")).toBeNull()
    expect(
      parseOutView("10.196.238.0/24", "10.196.238.128/28", null)
    ).toBeNull()
  })
})

describe("deep rows", () => {
  it("names the block at an index and finds its run", () => {
    expect(blockAt("10.0.0.0/16", 31, 0)).toBe("10.0.0.0/31")
    expect(blockAt("10.0.0.0/16", 31, 515)).toBe("10.0.4.6/31")
    expect(blockAt("10.0.0.0/16", 25, 511)).toBe("10.0.255.128/25")
    expect(blockAt("2001:db8::/48", 60, 1)).toBe("2001:db8:0:10::/60")
    const runs: [number, number, string][] = [
      [0, 9, "free"],
      [10, 10, "full"],
      [11, 511, "free"],
    ]
    expect(runAt(runs, 10)?.[2]).toBe("full")
    expect(runAt(runs, 300)?.[0]).toBe(11)
    expect(runAt(runs, 600)).toBeNull()
  })
})
