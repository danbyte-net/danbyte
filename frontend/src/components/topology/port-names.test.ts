import { describe, expect, it } from "vitest"

import type { TopoNode, TopologyGraph } from "@/lib/api"
import { approxMeasure } from "@/lib/diagram/measure"
import { toDrawio } from "@/lib/diagram/drawio"
import { toSvg } from "@/lib/diagram/svg"
import { buildDiagram, PORT_TEXT_MAX_W } from "./diagram/build-diagram"
import type { DiagramOptions } from "./diagram/build-diagram"
import { toDocument } from "./diagram/to-document"
import type { DiagramCardData, DiagramEdgeData } from "./diagram/types"
import {
  devicePortMode,
  portNameModeOf,
  portText,
  portTexts,
  portTip,
} from "./port-names"
import { build } from "./topology-canvas"

// What the map prints a port by (#541): name, label or description, the
// name when the chosen field is empty; a device's own choice over the
// map's. The name stays the port's identity - only the printed text moves.

describe("port texts", () => {
  const p = { name: "Gi1/0/1", label: "P1", description: "Uplink to core" }

  it("prints the chosen field, else the name", () => {
    expect(portText(p, "name")).toBe("Gi1/0/1")
    expect(portText(p, "label")).toBe("P1")
    expect(portText(p, "description")).toBe("Uplink to core")
    expect(portText({ name: "eth0" }, "label")).toBe("eth0")
    expect(portText({ name: "eth0", description: "  " }, "description")).toBe(
      "eth0"
    )
  })

  it("maps only the ports that print something else, rear pairs too", () => {
    const m = portTexts(
      [
        { name: "F1", kind: "front", pair: "R1", description: "Desk 12" },
        { name: "F2", kind: "front", pair_description: "x" },
        { name: "eth0", kind: "interface" },
        {
          name: "F3",
          kind: "front",
          pair: "R3",
          pair_description: "To MDF",
        },
      ],
      "description"
    )
    expect([...m]).toEqual([
      ["F1", "Desk 12"],
      ["R3", "To MDF"],
    ])
    expect(
      portTexts([{ name: "F1", kind: "front", label: "x" }], "name").size
    ).toBe(0)
  })

  it("takes the device's own mode over the map's", () => {
    expect(devicePortMode(undefined, undefined)).toBe("name")
    expect(devicePortMode(undefined, "label")).toBe("label")
    expect(devicePortMode("description", "label")).toBe("description")
    expect(devicePortMode("bogus", "label")).toBe("label")
    expect(portNameModeOf("label")).toBe("label")
    expect(portNameModeOf("alias")).toBeUndefined()
  })

  it("hovers with the name and the whole text", () => {
    expect(portTip("Gi1/0/1", "Uplink to core")).toBe(
      "Gi1/0/1 · Uplink to core"
    )
    expect(portTip("Gi1/0/1", "Gi1/0/1")).toBe("Gi1/0/1")
    expect(portTip("Gi1/0/1")).toBe("Gi1/0/1")
  })
})

function device(
  id: string,
  name: string,
  ports: NonNullable<TopoNode["data"]["ports"]>,
  extra: Partial<TopoNode["data"]> = {}
): TopoNode {
  return {
    id: `dev:${id}`,
    type: "device",
    data: {
      device_id: id,
      name,
      role: { id: "r1", name: "Switch", color: "#0ea5e9" },
      interface_count: 2,
      panel: false,
      ports,
      ...extra,
    },
  }
}

const LONG = "A very long description of what is plugged in at the far end"

function graph(extra: Partial<TopoNode["data"]> = {}): TopologyGraph {
  return {
    nodes: [
      device(
        "a",
        "sw1",
        [
          {
            name: "Gi1/0/1",
            kind: "interface",
            label: "P1",
            description: "Uplink to core",
          },
          { name: "Gi1/0/2", kind: "interface" },
          { name: "Gi1/0/3", kind: "interface", description: LONG },
        ],
        extra
      ),
      device("b", "core1", [
        { name: "Te1/1", kind: "interface" },
        { name: "Te1/2", kind: "interface", description: "To sw1" },
        { name: "Te1/3", kind: "interface" },
      ]),
    ],
    edges: [
      ["Gi1/0/1", "Te1/1", "c1"],
      ["Gi1/0/2", "Te1/2", "c2"],
      ["Gi1/0/3", "Te1/3", "c3"],
    ].map(([a, b, id]) => ({
      id: `e:${id}`,
      source: "dev:a",
      target: "dev:b",
      type: "cable",
      data: {
        cable_id: id,
        pairs: [
          {
            a: `sw1:${a}`,
            b: `core1:${b}`,
            a_port: a,
            b_port: b,
            a_id: `i-${a}`,
            a_kind: "interface",
            b_id: `i-${b}`,
            b_kind: "interface",
          },
        ],
      },
    })),
  }
}

const opts = (o: Partial<DiagramOptions> = {}): DiagramOptions => ({
  mode: "detailed",
  line: "straight",
  colorMode: "cable",
  labels: ["port"],
  measure: approxMeasure,
  ...o,
})

/** Every end's printed text on the Diagram, by its port name. */
function endTexts(g: TopologyGraph, o: Partial<DiagramOptions> = {}) {
  const b = buildDiagram(g, opts(o))
  const out = new Map<string, string | undefined>()
  for (const e of b.edges) {
    const d = e.data as DiagramEdgeData
    for (const a of [...d.a, ...d.b])
      if (a.k === "side" && a.port) out.set(a.port, a.text)
  }
  return { b, out }
}

describe("port names on the Diagram", () => {
  it("prints names by default: no text beside the name", () => {
    const { out } = endTexts(graph())
    expect([...out.values()].every((t) => t === undefined)).toBe(true)
  })

  it("prints the view's field, the name where it is empty", () => {
    const { out } = endTexts(graph(), { portName: "description" })
    expect(out.get("Gi1/0/1")).toBe("Uplink to core")
    expect(out.get("Te1/2")).toBe("To sw1")
    // No description: the name is printed.
    expect(out.get("Gi1/0/2")).toBeUndefined()
    expect(out.get("Te1/1")).toBeUndefined()
  })

  it("cuts long text with an ellipsis", () => {
    const { out } = endTexts(graph(), { portName: "description" })
    const t = out.get("Gi1/0/3")!
    expect(t.endsWith("…")).toBe(true)
    expect(t.length).toBeLessThan(LONG.length)
    expect(approxMeasure(t, 9, 400)).toBeLessThanOrEqual(PORT_TEXT_MAX_W)
  })

  it("takes a device's own choice over the view's", () => {
    const { out } = endTexts(graph({ port_name: "label" }), {
      portName: "description",
    })
    expect(out.get("Gi1/0/1")).toBe("P1")
    // The other device follows the view.
    expect(out.get("Te1/2")).toBe("To sw1")
  })

  it("names the nubs' hover with the name and the whole text", () => {
    const { b } = endTexts(graph(), { portName: "description" })
    const card = b.nodes.find((n) => n.id === "dev:a")!
    const nubs = (card.data as DiagramCardData).diagram.nubs
    const nub = nubs.find((n) => n.port === "Gi1/0/1")!
    expect(nub.text).toBe("Uplink to core")
  })

  it("prints the chosen text in the exports", () => {
    const { b } = endTexts(graph(), { portName: "description" })
    const doc = toDocument(b.model, { nodes: b.nodes, edges: b.edges }, [], {
      meta: { title: "Ports", generated_at: "2026-11-26T12:00:00Z" },
      measure: approxMeasure,
    })
    const texts = doc.links.flatMap((l) =>
      [l.labels.a?.text, l.labels.b?.text].filter(Boolean)
    )
    expect(texts).toContain("Uplink to core")
    expect(texts).toContain("Gi1/0/2")
    expect(texts).not.toContain("Gi1/0/1")
    const svg = toSvg(doc)
    expect(svg).toContain("Uplink to core")
    // A nub keeps the name as its tooltip, beside the text.
    const nubTips = doc.nodes.flatMap((n) => (n.nubs ?? []).map((u) => u.label))
    expect(nubTips).toContain("Gi1/0/1 · Uplink to core")
    expect(toDrawio([doc])).toContain("Uplink to core")
  })
})

describe("port names on the Hierarchy", () => {
  it("gives each card the text its chips print", () => {
    const res = build(graph(), {
      colorMode: "cable",
      portName: "label",
    })
    const a = res.nodes.find((n) => n.id === "dev:a")!
    expect((a.data as { portText?: Record<string, string> }).portText).toEqual({
      "Gi1/0/1": "P1",
    })
    const plain = build(graph(), { colorMode: "cable" })
    expect(
      (
        plain.nodes.find((n) => n.id === "dev:a")!.data as {
          portText?: unknown
        }
      ).portText
    ).toBeUndefined()
  })
})
