// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react"
import { ReactFlowProvider } from "@xyflow/react"
import type { Edge, NodeProps } from "@xyflow/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { TopologyGraph } from "@/lib/api"
import { TIP_ATTR, TIP_PLAIN_ATTR } from "./canvas-tip"
import { ToolButton } from "./diagram/band-node"
import { GroupNode } from "./group-node"
import type { TopoGroupData } from "./group-node"
import { bgpLabel } from "./overlay-edge"
import { TopologyCanvas, hoverLabel, lineTarget } from "./topology-canvas"
import { ZONE_DRAG_HANDLE, ZoneNode } from "./zone-node"

// The canvas's own furniture: React Flow's controls in sentence case, a BGP
// session named through the one canvas tip (no chip of its own), site cards
// with their roles as badges, and control words as plain tips.

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
if (!("ResizeObserver" in globalThis)) {
  globalThis.ResizeObserver = ResizeObserverStub
}
afterEach(cleanup)

const settle = () =>
  act(async () => {
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0))
  })

describe("zoom controls", () => {
  it("are the toolbars' icon buttons, named in sentence case", async () => {
    const empty: TopologyGraph = { nodes: [], edges: [] }
    render(
      <div style={{ width: 800, height: 600 }}>
        <TopologyCanvas
          graph={empty}
          nodeStyle="diagram"
          onDropDevices={vi.fn()}
        />
      </div>
    )
    await settle()
    const icons = {
      "Zoom in": "lucide-zoom-in",
      "Zoom out": "lucide-zoom-out",
      "Fit view": "lucide-maximize",
    }
    for (const [name, icon] of Object.entries(icons)) {
      const button = screen.getByRole("button", { name })
      expect(button.querySelector(`svg.${icon}`)).not.toBeNull()
      expect(button.className).toContain("size-7")
      expect(button.className).toContain("shadow-none")
    }
    expect(screen.queryByRole("button", { name: "Zoom In" })).toBeNull()
    // React Flow's own Controls are gone; the group keeps their name.
    expect(document.querySelector(".react-flow__controls")).toBeNull()
    expect(screen.getByRole("group", { name: "Map controls" })).toBeTruthy()
  })
})

describe("lineTarget", () => {
  const graph = {
    nodes: [],
    edges: [
      {
        id: "e:c1:a:b",
        source: "dev:a",
        target: "dev:b",
        type: "cable",
        data: { cable_id: "c1" },
      },
      {
        id: "e:c2:a:b",
        source: "dev:a",
        target: "dev:b",
        type: "cable",
        data: { cable_id: "c2" },
      },
      { id: "bgp:a:b:", source: "dev:a", target: "dev:b", type: "bgp" },
    ],
  } as unknown as TopologyGraph

  it("opens a Diagram cable, with its link for the line", () => {
    const edge = {
      id: "e:c1:a:b",
      source: "dev:a",
      target: "dev:b",
      type: "link",
      data: { sem: "cable", pairKey: "a|b", raw: { cable_id: "c1" } },
    } as Edge
    expect(lineTarget(edge, graph)).toEqual({
      sem: "cable",
      edgeIds: ["e:c1:a:b"],
      cableId: "c1",
      link: { pairKey: "a|b" },
    })
  })

  it("hides a bundle's cables, with no one cable to open", () => {
    const edge = {
      id: "f:dev:a>dev:b",
      source: "dev:a",
      target: "dev:b",
      type: "link",
      data: {
        sem: "bundle",
        pairKey: "a|b",
        cables: [{ cable_id: "c1" }, { cable_id: "c2" }],
      },
    } as Edge
    const line = lineTarget(edge, graph)!
    expect(line.edgeIds).toEqual(["e:c1:a:b", "e:c2:a:b"])
    expect(line.cableId).toBeUndefined()
  })

  it("gives a BGP session Hide only, and a trace strand no menu", () => {
    const bgp = {
      id: "bgp:a:b:",
      source: "dev:a",
      target: "dev:b",
      type: "overlay",
      data: { sem: "bgp" },
    } as Edge
    expect(lineTarget(bgp, graph)).toEqual({
      sem: "bgp",
      edgeIds: ["bgp:a:b:"],
    })
    const strand = { ...bgp, id: "t:1", data: { sem: "through" } } as Edge
    expect(lineTarget(strand, graph)).toBeNull()
  })
})

describe("a layout off the canvas", () => {
  it("says it couldn't lay out the map instead of drawing nothing", async () => {
    const graph = {
      nodes: [{ id: "dev:a", type: "device", data: { name: "a" } }],
      edges: [],
    } as unknown as TopologyGraph
    render(
      <div style={{ width: 800, height: 600 }}>
        <TopologyCanvas
          graph={graph}
          nodeStyle="hierarchy"
          positions={{ "dev:a": [0, 3e11] }}
          brokenLayout={<button type="button">Switch to Diagram</button>}
        />
      </div>
    )
    await settle()
    expect(screen.getByText("Couldn't lay out this map.")).toBeTruthy()
    expect(
      screen.getByRole("button", { name: "Switch to Diagram" })
    ).toBeTruthy()
    expect(document.querySelector(".react-flow")).toBeNull()
  })
})

describe("BGP hover", () => {
  it("names the peers, the session kind and the VRF", () => {
    expect(
      bgpLabel({ pairs: [{ a: "r1", b: "r2" }], kind: "ebgp", vrf: "blue" })
    ).toBe("r1 ↔ r2 · eBGP · blue")
    expect(bgpLabel({ kind: "ibgp" })).toBe("BGP · iBGP")
  })

  it("goes through the canvas's hover label like every other line", () => {
    const edge = {
      id: "bgp:1",
      source: "dev:a",
      target: "dev:b",
      type: "overlay",
      data: { sem: "bgp", bgp: { pairs: [{ a: "r1", b: "r2" }] } },
    } as Edge
    expect(hoverLabel(edge)).toBe("r1 ↔ r2")
  })
})

describe("tunnel hover", () => {
  const raw = {
    cable_label: "HQ-VPN",
    tunnel: { id: "t1", name: "HQ-VPN" },
    pairs: [{ a: "fw1:tun0", b: "fw2:tun0" }],
  }
  const edge = (data: Record<string, unknown>) =>
    ({ id: "e", source: "a", target: "b", type: "link", data }) as Edge

  it("names the tunnel and a plain link's two ends", () => {
    expect(hoverLabel(edge({ sem: "cable", raw }))).toBe(
      "HQ-VPN · fw1:tun0 ↔ fw2:tun0"
    )
  })

  it("names only the tunnel on a hub's trunk and legs", () => {
    const leg = { role: "leg", junction: "fan:h" }
    expect(hoverLabel(edge({ sem: "cable", raw, fan: leg }))).toBe("HQ-VPN")
  })
})

function group(over: Partial<TopoGroupData> = {}) {
  return {
    id: "grp:s1",
    data: {
      group_id: "s1",
      kind: "site",
      name: "Aarhus",
      device_count: 12,
      roles: [
        { name: "Leaf", color: "0ea5e9", count: 8 },
        { name: "Spine", color: "6366f1", count: 2 },
        { name: "Firewall", color: "", count: 1 },
        { name: "Server", color: "22c55e", count: 1 },
      ],
      ...over,
    },
    selected: false,
  } as unknown as NodeProps
}

const inFlow = (el: React.ReactNode) => (
  <ReactFlowProvider>{el}</ReactFlowProvider>
)

describe("GroupNode", () => {
  it("shows its biggest roles as badges, never dots", () => {
    const { container } = render(inFlow(<GroupNode {...group()} />))
    expect(container.textContent).toContain("12 devices")
    const badges = [...container.querySelectorAll("[data-slot=badge]")]
    expect(badges.map((b) => b.textContent)).toEqual(["Leaf8", "Spine2"])
    expect(container.textContent).toContain("+2")
    expect(container.querySelector(".rounded-full")).toBeNull()
    // The tip has the full name, as a plain chip.
    const tip = badges[0].closest(`[${TIP_ATTR}]`)!
    expect(tip.getAttribute(TIP_ATTR)).toBe("Leaf · 8")
    expect(tip.hasAttribute(TIP_PLAIN_ATTR)).toBe(true)
    // No how-to tip on the card.
    expect(container.querySelector("[data-tip*='click']")).toBeNull()
  })

  it("counts one device in the singular and draws no role row without roles", () => {
    const { container } = render(
      inFlow(<GroupNode {...group({ device_count: 1, roles: [] })} />)
    )
    expect(container.textContent).toContain("1 device")
    expect(container.textContent).not.toContain("devices")
    expect(container.querySelector("[data-slot=badge]")).toBeNull()
  })
})

describe("control tips", () => {
  it("are plain chips on toolbar buttons, swatches and grips", () => {
    const { container } = render(
      inFlow(
        <>
          <ToolButton label="Rename" icon={<span />} />
          <ZoneNode
            {...({
              id: "zone:z1",
              data: { label: "Closet", color: "#0ea5e9" },
              selected: true,
            } as unknown as NodeProps)}
          />
        </>
      )
    )
    const rename = screen.getAllByRole("button", { name: "Rename" })[0]
    expect(rename.hasAttribute(TIP_PLAIN_ATTR)).toBe(true)
    const grip = container.querySelector(`.${ZONE_DRAG_HANDLE}`)!
    expect(grip.hasAttribute(TIP_PLAIN_ATTR)).toBe(true)
  })
})
