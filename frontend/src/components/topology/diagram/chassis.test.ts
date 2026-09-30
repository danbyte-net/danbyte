import { describe, expect, it } from "vitest"
import type { Node } from "@xyflow/react"

import type { TopologyGraph } from "@/lib/api"
import { toDrawio } from "@/lib/diagram/drawio"
import { approxMeasure } from "@/lib/diagram/measure"
import { toSvg } from "@/lib/diagram/svg"
import { aarhusId } from "../__fixtures__/aarhus-graph"
import { aarhusPhotoGraph } from "../__fixtures__/aarhus-photos"
import { devId, fabricGraph } from "../__fixtures__/fabric-graph"
import { buildDiagram, relinkDiagram } from "./build-diagram"
import type { ChassisNodeData, DiagramOptions } from "./build-diagram"
import {
  CHASSIS,
  chassisFrame,
  chassisGeometry,
  chassisOrient,
  chassisSpecs,
  collapseChassis,
  innerSides,
} from "./chassis"
import { withFaces } from "./photo-anchors"
import { toDocument } from "./to-document"
import type { DiagramCardData, DiagramEdgeData, Rect } from "./types"

// A virtual chassis drawn as a stack: grouping, the frame's geometry, and
// the build - members packed round the frame, no cable between them drawn,
// none leaving by a side that faces another member.

const VC = "7a0c3e6d-9f2b-4e5d-a813-6b9c2e5f8a99"

const node = (id: string, name: string, vc?: object) => ({
  id,
  type: "device",
  data: { name, ...(vc ? { vc } : {}) },
})
const member = (position: number | null, master = false) => ({
  id: VC,
  name: "stack-01",
  position,
  master,
})

describe("chassisSpecs", () => {
  const nodes = [
    node("dev:c", "sw-c", member(null)),
    node("dev:b", "sw-b", member(2)),
    node("dev:a", "sw-a", member(1, true)),
    node("dev:x", "core"),
  ]

  it("stacks a chassis with two members on the map, by member number", () => {
    const [s] = chassisSpecs(nodes, { mode: "v" })
    expect(s).toEqual({
      id: `vc:${VC}`,
      vc: { id: VC, name: "stack-01" },
      orient: "v",
      members: ["dev:a", "dev:b", "dev:c"],
    })
  })

  it("draws a chassis apart when the view or its own look says so", () => {
    expect(chassisSpecs(nodes, { mode: "off" })).toEqual([])
    expect(
      chassisSpecs(nodes, { mode: "v", looks: { [VC]: { off: true } } })
    ).toEqual([])
    const [h] = chassisSpecs(nodes, {
      mode: "v",
      looks: { [VC]: { orient: "h" } },
    })
    expect(h.orient).toBe("h")
    expect(chassisSpecs(nodes, undefined)).toEqual([])
  })

  it("stacks one member only when the chassis was placed", () => {
    const one = [node("dev:a", "sw-a", member(1))]
    expect(chassisSpecs(one, { mode: "v" })).toEqual([])
    expect(chassisSpecs(one, { mode: "off", placed: [VC] })).toHaveLength(1)
    expect(chassisOrient(VC, { mode: "off", placed: [VC] })).toBe("v")
    expect(chassisOrient(VC, { mode: "h", placed: [VC] })).toBe("h")
  })
})

describe("chassis geometry", () => {
  const sizes = [
    { w: 100, h: 40 },
    { w: 140, h: 60 },
  ]

  it("stacks top to bottom, left edges lined up, the strip down the left", () => {
    const g = chassisGeometry("v", sizes)
    const { PAD, STRIP, GAP } = CHASSIS
    expect(g.w).toBe(STRIP + 2 * PAD + 140)
    expect(g.h).toBe(2 * PAD + 40 + GAP + 60)
    expect(g.strip).toEqual({ x: 0, y: 0, w: STRIP, h: g.h })
    const left = (i: number) => g.w / 2 + g.offsets[i].x - sizes[i].w / 2
    expect(left(0)).toBe(STRIP + PAD)
    expect(left(1)).toBe(STRIP + PAD)
    const top = (i: number) => g.h / 2 + g.offsets[i].y - sizes[i].h / 2
    expect(top(1) - (top(0) + 40)).toBe(GAP)
  })

  it("stacks left to right, tops lined up, the strip across the top", () => {
    const g = chassisGeometry("h", sizes, [30])
    const { PAD, STRIP } = CHASSIS
    expect(g.w).toBe(2 * PAD + 100 + 30 + 140)
    expect(g.h).toBe(STRIP + 2 * PAD + 60)
    expect(g.strip).toEqual({ x: 0, y: 0, w: g.w, h: STRIP })
    const top = (i: number) => g.h / 2 + g.offsets[i].y - sizes[i].h / 2
    expect(top(0)).toBe(STRIP + PAD)
    expect(top(1)).toBe(STRIP + PAD)
  })

  it("frames members where they stand, and names the sides they share", () => {
    const rects: Rect[] = [
      { x: 0, y: 0, w: 100, h: 40 },
      { x: 0, y: 44, w: 100, h: 40 },
    ]
    const { PAD, STRIP } = CHASSIS
    expect(chassisFrame("v", rects)).toEqual({
      x: -STRIP - PAD,
      y: -PAD,
      w: 100 + STRIP + 2 * PAD,
      h: 84 + 2 * PAD,
    })
    expect([...innerSides("v", 0, 3)]).toEqual(["B"])
    expect([...innerSides("v", 1, 3)].sort()).toEqual(["B", "T"])
    expect([...innerSides("h", 2, 3)]).toEqual(["L"])
    expect(innerSides("h", 0, 1).size).toBe(0)
  })

  it("collapses a stack's members into its frame", () => {
    const boxes = {
      a: { x: 0, y: 0, w: 100, h: 40 },
      b: { x: 0, y: 44, w: 100, h: 40 },
      c: { x: 500, y: 0, w: 80, h: 40 },
    }
    const out = collapseChassis(
      boxes,
      new Map([["vc:1", { orient: "v" as const, members: ["a", "b"] }]])
    )
    expect(Object.keys(out).sort()).toEqual(["c", "vc:1"])
    expect(out["vc:1"]).toEqual(chassisFrame("v", [boxes.a, boxes.b]))
  })
})

describe("a stack on the Diagram", () => {
  // leaf-01 and leaf-02 as one chassis: their peer LAG runs between them.
  const graph: TopologyGraph = {
    ...fabricGraph,
    nodes: fabricGraph.nodes.map((n) =>
      n.id === devId("leaf1") || n.id === devId("leaf2")
        ? {
            ...n,
            data: {
              ...n.data,
              vc: {
                id: VC,
                name: "leaf-vc",
                position: n.id === devId("leaf1") ? 1 : 2,
                master: n.id === devId("leaf1"),
              },
            } as typeof n.data,
          }
        : n
    ),
  }
  const opts = (o: Partial<DiagramOptions> = {}): DiagramOptions => ({
    mode: "detailed",
    line: "straight",
    colorMode: "cable",
    measure: approxMeasure,
    chassis: { mode: "v" },
    ...o,
  })
  const box = (n: Node): Rect => ({
    x: n.position.x - n.width! / 2,
    y: n.position.y - n.height! / 2,
    w: n.width!,
    h: n.height!,
  })
  const frameId = `vc:${VC}`
  const members = [devId("leaf1"), devId("leaf2")]

  function check(nodes: Node[], orient: "v" | "h") {
    const byId = new Map(nodes.map((n) => [n.id, n]))
    const frame = byId.get(frameId)!
    expect(frame.type).toBe("chassis")
    expect((frame.data as ChassisNodeData).members).toEqual(members)
    const [a, b] = members.map((m) => box(byId.get(m)!))
    // Packed in order, a gap apart, inside the frame.
    if (orient === "v") {
      expect(b.y - (a.y + a.h)).toBeCloseTo(CHASSIS.GAP, 5)
      expect(a.x).toBeCloseTo(b.x, 5)
      expect(a.w).toBe(b.w)
    } else {
      expect(b.x - (a.x + a.w)).toBeCloseTo(CHASSIS.GAP, 5)
      expect(a.y).toBeCloseTo(b.y, 5)
      expect(a.h).toBe(b.h)
    }
    const f = box(frame)
    const want = chassisFrame(orient, [a, b])
    for (const k of ["x", "y", "w", "h"] as const)
      expect(f[k]).toBeCloseTo(want[k], 5)
    for (const m of members)
      expect(
        (byId.get(m)!.data as DiagramCardData & { chassis?: string }).chassis
      ).toBe(frameId)
  }

  for (const orient of ["v", "h"] as const)
    for (const mode of ["simple", "detailed"] as const)
      it(`packs its members ${orient} in ${mode}, no cable between them`, () => {
        const { nodes, edges, model } = buildDiagram(
          graph,
          opts({ mode, chassis: { mode: orient } })
        )
        check(nodes, orient)
        expect(model.chassis?.get(frameId)?.inner).toBeGreaterThan(0)
        const between = edges.filter(
          (e) => members.includes(e.source) && members.includes(e.target)
        )
        expect(between.filter((e) => e.type === "link")).toEqual([])
        // Nothing leaves a member by a side facing the other.
        const facing = orient === "v" ? ["B", "T"] : ["R", "L"]
        for (const e of edges) {
          const d = e.data as DiagramEdgeData | undefined
          if (e.type !== "link" || !d) continue
          for (const [end, id] of [
            ["a", e.source],
            ["b", e.target],
          ] as const) {
            const i = members.indexOf(id)
            if (i < 0) continue
            for (const an of d[end])
              if (an.k === "side") expect(an.side).not.toBe(facing[i])
          }
        }
      })

  it("draws the members apart with stacking off", () => {
    const { nodes } = buildDiagram(graph, opts({ chassis: { mode: "off" } }))
    expect(nodes.some((n) => n.id === frameId)).toBe(false)
  })

  it("keeps a saved frame where it was, and packs round it", () => {
    const at: [number, number] = [1500, -400]
    const { nodes } = buildDiagram(
      graph,
      opts({ positions: { [frameId]: at } })
    )
    const frame = nodes.find((n) => n.id === frameId)!
    expect([frame.position.x, frame.position.y]).toEqual(at)
    check(nodes, "v")
  })

  it("stands a stack arranged before it stacked where its members were", () => {
    const positions = {
      [members[0]]: [0, 0] as [number, number],
      [members[1]]: [400, 200] as [number, number],
    }
    const { nodes } = buildDiagram(graph, opts({ positions }))
    const frame = nodes.find((n) => n.id === frameId)!
    expect([frame.position.x, frame.position.y]).toEqual([200, 100])
  })

  it("moves with its frame on a relink, packed again", () => {
    const built = buildDiagram(graph, opts())
    // Only the frame moved: its members follow it.
    const alone = built.nodes.map((n) =>
      n.id === frameId
        ? { ...n, position: { x: n.position.x + 300, y: n.position.y } }
        : n
    )
    const re = relinkDiagram(built.model, alone)
    const after = alone.map((n) => {
      const c = re.moves?.get(n.id)
      const card = re.cards.get(n.id)
      const f = re.frames?.get(n.id)
      return {
        ...n,
        ...(c ? { position: c } : {}),
        ...(card ? { width: card.box.w, height: card.box.h } : {}),
        ...(f ? { width: f.w, height: f.h } : {}),
      }
    })
    check(after, "v")
    const frame = after.find((n) => n.id === frameId)!
    const was = built.nodes.find((n) => n.id === frameId)!
    expect(frame.position).toEqual({
      x: was.position.x + 300,
      y: was.position.y,
    })
    for (const m of members) expect(re.moves?.has(m)).toBe(true)
  })

  it("keeps the stack's members off the sides its row forbids, the stack first", () => {
    const built = buildDiagram(graph, opts({ direction: "TB" }))
    const f = box(built.nodes.find((n) => n.id === frameId)!)
    const rows = [
      { id: "acc", x: f.x - 50, y: f.y - 30, w: f.w + 100, h: f.h + 60 },
    ]
    const re = relinkDiagram({ ...built.model, rows }, built.nodes, {
      exits: { acc: "v" },
    })
    // Top-down stack, row Up and down: the top member takes its uplinks on
    // its top, the bottom member on its bottom; none leaves by a side
    // facing the other member.
    for (const e of re.edges) {
      const d = e.data as DiagramEdgeData | undefined
      if (e.type !== "link" || !d || d.sem === "ghost") continue
      for (const [end, id] of [
        ["a", e.source],
        ["b", e.target],
      ] as const) {
        const i = members.indexOf(id)
        if (i < 0) continue
        for (const an of d[end])
          if (an.k === "side") expect(an.side).not.toBe(i === 0 ? "B" : "T")
      }
    }
  })

  describe("in the exports", () => {
    const doc = (orient: "v" | "h", mode?: "simple" | "detailed") => {
      const built = buildDiagram(graph, opts({ chassis: { mode: orient } }))
      return toDocument(
        built.model,
        { nodes: built.nodes, edges: built.edges },
        [],
        {
          meta: { title: "Stack", generated_at: "2026-09-30T12:00:00Z" },
          measure: approxMeasure,
          origin: "https://danbyte.example",
          ...(mode ? { mode } : {}),
        }
      )
    }

    it("draws the stack as a band round its members, linked to the chassis", () => {
      const d = doc("v")
      const band = d.bands.find((b) => b.kind === "chassis")!
      expect(band).toMatchObject({
        id: frameId,
        orient: "v",
        label: "leaf-vc",
        link: `https://danbyte.example/virtual-chassis/${VC}`,
      })
      const cards = members.map((m) => d.nodes.find((n) => n.id === m)!)
      expect(chassisFrame("v", cards)).toEqual({
        x: band.x,
        y: band.y,
        w: band.w,
        h: band.h,
      })
      expect(band.strip).toEqual({
        x: band.x,
        y: band.y,
        w: CHASSIS.STRIP,
        h: band.h,
      })
    })

    it("packs the stack again for a file in the other mode", () => {
      const d = doc("v", "simple")
      const [a, b] = members.map((m) => d.nodes.find((n) => n.id === m)!)
      expect(b.y - (a.y + a.h)).toBeCloseTo(CHASSIS.GAP, 5)
      expect(a.w).toBe(b.w)
    })

    it("names it up its strip in SVG, a link to the chassis", () => {
      const svg = toSvg(doc("v"), { measure: approxMeasure, links: true })
      expect(svg).toContain(
        `href="https://danbyte.example/virtual-chassis/${VC}"`
      )
      expect(svg).toMatch(/<text[^>]*rotate\(-90[^>]*>leaf-vc<\/text>/)
      const flat = toSvg(doc("h"), { measure: approxMeasure })
      expect(flat).toMatch(/<text(?![^>]*rotate)[^>]*>leaf-vc<\/text>/)
    })

    it("holds its members in a draw.io swimlane, its name down the side", () => {
      const xml = toDrawio([doc("v")], { measure: approxMeasure })
      const cell = new RegExp(
        `<object label="leaf-vc" link="https://danbyte.example/virtual-chassis/${VC}" id="([^"]+)"><mxCell style="([^"]+)"`
      ).exec(xml)!
      expect(cell).not.toBeNull()
      expect(cell[2]).toContain("swimlane")
      expect(cell[2]).toContain("horizontal=0")
      expect(cell[2]).toContain(`startSize=${CHASSIS.STRIP}`)
      for (const m of members) {
        const own = new RegExp(
          `id="${m}"[^>]*>\\s*<mxCell[^>]*parent="([^"]+)"`
        ).exec(xml)
        const direct = new RegExp(
          `<mxCell[^>]*id="${m}"[^>]*parent="([^"]+)"`
        ).exec(xml)
        expect((own ?? direct)?.[1]).toBe(cell[1])
      }
      const across = toDrawio([doc("h")], { measure: approxMeasure })
      expect(across).toMatch(/swimlane;[^"]*startSize=20/)
    })
  })
})

describe("a stack of photos", () => {
  // The Århus access pair as one chassis, drawn as their front photos.
  const sw = [aarhusId("aarhus-sw1"), aarhusId("aarhus-sw2")]
  const graph = withFaces(
    {
      ...aarhusPhotoGraph,
      nodes: aarhusPhotoGraph.nodes.map((n) =>
        sw.includes(n.id)
          ? {
              ...n,
              data: {
                ...n.data,
                vc: {
                  id: VC,
                  name: "aarhus-stack1",
                  position: sw.indexOf(n.id) + 1,
                  master: n.id === sw[0],
                },
              } as typeof n.data,
            }
          : n
      ),
    },
    "photo"
  )
  const build = (orient: "v" | "h", edge: boolean) =>
    buildDiagram(edge ? withFaces(graph, "photo", undefined, "edge") : graph, {
      mode: "detailed",
      line: "elbow",
      colorMode: "cable",
      measure: approxMeasure,
      chassis: { mode: orient },
    })
  const boxes = (nodes: Node[]) =>
    sw.map((id) => {
      const n = nodes.find((x) => x.id === id)!
      return {
        x: n.position.x - n.width! / 2,
        y: n.position.y - n.height! / 2,
        w: n.width!,
        h: n.height!,
      }
    })

  it("keeps a lead channel between photos taking cables on their ports", () => {
    const [a, b] = boxes(build("v", false).nodes)
    expect(a.x).toBeCloseTo(b.x, 5)
    expect(b.y - (a.y + a.h)).toBeGreaterThan(CHASSIS.GAP)
  })

  it("packs photos taking cables at their edge a gap apart", () => {
    const { nodes, model } = build("v", true)
    const [a, b] = boxes(nodes)
    expect(b.y - (a.y + a.h)).toBeCloseTo(CHASSIS.GAP, 5)
    expect(model.chassis?.get(`vc:${VC}`)?.gaps).toEqual([CHASSIS.GAP])
  })

  it("lines photos up by their tops left to right", () => {
    const [a, b] = boxes(build("h", false).nodes)
    expect(a.y).toBeCloseTo(b.y, 5)
    expect(b.x - (a.x + a.w)).toBeCloseTo(CHASSIS.GAP, 5)
  })
})
