import { describe, expect, it } from "vitest"

import type {
  FloorPlanCablePath,
  FloorPlanTile,
  FloorPlanTray,
} from "@/lib/api"

import { cableEndTexts, searchCables, searchPlan } from "./plan-search"
import type { PlanShape } from "./shapes"

// "Find on plan…" finds cables (by label, id, or one end's device and
// port), trays and areas as well as objects, grouped in that order.

const cable = (
  id: string,
  label: string,
  a: [string, string] | "hidden",
  b: [string, string] | "hidden"
): FloorPlanCablePath =>
  ({
    id,
    label,
    color: "",
    type: "",
    a_tiles: ["t1"],
    b_tiles: ["t2"],
    a_points:
      a === "hidden"
        ? [{ device: null, port: null, hidden: true }]
        : [{ device: `d-${a[0]}`, port: a[1], device_name: a[0] }],
    b_points:
      b === "hidden"
        ? [{ device: null, port: null, hidden: true }]
        : [{ device: `d-${b[0]}`, port: b[1], device_name: b[0] }],
    tray_ids: [],
  }) as FloorPlanCablePath

const CABLES = [
  cable("aaaa-1111", "PATCH-01", ["sw1", "Gi1/0/1"], ["srv-a", "eth0"]),
  cable("bbbb-2222", "PATCH-02", ["sw1", "Gi1/0/2"], "hidden"),
  cable("cccc-3333", "UPLINK", ["core1", "Te1/1"], ["sw1", "Te1/0/48"]),
]

const TILES = [
  {
    id: "t1",
    label: "",
    linked: { kind: "device", id: "d-sw1", name: "sw1" },
  },
] as FloorPlanTile[]

const TRAYS = [
  { id: "tr1", name: "Overhead A", kind: "tray", points: [] },
  { id: "tr2", name: "Underfloor", kind: "tray", points: [] },
] as unknown as FloorPlanTray[]

const SHAPES = [
  { id: "a1", kind: "area", label: "Server room", room: null, location: null },
  { id: "l1", kind: "label", text: "Server" },
] as unknown as PlanShape[]

describe("searchCables", () => {
  it("matches a label", () => {
    expect(searchCables(CABLES, "patch-02").map((h) => h.id)).toEqual([
      "bbbb-2222",
    ])
  })

  it("matches an id prefix", () => {
    expect(searchCables(CABLES, "cccc").map((h) => h.id)).toEqual(["cccc-3333"])
  })

  it("matches one end's device and port, in any order", () => {
    const hits = searchCables(CABLES, "sw1 Gi1/0/1")
    expect(hits.map((h) => h.id)).toEqual(["aaaa-1111"])
    expect(hits[0].match).toBe("sw1 Gi1/0/1")
    expect(searchCables(CABLES, "gi1/0/2 SW1").map((h) => h.id)).toEqual([
      "bbbb-2222",
    ])
  })

  it("never matches across the two ends", () => {
    expect(searchCables(CABLES, "sw1 eth0")).toEqual([])
  })

  it("lists labels before ends", () => {
    expect(searchCables(CABLES, "sw1").map((h) => h.id)).toEqual([
      "aaaa-1111",
      "bbbb-2222",
      "cccc-3333",
    ])
    expect(searchCables(CABLES, "uplink")[0].id).toBe("cccc-3333")
  })

  it("leaves a Hidden end out", () => {
    expect(cableEndTexts(CABLES[1])).toEqual(["sw1 Gi1/0/2"])
  })
})

describe("searchPlan", () => {
  const all = { tiles: TILES, cables: CABLES, trays: TRAYS, shapes: SHAPES }

  it("groups objects, cables, trays and areas", () => {
    expect(searchPlan(all, "sw1").map((h) => h.kind)).toEqual([
      "object",
      "cable",
      "cable",
      "cable",
    ])
  })

  it("finds trays by name", () => {
    expect(searchPlan(all, "overhead").map((h) => [h.kind, h.id])).toEqual([
      ["tray", "tr1"],
    ])
  })

  it("finds areas, not labels", () => {
    expect(searchPlan(all, "server").map((h) => [h.kind, h.id])).toEqual([
      ["area", "a1"],
    ])
  })

  it("finds nothing for nothing", () => {
    expect(searchPlan(all, "  ")).toEqual([])
  })
})
