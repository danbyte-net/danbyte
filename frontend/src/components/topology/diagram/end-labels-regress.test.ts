import { describe, expect, it } from "vitest"

import type { TopologyGraph } from "@/lib/api"
import { approxMeasure } from "@/lib/diagram/measure"
import type { Measure } from "@/lib/diagram/measure"
import fixture from "../__fixtures__/leaf-spine-labels.json"
import { drawn, labelFaults } from "../__fixtures__/route-checks"
import { bandRows } from "./bands"
import type { Region } from "./bands"
import { buildDiagram } from "./build-diagram"
import { withFaces } from "./photo-anchors"
import type { DiagramEdgeData } from "./types"

// A saved view of a leaf/spine fabric (anonymised): Detailed, Photo face
// with ports at the photo's edge (no photos uploaded, so cards), Bendy
// lines, every label on, laid out in band rows. Three neighbouring ports
// on a leaf's top edge go up to the spines; the middle cable runs nearly
// straight while its neighbours curve away. Its end showed the port name
// but no addresses: the subnet chip of a neighbour, placed before the
// addresses, sat across the only 96 px the addresses could slide over.
// Addresses now go before the chips, may take their end's whole half of
// the cable, and drop IPv6 before IPv4 where they do not all fit.

const fx = fixture as unknown as {
  graph: TopologyGraph
  positions: Record<string, [number, number]>
  zones: Region[]
}

function build(measure: Measure = approxMeasure) {
  return buildDiagram(withFaces(fx.graph, "photo", undefined, "edge"), {
    mode: "detailed",
    line: "bendy",
    colorMode: "cable",
    direction: "TB",
    labels: ["subnet", "ip", "port"],
    measure,
    bundleLags: true,
    positions: fx.positions,
    rows: bandRows(fx.zones),
  })
}

/** Each end that asked for labels and did not get them all: the cable as
 * `a>b`, the end, and what it shows of what it asked. */
function shortfalls(b: ReturnType<typeof build>): string[] {
  const out: string[] = []
  const name = (id: string) => id.replace(/^dev:/, "")
  for (const e of b.edges) {
    const d = e.data as DiagramEdgeData | undefined
    if (e.type !== "link" || !d?.plan) continue
    d.plan.forEach((p, i) => {
      for (const end of ["a", "b"] as const) {
        const who = `${name(e.source)}>${name(e.target)}:${end}`
        if (end in p && !p[end]) out.push(`${who} no port name`)
        const want = d.labels.ends?.[i]?.[end]?.length ?? 0
        const got = p.ips?.[end]?.length ?? 0
        if (got < want) out.push(`${who} ${got}/${want} addresses`)
      }
    })
  }
  return out.sort()
}

const fabric = (id: string) => /^dev:(spine|leaf)-/.test(id)

describe("end labels on a leaf/spine fabric", () => {
  // Widths as the app font measures them and a tenth wider: the owner's
  // screen dropped the middle cable's addresses at the wider one.
  for (const scale of [1, 1.1])
    it(`every leaf/spine cable end shows its port name and an address (×${scale})`, () => {
      const b = build((t, s, w) => approxMeasure(t, s, w) * scale)
      let ends = 0
      for (const e of b.edges) {
        const d = e.data as DiagramEdgeData | undefined
        if (e.type !== "link" || !d?.plan) continue
        if (!fabric(e.source) || !fabric(e.target)) continue
        d.plan.forEach((p, i) => {
          for (const end of ["a", "b"] as const) {
            const want = d.labels.ends?.[i]?.[end] ?? []
            if (!want.length) continue
            ends++
            const who = `${e.source}>${e.target}:${end}`
            expect(p[end], who).toBeTruthy()
            // The one end with truly no room: a neighbour's cable runs
            // along its whole half.
            if (who === "dev:spine-2>dev:leaf-3b:b") continue
            expect(p.ips?.[end]?.length ?? 0, who).toBeGreaterThan(0)
          }
        })
      }
      expect(ends).toBe(60)
    })

  it("the middle cable of three keeps both its addresses at both ends", () => {
    for (const scale of [1, 1.1]) {
      const b = build((t, s, w) => approxMeasure(t, s, w) * scale)
      const e = b.edges.find(
        (x) => x.source === "dev:spine-2" && x.target === "dev:leaf-3a"
      )!
      const p = (e.data as DiagramEdgeData).plan![0]
      expect(p.ips?.a?.length, `×${scale}`).toBe(2)
      expect(p.ips?.b?.length, `×${scale}`).toBe(2)
    }
  })

  it("lists every end that still shows less than it asked for", () => {
    // Short cables with both ends labelled (spine to border, the provider
    // pairs, spine-2 to leaf-3b out of its row): the port name and IPv4
    // fit in an end's half, the IPv6 does not. spine-2>leaf-4a's spine
    // end: its neighbours run along the rest. spine-2>leaf-3b's leaf end:
    // the spine-2>leaf-4b cable runs along its whole half.
    expect(shortfalls(build())).toEqual([
      "isp-pe-1>isp-p-2:a 1/2 addresses",
      "mpls-pe-1>mpls-p-1:a 1/2 addresses",
      "mpls-pe-2>mpls-p-2:a 1/2 addresses",
      "spine-1>border-1:a 1/2 addresses",
      "spine-1>border-1:b 1/2 addresses",
      "spine-2>leaf-3b:a 1/2 addresses",
      "spine-2>leaf-3b:b 0/2 addresses",
      "spine-2>leaf-4a:a 1/2 addresses",
      "spine-3>border-2:a 1/2 addresses",
      "spine-3>border-2:b 1/2 addresses",
    ])
  })

  it("places nothing over anything else", () => {
    const b = build()
    expect(labelFaults(drawn(b.nodes, b.edges, approxMeasure))).toEqual([])
  })
})
