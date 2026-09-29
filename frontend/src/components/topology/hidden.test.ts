import { describe, expect, it } from "vitest"

import type { TopoEdge, TopoNode, TopologyGraph } from "@/lib/api"
import {
  NO_TOPO_HIDDEN,
  applyHidden,
  drawnEdgeIds,
  familyLabel,
  hiddenOnMap,
  linkFamily,
  readTopoHidden,
  savedTopoHidden,
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

describe("single lines", () => {
  it("hide one line and leave its cards and family alone", () => {
    const h = { ...NO_TOPO_HIDDEN, edges: ["e:core:sw1"] }
    const g = applyHidden(graph, h)
    expect(g.edges.map((e) => e.id)).toEqual(["e:core:sw2", "g:1"])
    expect(g.nodes).toHaveLength(4)
    // The chip counts a hidden line like a hidden card, on this map only.
    expect(hiddenOnMap(graph, { ...h, edges: [...h.edges, "e:gone"] })).toBe(1)
  })

  it("save only once one is hidden, so older views keep their shape", () => {
    expect(savedTopoHidden(NO_TOPO_HIDDEN)).not.toHaveProperty("edges")
    const h = { ...NO_TOPO_HIDDEN, edges: ["e:core:sw1"] }
    expect(savedTopoHidden(h)).toEqual(h)
    expect(readTopoHidden(savedTopoHidden(NO_TOPO_HIDDEN))).toEqual(
      NO_TOPO_HIDDEN
    )
  })
})

describe("drawnEdgeIds", () => {
  const withCables = (id: string, a: string, b: string, cab: string) => ({
    id,
    source: `dev:${a}`,
    target: `dev:${b}`,
    type: "cable",
    data: { cable_id: cab },
  })
  const g: TopologyGraph = {
    nodes: [dev("a"), dev("b"), dev("c")],
    edges: [
      withCables("e:c1:a:b", "a", "b", "c1"),
      withCables("e:c2:a:b", "a", "b", "c2"),
      // A breakout: one cable to two devices.
      withCables("e:c3:a:b", "a", "b", "c3"),
      withCables("e:c3:a:c", "a", "c", "c3"),
      { id: "ghost:a:c", source: "dev:a", target: "dev:c", type: "ghost" },
    ],
  }

  it("is the edge itself when the payload has it", () => {
    expect(
      drawnEdgeIds({ id: "ghost:a:c", source: "dev:a", target: "dev:c" }, g)
    ).toEqual(["ghost:a:c"])
  })

  it("is a bundle's cables between its two devices", () => {
    const bundle = {
      id: "f:dev:a>dev:b",
      source: "dev:b",
      target: "dev:a",
      data: { cables: [{ cable_id: "c1" }, { cable_id: "c2" }] },
    }
    expect(drawnEdgeIds(bundle, g)).toEqual(["e:c1:a:b", "e:c2:a:b"])
  })

  it("is the whole cable for any part of a breakout", () => {
    const leg = {
      id: "fan:c3:leg:1",
      source: "fan:c3",
      target: "dev:c",
      data: { cableId: "c3", fan: { role: "leg" } },
    }
    expect(drawnEdgeIds(leg, g)).toEqual(["e:c3:a:b", "e:c3:a:c"])
  })

  it("is nothing for a line that draws no payload edge", () => {
    expect(
      drawnEdgeIds({ id: "m:1", source: "dev:a", target: "p:1" }, g)
    ).toEqual([])
  })
})

describe("familyLabel", () => {
  // The stored keys are what saved views hold in state.hidden.kinds: they
  // stay, and only the words on screen change.
  it("names LLDP and untyped cables for the page, keeping the stored keys", () => {
    const ghost: TopoEdge = { id: "g", source: "a", target: "b", type: "ghost" }
    const bare: TopoEdge = { id: "c", source: "a", target: "b", type: "cable" }
    expect(linkFamily(ghost)).toBe("Discovered")
    expect(linkFamily(bare)).toBe("Untyped")
    expect(familyLabel(linkFamily(ghost)!)).toBe("LLDP")
    expect(familyLabel(linkFamily(bare)!)).toBe("No type")
  })
  it("leaves cable types and BGP sessions as they are", () => {
    expect(familyLabel("smf")).toBe("smf")
    expect(familyLabel("BGP sessions")).toBe("BGP sessions")
  })
})
