// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react"
import { ReactFlowProvider } from "@xyflow/react"
import type { NodeProps } from "@xyflow/react"
import { afterEach, describe, expect, it } from "vitest"

import type { TopologyGraph } from "@/lib/api"
import { toDrawio } from "@/lib/diagram/drawio"
import { approxMeasure } from "@/lib/diagram/measure"
import { toSvg } from "@/lib/diagram/svg"
import type { DiagramDocument } from "@/lib/diagram/types"
import { aarhusId } from "../__fixtures__/aarhus-graph"
import { aarhusPhotoGraph } from "../__fixtures__/aarhus-photos"
import { graphLegend } from "../legend"
import { buildDiagram } from "./build-diagram"
import type { DiagramOptions } from "./build-diagram"
import { CardNode } from "./card-node"
import { PILL } from "./card-layout"
import {
  badgeWidth,
  captionRows,
  photoFace,
  photoShown,
  roleBadge,
  roleColourShown,
  withFaces,
} from "./photo-anchors"
import type { FacedData } from "./photo-anchors"
import { toDocument } from "./to-document"
import type { DiagramCardData } from "./types"

// On the Photo face a device has no card fill, so its role is a badge in
// its caption, after the name and before the other lines, coloured as its
// card would be - unless its card lines were chosen without the role (a
// list set on the device, view, role, tenant or deployment); Danbyte's
// built-in default lines keep it. The legend lists a role only when the
// map draws its colour: on a card, or on a photo's badge.

afterEach(cleanup)

const fwId = aarhusId("aarhus-fw1")

/** The photo map, every device's card lines `fields` - chosen on the view
 * unless `source` says where they came from - its photo face from the
 * view (`face`) or for the firewall alone (`own`). */
function graphWith(
  fields: string[],
  o: {
    face?: "photo" | "card"
    own?: boolean
    source?: "view" | "tenant" | "default"
  } = {}
): TopologyGraph {
  const g: TopologyGraph = {
    ...aarhusPhotoGraph,
    nodes: aarhusPhotoGraph.nodes.map((n) => ({
      ...n,
      data: {
        ...n.data,
        card: {
          fields,
          source: o.source ?? "view",
          values: { serial: "FOC1234" },
        },
      },
    })),
  }
  return withFaces(
    g,
    o.face ?? "photo",
    o.own ? { [fwId.replace(/^dev:/, "")]: { face: "photo" } } : undefined
  )
}

const build = (graph: TopologyGraph, o: Partial<DiagramOptions> = {}) =>
  buildDiagram(graph, {
    mode: "detailed",
    line: "elbow",
    colorMode: "cable",
    measure: approxMeasure,
    ...o,
  })

const exportOf = (graph: TopologyGraph): DiagramDocument => {
  const b = build(graph)
  return toDocument(b.model, { nodes: b.nodes, edges: b.edges }, [], {
    meta: { title: "t", generated_at: "2026-11-04T12:00:00Z" },
    measure: approxMeasure,
  })
}

const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
const inlined = (doc: DiagramDocument): DiagramDocument => ({
  ...doc,
  nodes: doc.nodes.map((n) =>
    n.photo ? { ...n, photo: { ...n.photo, href: PNG } } : n
  ),
})

const fwData = (g: TopologyGraph) =>
  g.nodes.find((n) => n.id === fwId)!.data as FacedData

describe("a role badge in a photo's caption", () => {
  it("shows by default, and on chosen lines only when they list the role", () => {
    const on = fwData(graphWith(["role", "serial"]))
    const badge = { text: on.role!.name, color: on.role!.color }
    expect(roleBadge(on)).toEqual(badge)
    // Danbyte's default lines are no choice: the badge shows.
    for (const fields of [["serial"], ["monitor", "primary_ip", "serial"]])
      expect(
        roleBadge(fwData(graphWith(fields, { source: "default" })))
      ).toEqual(badge)
    // Without card lines in the payload, too.
    const { card: _card, ...bare } = on
    expect(roleBadge(bare)).toEqual(badge)
    // Lines chosen on the view or the tenant without the role: none.
    expect(roleBadge(fwData(graphWith(["serial"])))).toBeNull()
    expect(
      roleBadge(fwData(graphWith(["serial"], { source: "tenant" })))
    ).toBeNull()
    // No role, no badge.
    expect(roleBadge({ ...on, role: null })).toBeNull()
  })

  it("is built for a photo on the default lines out of the box", () => {
    const b = build(graphWith(["monitor", "serial"], { source: "default" }))
    const p = b.model.photos!.get(fwId)!
    expect(p.badge?.text).toBe(fwData(graphWith([])).role!.name)
    expect(p.lines).toEqual(["SN FOC1234"])
  })

  it("sits after the name, before the lines, its width measured whole", () => {
    const d = fwData(graphWith(["role", "serial"]))
    const face = photoFace(d)!
    const badge = roleBadge(d)!.text
    const s = photoShown(
      face,
      [],
      d.name,
      [],
      approxMeasure,
      undefined,
      ["SN FOC1234"],
      false,
      badge
    )
    const cap = s.caption
    expect(cap.badge).toEqual({
      x: cap.x + cap.w + PILL.GAP,
      w: badgeWidth(badge, approxMeasure),
    })
    expect(cap.tail!.x).toBeGreaterThan(cap.badge!.x + cap.badge!.w)
    expect(cap.tail!.text).toBe("· SN FOC1234")
  })

  it("wraps the name sooner rather than cut it or the badge", () => {
    const face = { w: 120 }
    const name = "a-rather-long-hostname"
    const plain = captionRows(face, name, [], approxMeasure)
    const tagged = captionRows(
      face,
      name,
      [],
      approxMeasure,
      "OpenStack compute"
    )
    expect(tagged.join("")).toBe(name)
    expect(tagged.length).toBeGreaterThanOrEqual(plain.length)
    const last = tagged.at(-1)!
    expect(
      approxMeasure(last, 12, 700) +
        PILL.GAP +
        badgeWidth("OpenStack compute", approxMeasure)
    ).toBeLessThanOrEqual(face.w + 1)
  })

  it("is built for a photo, the role line left out of its lines", () => {
    const b = build(graphWith(["role", "serial"]))
    const p = b.model.photos!.get(fwId)!
    expect(p.badge?.text).toBe(fwData(graphWith([])).role!.name)
    expect(p.lines).toEqual(["SN FOC1234"])
    const off = build(graphWith(["serial"])).model.photos!.get(fwId)!
    expect(off.badge).toBeUndefined()
  })

  it("is drawn on screen as the role's colour badge", () => {
    const b = build(graphWith(["role", "serial"]))
    const n = b.nodes.find((x) => x.id === fwId)!
    const props = {
      id: n.id,
      data: n.data as DiagramCardData,
      selected: false,
    } as unknown as NodeProps
    const { container } = render(
      <ReactFlowProvider>
        <CardNode {...props} />
      </ReactFlowProvider>
    )
    const tag = container.querySelector("[data-role-badge] > *") as HTMLElement
    expect(tag.textContent).toBe(fwData(graphWith([])).role!.name)
    expect(tag.style.backgroundColor).not.toBe("")
  })

  it("gets one on a single photo on a card map (a device's own face)", () => {
    const g = graphWith(["role", "serial"], { face: "card", own: true })
    const b = build(g)
    expect([...b.model.photos!.keys()]).toEqual([fwId])
    expect(b.model.photos!.get(fwId)!.badge).toBeDefined()
  })

  it("is drawn in the SVG and the draw.io label", () => {
    const doc = inlined(exportOf(graphWith(["role", "serial"])))
    const fw = doc.nodes.find((n) => n.id === fwId)!
    const role = fwData(graphWith([])).role!
    expect(fw.badge?.text).toBe(role.name)
    expect(fw.badge?.fill).toBe(role.color.toLowerCase())
    expect(fw.place?.badge).toBeDefined()
    const svg = toSvg(doc, { measure: approxMeasure })
    const dom = new DOMParser().parseFromString(svg, "image/svg+xml")
    const t = [...dom.querySelectorAll("text")].find(
      (e) => e.textContent === role.name
    )!
    expect(Number(t.getAttribute("x"))).toBeCloseTo(
      fw.place!.badge!.x + fw.place!.badge!.w / 2,
      1
    )
    const xml = toDrawio([doc], { photos: true, measure: approxMeasure })
    const x = new DOMParser().parseFromString(xml, "application/xml")
    const label = x
      .querySelector(`object[danbyte_id="${fwId}"]`)!
      .getAttribute("label")!
    expect(label).toMatch(
      new RegExp(`^<b>aarhus-fw1</b> <span style="background-color:#`)
    )
    expect(label).toContain(`>${role.name}</span>`)
    expect(label).toContain("· SN FOC1234</span>")
  })

  it("leaves a card map as it was", () => {
    const b = build(graphWith(["role", "serial"], { face: "card" }))
    expect(b.model.photos?.size ?? 0).toBe(0)
  })
})

describe("roles in the legend", () => {
  const names = (g: TopologyGraph) => graphLegend(g).roles.map((r) => r.name)

  it("lists them on a map of photos on the default lines", () => {
    expect(
      names(graphWith(["serial"], { source: "default" })).length
    ).toBeGreaterThan(0)
  })

  it("lists none on a map of photos without role badges", () => {
    const g = graphWith(["serial"])
    // The faceplates are photos too; every device is drawn as its photo.
    expect(g.nodes.every((n) => !roleColourShown(n.data as FacedData))).toBe(
      true
    )
    expect(names(g)).toEqual([])
  })

  it("lists them when the photos wear their role badges", () => {
    expect(names(graphWith(["role", "serial"])).length).toBeGreaterThan(0)
  })

  it("keeps them on a mixed map: the cards show their colour", () => {
    const mixed = graphWith(["serial"], { face: "card", own: true })
    const fwRole = fwData(mixed).role!.name
    const others = mixed.nodes
      .filter((n) => n.id !== fwId)
      .map((n) => n.data.role?.name)
    expect(names(mixed)).toEqual(
      expect.arrayContaining(others.filter((r): r is string => !!r))
    )
    // The firewall's role is listed only when a card carries it too.
    expect(names(mixed).includes(fwRole)).toBe(others.includes(fwRole))
  })
})
