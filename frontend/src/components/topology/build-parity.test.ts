import { describe, expect, it } from "vitest"
import type { Edge, Node } from "@xyflow/react"

import type { TopologyGraph } from "@/lib/api"
import {
  aliasIds,
  devId,
  fabricGraph,
  groupedGraph,
  miniHiddenPort,
  miniMapGraph,
  miniOrigin,
  traceGraph,
} from "./__fixtures__/fabric-graph"
import { build } from "./topology-canvas"
import type { EdgeColorMode, NodeStyle } from "./topology-canvas"
import { flatHeight, flatWidth } from "./flat-node"
import type { FlatData } from "./flat-node"
import { GROUP_H, GROUP_W } from "./group-node"
import { hierHeight, hierarchyWidth } from "./layout"
import { stencilSize } from "./stencil-node"
import type { StencilData } from "./stencil-node"

// Golden parity for build(): what the Wiring, Hierarchy and Flat views, the
// trace map and the device mini-map hand React Flow - node positions and
// rendered sizes, edge types, handles, styles, labels and routes. Refactors
// of the edge styling, node registry or layout sizing must leave these files
// unchanged; a deliberate change updates them (`npx vitest run -u`) and the
// diff shows exactly what moved.

type Opts = Parameters<typeof build>[1]

/** Numbers to `digits` decimals, and no "-0". Layout coordinates get one
 * decimal; everything else four, which only strips float noise - style
 * values stay exact. */
function num(v: unknown, digits: number): unknown {
  if (typeof v === "number") {
    const f = 10 ** digits
    const r = Math.round(v * f) / f
    return Object.is(r, -0) ? 0 : r
  }
  if (Array.isArray(v)) return v.map((x) => num(x, digits))
  if (v instanceof Set) return [...v].map((x) => num(x, digits))
  if (v instanceof Map)
    return Object.fromEntries(
      [...v].map(([k, x]) => [String(k), num(x, digits)])
    )
  if (v && typeof v === "object")
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .filter(([, x]) => x !== undefined)
        .map(([k, x]) => [k, num(x, digits)])
    )
  return v
}
const coord = (v: unknown) => num(v, 1)
const exact = (v: unknown) => num(v, 4)

/** Node data build() fills with layout coordinates. */
const COORD_DATA = new Set(["portOrder", "portPos", "portSpan"])

/** JSON with sorted keys, so reordering a spread is not a parity diff. */
function canon(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`
  if (v && typeof v === "object")
    return `{${Object.keys(v)
      .sort()
      .map(
        (k) =>
          `${JSON.stringify(k)}:${canon((v as Record<string, unknown>)[k])}`
      )
      .join(",")}}`
  return JSON.stringify(v)
}

/** The size each node renders at (what dagre reserved for it). */
function renderedSize(n: Node): { w: number; h: number } | undefined {
  const d = n.data as StencilData & FlatData & { portSpan?: number }
  switch (n.type) {
    case "device": {
      const s = stencilSize(d)
      return { w: s.width, h: s.height }
    }
    case "flat":
      return { w: flatWidth(d), h: flatHeight(d) }
    case "hier":
      return { w: hierarchyWidth(d), h: hierHeight(d.portSpan ?? 0) }
    case "sitegroup":
      return { w: GROUP_W, h: GROUP_H }
    default:
      return undefined
  }
}

function projectNode(n: Node, input: Map<string, Record<string, unknown>>) {
  const { id, type, position, data: d, selected, ...rest } = n
  const src = input.get(id) ?? {}
  // Payload fields pass through untouched; only what build() computed (or
  // changed) is recorded.
  const computed: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(d)) {
    if (k in src && canon(exact(src[k])) === canon(exact(v))) continue
    computed[k] = COORD_DATA.has(k) ? coord(v) : v
  }
  return {
    type,
    x: coord(position.x),
    y: coord(position.y),
    ...renderedSize(n),
    ...(selected ? { selected } : {}),
    ...rest,
    ...(Object.keys(computed).length ? { data: computed } : {}),
  }
}

function projectEdgeData(data: Record<string, unknown> | undefined) {
  if (!data) return undefined
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(data)) {
    if (k === "raw") {
      const raw = v as { cable_id?: string } | undefined
      out.raw = raw?.cable_id ?? null
    } else if (k === "cables") {
      out.cables = (v as { cable_id?: string }[]).map((c) => c.cable_id)
    } else if (k === "ghost") {
      const g = v as { local_port?: string; remote_port?: string }
      out.ghost = `${g.local_port} ↔ ${g.remote_port}`
    } else if (k === "bgp") {
      const b = v as { kind?: string; sessions?: string[] }
      out.bgp = `${b.kind} ×${b.sessions?.length ?? 0}`
    } else if (k === "waypoints") {
      out.waypoints = coord(v)
    } else out[k] = v
  }
  return out
}

function projectEdge(e: Edge) {
  const rest: Record<string, unknown> = { ...e }
  delete rest.id
  delete rest.data
  return {
    ...rest,
    data: projectEdgeData(e.data),
  }
}

function header(opts: Opts): string {
  const { matched, hiddenPorts, ...plain } = opts
  return `# build(graph, ${canon({
    ...plain,
    ...(matched ? { matched: [...matched].sort() } : {}),
    ...(hiddenPorts ? { hiddenPorts: [...hiddenPorts].sort() } : {}),
  })})`
}

/** `paint` records only each edge's stroke and label - the colour-mode
 * cases, where layout does not change. */
function golden(graph: TopologyGraph, opts: Opts, paint = false) {
  const out = build(graph, opts)
  const input = new Map(
    graph.nodes.map((n) => [n.id, n.data as Record<string, unknown>])
  )
  const lines = [header(opts), ""]
  if (!paint)
    lines.push(
      `nodes ${out.nodes.length}`,
      ...out.nodes.map(
        (n) => `${n.id}  ${canon(exact(projectNode(n, input)))}`
      ),
      ""
    )
  lines.push(
    `edges ${out.edges.length}`,
    ...out.edges.map((e) => {
      const p = paint
        ? { label: e.label, style: e.style, animated: e.animated }
        : projectEdge(e)
      return `${e.id}  ${canon(exact(p))}`
    }),
    ""
  )
  return aliasIds(lines.join("\n"))
}

async function expectGoldenText(name: string, text: () => string) {
  // Deterministic: the same input must build the same output twice.
  const first = text()
  expect(text()).toBe(first)
  await expect(first).toMatchFileSnapshot(
    `./__snapshots__/build-parity/${name}.txt`
  )
}

function expectGolden(name: string, graph: TopologyGraph, opts: Opts) {
  return expectGoldenText(name, () => golden(graph, opts))
}

const STYLES: NodeStyle[] = ["stencil", "hierarchy", "flat"]
const ROUTINGS = ["routed", "straight", "curved"] as const
const COLOR_MODES: EdgeColorMode[] = [
  "cable",
  "type",
  "status",
  "speed",
  "none",
]

describe("build() golden parity", () => {
  describe("fabric", () => {
    for (const nodeStyle of STYLES)
      for (const edgeRouting of ROUTINGS)
        it(`${nodeStyle} · ${edgeRouting}`, async () => {
          await expectGolden(
            `fabric-${nodeStyle}-${edgeRouting}`,
            fabricGraph,
            {
              nodeStyle,
              edgeRouting,
              colorMode: "cable",
            }
          )
        })

    for (const nodeStyle of STYLES)
      it(`${nodeStyle} · tree (TB)`, async () => {
        await expectGolden(`fabric-${nodeStyle}-tb`, fabricGraph, {
          nodeStyle,
          edgeRouting: "routed",
          colorMode: "cable",
          direction: "TB",
        })
      })

    it("stencil · every cable (LAGs unfolded)", async () => {
      await expectGolden("fabric-stencil-unbundled", fabricGraph, {
        nodeStyle: "stencil",
        edgeRouting: "routed",
        colorMode: "cable",
        bundleLags: false,
      })
    })

    it("stencil · role levels", async () => {
      await expectGolden("fabric-stencil-levels", fabricGraph, {
        nodeStyle: "stencil",
        edgeRouting: "routed",
        colorMode: "cable",
        roleOrder: ["Spine", "Leaf", "Firewall", "Server", "Console server"],
        roleBonds: ["Firewall"],
        roleDistance: { Leaf: 3 },
      })
    })

    it("stencil · search dims the misses", async () => {
      await expectGolden("fabric-stencil-matched", fabricGraph, {
        nodeStyle: "stencil",
        edgeRouting: "routed",
        colorMode: "cable",
        matched: new Set([devId("leaf1"), devId("leaf2")]),
      })
    })

    // Edge colour and speed labels per mode, on the two edge builders
    // (per-cable in Wiring/Hierarchy, bundled in Flat).
    for (const nodeStyle of ["stencil", "flat"] as const)
      it(`${nodeStyle} · every colour mode`, async () => {
        await expectGoldenText(`fabric-${nodeStyle}-colors`, () =>
          COLOR_MODES.map((colorMode) =>
            golden(
              fabricGraph,
              { nodeStyle, edgeRouting: "straight", colorMode },
              true
            )
          ).join("\n")
        )
      })
  })

  describe("grouped by site", () => {
    for (const nodeStyle of STYLES)
      for (const edgeRouting of ["routed", "curved"] as const)
        it(`${nodeStyle} · ${edgeRouting}`, async () => {
          await expectGolden(
            `grouped-${nodeStyle}-${edgeRouting}`,
            groupedGraph,
            { nodeStyle, edgeRouting, colorMode: "cable" }
          )
        })
  })

  describe("trace map", () => {
    for (const direction of ["LR", "TB"] as const)
      it(`marked run · ${direction}`, async () => {
        await expectGolden(`trace-${direction.toLowerCase()}`, traceGraph, {
          nodeStyle: "stencil",
          edgeRouting: "routed",
          colorMode: "cable",
          direction,
        })
      })
  })

  describe("device mini-map", () => {
    it("focus and origin", async () => {
      await expectGolden("mini-focus", miniMapGraph, {
        focusNodeId: miniOrigin,
        originId: miniOrigin,
        nodeStyle: "stencil",
        edgeRouting: "routed",
        colorMode: "cable",
      })
    })

    it("an origin port toggled off", async () => {
      await expectGolden("mini-hidden-port", miniMapGraph, {
        focusNodeId: miniOrigin,
        originId: miniOrigin,
        hiddenPorts: new Set([miniHiddenPort]),
        nodeStyle: "stencil",
        edgeRouting: "routed",
        colorMode: "cable",
      })
    })
  })
})
