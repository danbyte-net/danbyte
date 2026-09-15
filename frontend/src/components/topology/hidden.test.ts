import { describe, expect, it } from "vitest"

import type { TopoEdge, TopoNode, TopologyGraph } from "@/lib/api"
import {
  NO_TOPO_HIDDEN,
  applyHidden,
  hiddenOnMap,
  readTopoHidden,
} from "./hidden"

const dev = (id: string, over: Partial<TopoNode["data"]> = {}): TopoNode => ({
  id: `dev:${id}`,
  type: "device",
  data: {
    name: id,
    device_id: id,
    site: "A",
    role: { name: "Access", color: "" },
    ...over,
  },
})
const cable = (a: string, b: string, type = "cat6"): TopoEdge => ({
  id: `e:${a}:${b}`,
  source: `dev:${a}`,
  target: `dev:${b}`,
  type: "cable",
  data: { cable_type: type },
})

const graph: TopologyGraph = {
  nodes: [
    dev("core", { role: { name: "Core", color: "" } }),
    dev("sw1"),
    dev("sw2", { site: "B", location: "Rack 1" }),
    dev("lonely", { site: null, role: null }),
  ],
  edges: [
    cable("core", "sw1"),
    cable("core", "sw2", "smf"),
    { id: "g:1", source: "dev:sw1", target: "dev:sw2", type: "ghost" },
  ],
}

describe("readTopoHidden", () => {
  it("reads the old flat list as removed devices", () => {
    expect(readTopoHidden(["dev:x", 3])).toEqual({
      ...NO_TOPO_HIDDEN,
      devices: ["dev:x"],
    })
  })
  it("tolerates junk and fills missing keys", () => {
    expect(readTopoHidden(null)).toEqual(NO_TOPO_HIDDEN)
    expect(readTopoHidden({ roles: ["Core"], bogus: 1 })).toEqual({
      ...NO_TOPO_HIDDEN,
      roles: ["Core"],
    })
  })
})

describe("applyHidden", () => {
  it("takes a card's cables with it", () => {
    const g = applyHidden(graph, { ...NO_TOPO_HIDDEN, devices: ["dev:core"] })
    expect(g.nodes.map((n) => n.id)).toEqual([
      "dev:sw1",
      "dev:sw2",
      "dev:lonely",
    ])
    expect(g.edges.map((e) => e.id)).toEqual(["g:1"])
  })
  it("hides by site, location and role, with the no-value groups", () => {
    expect(
      applyHidden(graph, { ...NO_TOPO_HIDDEN, sites: ["B"] }).nodes.map(
        (n) => n.id
      )
    ).toEqual(["dev:core", "dev:sw1", "dev:lonely"])
    expect(
      applyHidden(graph, {
        ...NO_TOPO_HIDDEN,
        locations: ["No location"],
      }).nodes.map((n) => n.id)
    ).toEqual(["dev:sw2"])
    expect(
      applyHidden(graph, {
        ...NO_TOPO_HIDDEN,
        roles: ["Access", "No role"],
      }).nodes.map((n) => n.id)
    ).toEqual(["dev:core"])
  })
  it("hides a link family without touching the cards", () => {
    const g = applyHidden(graph, {
      ...NO_TOPO_HIDDEN,
      kinds: ["smf", "Discovered"],
    })
    expect(g.nodes).toHaveLength(4)
    expect(g.edges.map((e) => e.id)).toEqual(["e:core:sw1"])
  })
  it("hides a site aggregate by its site", () => {
    const grouped: TopologyGraph = {
      nodes: [
        {
          id: "grp:1",
          type: "group",
          data: { name: "A", kind: "site" } as never,
        },
        {
          id: "grp:2",
          type: "group",
          data: { name: "B", kind: "site" } as never,
        },
      ],
      edges: [
        { id: "ge:1:2", source: "grp:1", target: "grp:2", type: "group" },
      ],
    }
    const g = applyHidden(grouped, { ...NO_TOPO_HIDDEN, sites: ["B"] })
    expect(g.nodes.map((n) => n.id)).toEqual(["grp:1"])
    expect(g.edges).toEqual([])
  })
})

describe("hiddenOnMap", () => {
  it("counts only what this map has", () => {
    expect(
      hiddenOnMap(graph, {
        ...NO_TOPO_HIDDEN,
        devices: ["dev:elsewhere", "dev:sw1"],
        roles: ["Core"],
      })
    ).toBe(2)
  })
})
