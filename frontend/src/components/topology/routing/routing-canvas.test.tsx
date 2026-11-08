// @vitest-environment jsdom
import { createRef } from "react"
import { act, cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { RoutingTopology } from "@/lib/api"
import { RoutingCanvas } from "./routing-canvas"
import type { RoutingCanvasHandle } from "./routing-canvas"
import { readRoutingDisplay } from "./routing-model"

// The Routing canvas draws its routers and, on a map never arranged, the
// AS boxes Arrange ▸ By AS would - without saving them until the map is
// touched. Its handle hands the arrangement and an export document back.

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

const router = (id: string, asn: number) => ({
  id: `dev:${id}`,
  type: "router" as const,
  data: {
    kind: "device" as const,
    device_id: id,
    vm_id: null,
    name: id,
    role: null,
    status_mini: null,
    site: null,
    site_id: null,
    primary_ip: null,
    router: true,
    router_id: null,
    asns: [{ asn, vrf: null }],
    as_group: asn,
    loopback: null,
    instances: [],
  },
})

const map: RoutingTopology = {
  nodes: [router("r1", 65001), router("r2", 65001)],
  edges: [
    {
      id: "ibgp:dev:r1|dev:r2|",
      source: "dev:r1",
      target: "dev:r2",
      type: "ibgp",
      data: {
        kind: "ibgp",
        vrf: null,
        address_families: ["vpnv4-unicast"],
        a_asn: 65001,
        b_asn: 65001,
        pairs: [],
        sessions: [],
        rr: { reflector: "dev:r1", client: "dev:r2", cluster_id: null },
        one_sided: false,
      },
    },
  ],
  as_groups: [
    {
      id: "as:65001",
      asn: 65001,
      asn_id: null,
      name: "Core",
      nodes: ["dev:r1", "dev:r2"],
    },
  ],
  meta: {
    layers: {
      ebgp: true,
      ibgp: true,
      ospf: true,
      isis: true,
      static: true,
      circuits: true,
      cables: true,
    },
    requested: ["ebgp", "ibgp", "circuits"],
  },
}

describe("RoutingCanvas", () => {
  it("draws the routers in their AS box and saves nothing until touched", async () => {
    const ref = createRef<RoutingCanvasHandle>()
    const onArrange = vi.fn()
    render(
      <div style={{ width: 800, height: 600 }}>
        <RoutingCanvas
          ref={ref}
          map={map}
          settings={readRoutingDisplay(undefined)}
          roleOrder={[]}
          fitKey="k"
          matchedIds={null}
          onArrange={onArrange}
          onZonesChange={vi.fn()}
          onSelectNode={vi.fn()}
          onSelectEdge={vi.fn()}
          onOpenNode={vi.fn()}
          onCanvasClick={vi.fn()}
          onNodeContext={vi.fn()}
          onZoneContext={vi.fn()}
          onEdgeContext={vi.fn()}
          onPaneContext={vi.fn()}
        />
      </div>
    )
    await settle()
    expect(screen.getByText("r1")).toBeTruthy()
    expect(screen.getByText("AS65001 · Core")).toBeTruthy()
    expect(onArrange).not.toHaveBeenCalled()
    const now = ref.current!.arrangement()
    expect(Object.keys(now.positions).sort()).toEqual(["dev:r1", "dev:r2"])
    expect(now.zones.map((z) => z.asn)).toEqual([65001])
    const doc = ref.current!.document({
      area: "all",
      meta: { title: "Routing topology", generated_at: "2026-11-04" },
    })!
    expect(doc.nodes.map((n) => n.id).sort()).toEqual(["dev:r1", "dev:r2"])
    expect(doc.links[0].arrow).toBe("end")
    expect(doc.bands[0].label).toBe("AS65001 · Core")
  })
})
