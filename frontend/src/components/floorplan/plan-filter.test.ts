import { describe, expect, it } from "vitest"

import type { FloorPlanTile } from "@/lib/api"

import { roomFacts } from "./plan-detail"
import { planRooms } from "./plan-lod"
import {
  NO_FILTER,
  facetOptions,
  filterFactKey,
  filterSearch,
  filterSnapshot,
  matchAreas,
  matchTiles,
  readPlanFilter,
  toggleFacet,
} from "./plan-filter"
import type { PlanFilter } from "./plan-filter"
import type { AreaShape } from "./shapes"

// The plan's filter (plan-filter.ts): what each facet matches, the
// expression, the URL and saved-view round trip, the facets' counts and
// the rooms' facts under a filter.

const AP = { id: "role-ap", name: "AP", color: "#0ea5e9", icon: "wifi" }
const CAM = { id: "role-cam", name: "Camera", color: "#64748b", icon: "cctv" }
const CORE = { id: "role-core", name: "Core", color: "#6366f1", icon: "" }

let n = 0
const tile = (patch: Partial<FloorPlanTile> = {}): FloorPlanTile =>
  ({
    id: `t${++n}`,
    x: 1,
    y: 1,
    width: 1,
    height: 1,
    orientation: 0,
    tile_type: null,
    role_type: null,
    label: "",
    color: "",
    status: "",
    linked: null,
    ...patch,
  }) as FloorPlanTile

const device = (
  role: typeof AP,
  extra: Partial<NonNullable<FloorPlanTile["linked"]>> = {},
  at: Partial<FloorPlanTile> = {}
) =>
  tile({
    ...at,
    linked: {
      kind: "device",
      id: `d${n}`,
      name: `dev-${n}`,
      role,
      type: { id: "dt-u6", name: "U6 Pro" },
      status: { id: "s-act", name: "Active", color: "#22c55e" },
      tags: [{ id: 1, name: "Wi-Fi", slug: "wifi", color: "#0ea5e9" }],
      ...extra,
    },
  })

const office = {
  kind: "area",
  id: "office",
  shape: "rect",
  x: 0,
  y: 0,
  width: 10,
  height: 10,
  rotation: 0,
  points: [],
  room: null,
  location: null,
  area_type: { id: "at-office", name: "Office", color: "#a3e635" },
  label: "Office",
  color: "",
  fill_opacity: 12,
  border: "solid",
  show_name: true,
  z: 0,
  locked: false,
  created_at: "",
  updated_at: "",
} as unknown as AreaShape
const yard = {
  ...office,
  id: "yard",
  x: 20,
  label: "Yard",
  area_type: { id: "at-yard", name: "Yard", color: "#facc15" },
} as unknown as AreaShape

const ap1 = device(AP)
const ap2 = device(AP, { status: { id: "s-pl", name: "Planned", color: "" } })
const cam = device(CAM, { tags: [] }, { x: 21 })
const rack = tile({
  linked: {
    kind: "rack",
    id: "r1",
    name: "R1",
    role: CORE,
    type: { id: "rt", name: "42U" },
    status: null,
    tags: [{ id: 2, name: "Core", slug: "core", color: "" }],
  },
})
const ups = tile({
  tile_type: {
    id: "tt-ups",
    name: "UPS",
    slug: "ups",
    color: "#f97316",
    icon: "",
    default_width: 1,
    default_height: 1,
    is_zone: false,
    has_fov: false,
  },
  status: "planned",
})
const hidden = tile({
  linked: { kind: "device", id: null, name: "Hidden", hidden: true },
})
const tiles = [ap1, ap2, cam, rack, ups, hidden]
const areas = [office, yard]

const on = (facets: PlanFilter["facets"], expr = ""): PlanFilter => ({
  facets,
  expr,
  hide: false,
})
const ids = (f: PlanFilter) => [...(matchTiles(tiles, areas, f) ?? [])].sort()

describe("what the filter keeps", () => {
  it("is off without a facet or an expression", () => {
    expect(matchTiles(tiles, areas, NO_FILTER)).toBeNull()
  })

  it("matches each dimension", () => {
    expect(ids(on({ kind: ["rack"] }))).toEqual([rack.id])
    expect(ids(on({ kind: ["tt:tt-ups"] }))).toEqual([ups.id])
    expect(ids(on({ kind: ["device"] }))).toEqual(
      [ap1.id, ap2.id, cam.id, hidden.id].sort()
    )
    expect(ids(on({ role: [AP.id] }))).toEqual([ap1.id, ap2.id].sort())
    expect(ids(on({ type: ["dt-u6"] }))).toEqual(
      [ap1.id, ap2.id, cam.id].sort()
    )
    expect(ids(on({ status: ["planned"] }))).toEqual([ap2.id, ups.id].sort())
    expect(ids(on({ tag: ["core"] }))).toEqual([rack.id])
    expect(ids(on({ rack_role: [CORE.id] }))).toEqual([rack.id])
    expect(ids(on({ area: ["at-yard"] }))).toEqual([cam.id])
  })

  it("ORs within a facet and ANDs across them", () => {
    expect(ids(on({ role: [AP.id, CAM.id] }))).toHaveLength(3)
    expect(ids(on({ role: [AP.id, CAM.id], area: ["at-office"] }))).toEqual(
      [ap1.id, ap2.id].sort()
    )
  })

  it("names nothing of an object the reader may not view", () => {
    expect(ids(on({ role: [AP.id, CAM.id] }))).not.toContain(hidden.id)
  })

  it("takes the advanced expression over the same fields", () => {
    expect(ids(on({}, "role = AP and status = planned"))).toEqual([ap2.id])
    expect(ids(on({}, "tags ~ wi"))).toEqual([ap1.id, ap2.id].sort())
    // An expression that does not parse filters nothing out.
    expect(ids(on({ kind: ["rack"] }, "role = ("))).toEqual([rack.id])
  })

  it("keeps the areas of the picked type", () => {
    expect(matchAreas(areas, on({ area: ["at-office"] }))).toEqual(
      new Set(["office"])
    )
    expect(matchAreas(areas, on({ role: [AP.id] }))).toBeNull()
  })
})

describe("the filter as data", () => {
  it("round-trips through the URL and a saved view", () => {
    const f: PlanFilter = {
      facets: { role: [AP.id], status: ["active", "planned"] },
      expr: "tags ~ wi",
      hide: true,
    }
    const snap = filterSnapshot(f)
    expect(snap).toEqual({
      role: [AP.id],
      status: ["active", "planned"],
      __expr: "tags ~ wi",
      hide: "1",
    })
    // As the router hands it back (JSON in the URL).
    expect(readPlanFilter(JSON.parse(JSON.stringify(snap)))).toEqual(f)
    expect(filterSearch(NO_FILTER)).toBeUndefined()
  })

  it("leaves out what it does not understand", () => {
    expect(readPlanFilter({ role: [1, "", "x"], nope: ["y"] })).toEqual({
      facets: { role: ["x"] },
      expr: "",
      hide: false,
    })
    expect(readPlanFilter("role=x")).toBe(NO_FILTER)
    expect(readPlanFilter({ hide: "1" })).toBe(NO_FILTER)
  })

  it("ticks and unticks a value", () => {
    const f = toggleFacet(NO_FILTER, "role", AP.id)
    expect(f.facets.role).toEqual([AP.id])
    expect(toggleFacet(f, "role", AP.id).facets.role).toBeUndefined()
  })
})

describe("the facets' options", () => {
  it("counts each value on the plan, most used first", () => {
    const o = facetOptions(tiles, areas)
    expect(o.role.map((x) => [x.label, x.count])).toEqual([
      ["AP", 2],
      ["Camera", 1],
    ])
    expect(o.kind[0]).toMatchObject({ value: "device", count: 4 })
    expect(o.area.map((x) => x.label).sort()).toEqual(["Office", "Yard"])
    expect(o.status.find((x) => x.value === "planned")?.count).toBe(2)
  })
})

describe("the rooms' facts under a filter", () => {
  it("count what the filter picks by: 12 APs", () => {
    const aps = Array.from({ length: 12 }, () => device(AP))
    const f = on({ role: [AP.id] })
    const rooms = planRooms([office])
    const facts = roomFacts(rooms, aps, {
      keyOf: (t) => filterFactKey(t, f),
    })
    expect(facts.get("office")?.text).toBe("12 APs")
    // Without one, they are devices.
    expect(roomFacts(rooms, aps).get("office")?.text).toBe("12 devices")
  })
})
