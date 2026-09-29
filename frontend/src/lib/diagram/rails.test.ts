// @vitest-environment jsdom
import { describe, expect, it } from "vitest"

import { railMeasure as measure, railModel } from "./__fixtures__/rails"
import { toDrawio } from "./drawio"
import {
  layoutRails,
  RAIL,
  RAIL_PALETTE,
  railPath,
  railRoles,
  railsDocument,
} from "./rails"
import type { RailModel } from "./rails"
import { toSvg } from "./svg"
import { cardTextHeight, NEUTRAL_CARD, PILL } from "./theme"
import type { DiagramDocument, Rect } from "./types"

const lay = (m: RailModel = railModel, width?: number) =>
  layoutRails(m, { measure, width })

const overlap = (a: Rect, b: Rect) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

const META = {
  title: "Logical topology",
  tenant: "Acme",
  generated_at: "2026-09-28T12:00:00Z",
  filters: "Site Aarhus",
}

const doc = (m: RailModel = railModel, drawio = false): DiagramDocument =>
  railsDocument(lay(m), {
    meta: META,
    origin: "https://danbyte.example/",
    drawio,
    measure,
  })

describe("layoutRails", () => {
  it("draws each card once, under its topmost rail, and drops the rest", () => {
    const l = lay()
    expect(l.boxes.map((b) => b.id).sort()).toEqual(
      ["device:d1", "device:d2", "vm:v1"].sort()
    )
    const band = Object.fromEntries(l.boxes.map((b) => [b.id, b.band]))
    expect(band).toEqual({ "device:d1": 0, "vm:v1": 1, "device:d2": 1 })
    // d2's leg to a rail that is not drawn is gone.
    expect(l.legs.filter((g) => g.box === "device:d2")).toHaveLength(1)
    for (const a of l.boxes)
      for (const b of l.boxes)
        if (a !== b) expect(overlap(a, b), `${a.id} ${b.id}`).toBe(false)
  })

  it("stacks the external bar, the title rows and the rails top to bottom", () => {
    const l = lay()
    expect(l.external).toMatchObject({ x: RAIL.PAD, y: RAIL.PAD })
    const [campus, vlans] = l.strips
    expect(campus.title.text).toBe("Campus")
    expect(campus.subtitle.text).toBe("VLAN group")
    expect(campus.firstRail).toBe(0)
    expect(vlans.firstRail).toBe(2)
    expect(campus.y).toBeGreaterThan(l.external!.y + l.external!.h)
    expect(l.rails[0].y).toBeGreaterThan(campus.y + RAIL.STRIP_H - 1)
    expect(vlans.y).toBeGreaterThan(l.rails[1].y)
    // The host NIC sits at the title row's right end.
    const nic = campus.adapters[0]
    expect(nic.x + nic.w).toBe(l.width - RAIL.PAD)
    expect(nic.nic.text).toBe("eno1")
    expect(nic.host.text).toBe("hv-01")
    expect(l.height).toBeGreaterThan(l.rails[2].y + RAIL.H)
  })

  it("colors rails from their data, else a palette shade by position", () => {
    const l = lay()
    expect(l.rails.map((r) => r.fill)).toEqual([
      "#2563eb",
      "#fde68a",
      RAIL_PALETTE[2],
    ])
    // Text that reads on the fill.
    expect(l.rails[0].ink).toBe("#ffffff")
    expect(l.rails[1].ink).toBe("#0a0a0a")
  })

  it("never takes a color from a name", () => {
    const renamed: RailModel = {
      ...railModel,
      sections: railModel.sections.map((s) => ({
        ...s,
        rails: s.rails.map((r) => ({ ...r, label: `x ${r.label} y` })),
      })),
      boxes: railModel.boxes.map((b) => ({
        ...b,
        name: b.name.toUpperCase(),
        role: b.role ? { ...b.role, name: "Renamed" } : b.role,
      })),
    }
    const [a, b] = [lay(), lay(renamed)]
    expect(b.rails.map((r) => r.fill)).toEqual(a.rails.map((r) => r.fill))
    expect(b.boxes.map((x) => x.fill).sort()).toEqual(
      a.boxes.map((x) => x.fill).sort()
    )
  })

  it("fills a card with its role's color, else draws it neutral", () => {
    const by = Object.fromEntries(lay().boxes.map((b) => [b.id, b]))
    expect(by["device:d1"].fill).toBe("#7c3aed")
    expect(by["device:d1"].ink).toBe("#ffffff")
    expect(by["device:d2"].fill).toBeNull()
    expect(by["vm:v1"]).toMatchObject({ fill: null, vm: true })
  })

  it("puts the status pill in the card's top-left corner, with a row kept for it", () => {
    const l = lay()
    expect(l.pillRow).toBe(true)
    expect(l.boxH).toBe(cardTextHeight(0, true))
    const core = l.boxes.find((b) => b.id === "device:d1")!
    expect(core.pill).toMatchObject({
      x: core.x + PILL.X,
      y: core.y + 6,
      text: "Active",
    })
    expect(core.pill!.status.color).toBe("#22c55e")
    // Cards without a status keep the same height.
    expect(new Set(l.boxes.map((b) => b.h))).toEqual(new Set([l.boxH]))
    // A rail's pill sits after its name.
    const mgmt = l.rails[0]
    expect(mgmt.pill).toMatchObject({ text: "Planned" })
    expect(mgmt.pill!.x).toBeGreaterThan(mgmt.labelX + mgmt.labelW)
  })

  it("cuts a long name to fit and keeps it whole for a tip", () => {
    const long = lay().boxes.find((b) => b.id === "device:d2")!
    expect(long.name.full).toBe("a-very-long-access-switch-name")
    expect(long.name.text.endsWith("…")).toBe(true)
    expect(measure(long.name.text, 12, 700)).toBeLessThanOrEqual(
      RAIL.BOX_W - 20
    )
  })

  it("runs a leg per attachment in its rail's color, dashed when tagged", () => {
    const l = lay()
    const legs = l.legs.filter((g) => g.box === "device:d1")
    expect(legs.map((g) => [g.rail, g.dashed, g.up])).toEqual([
      ["v10", false, true],
      ["v10", true, true],
      ["v20", true, false],
      ["v99", true, false],
    ])
    const core = l.boxes.find((b) => b.id === "device:d1")!
    const [mgmt, servers, legacy] = l.rails
    // Up to the rail it hangs under, down to the others.
    expect(legs[0]).toMatchObject({ y1: mgmt.y + mgmt.h, y2: core.y })
    expect(legs[2]).toMatchObject({ y1: core.y + core.h, y2: servers.y })
    expect(legs[3]).toMatchObject({ y2: legacy.y, color: legacy.fill })
    // One lane each, side by side.
    const xs = legs.map((g) => g.x)
    expect(new Set(xs).size).toBe(4)
    expect(xs[1] - xs[0]).toBe(RAIL.LANE)
  })

  it("labels one card's legs to one rail once, each name its own link", () => {
    const l = lay()
    const mgmt = l.labels.find((x) => x.key === "device:d1|r0")!
    expect(mgmt.text).toBe("mgmt0, Eth1/1")
    expect(mgmt.parts).toEqual([
      { text: "mgmt0", target: { kind: "interface", id: "i1" } },
      { text: "Eth1/1", target: { kind: "interface", id: "i2" } },
    ])
    // Between the rail and the card, just right of the legs up to it; a
    // label further down clears every leg down.
    const core = l.boxes.find((b) => b.id === "device:d1")!
    const legs = l.legs.filter((g) => g.box === "device:d1")
    const up = legs.filter((g) => g.up).map((g) => g.x)
    const down = legs.filter((g) => !g.up).map((g) => g.x)
    expect(mgmt.x).toBeGreaterThan(Math.max(...up))
    expect(mgmt.x).toBeLessThan(Math.max(...up) + RAIL.LANE)
    const servers = l.labels.find((x) => x.key === "device:d1|r1")!
    expect(servers.x).toBeGreaterThan(Math.max(...down))
    expect(mgmt.y + mgmt.h).toBeLessThanOrEqual(core.y)
    expect(mgmt.y).toBeGreaterThanOrEqual(l.rails[0].y + RAIL.H)
    // No two labels overlap.
    for (const a of l.labels)
      for (const b of l.labels)
        if (a !== b) expect(overlap(a, b), `${a.key} ${b.key}`).toBe(false)
  })

  it("keeps a label clear of the next card's legs: +N, else cut short", () => {
    const m: RailModel = {
      sections: [{ id: "s", rails: [{ id: "r", label: "r" }] }],
      boxes: [
        {
          id: "a",
          name: "a",
          legs: ["Ethernet1/1", "Ethernet1/2", "Ethernet1/3"].map((label) => ({
            rail: "r",
            label,
          })),
        },
        {
          id: "b",
          name: "b",
          legs: [
            {
              rail: "r",
              label: "an-interface-name-far-too-long-for-its-place",
              target: { kind: "interface", id: "ib" },
            },
          ],
        },
        { id: "c", name: "c", legs: [{ rail: "r" }] },
      ],
    }
    const l = lay(m)
    const a = l.labels.find((x) => x.box === "a")!
    expect(a).toMatchObject({
      text: "Ethernet1/1, Ethernet1/2 +1",
      more: 1,
      clipped: false,
      full: "Ethernet1/1, Ethernet1/2, Ethernet1/3",
    })
    const b = l.labels.find((x) => x.box === "b")!
    expect(b.clipped).toBe(true)
    expect(b.text.endsWith("…")).toBe(true)
    expect(b.target).toEqual({ kind: "interface", id: "ib" })
    const c = l.legs.find((g) => g.box === "c")!
    expect(b.x + b.w).toBeLessThan(c.x)
  })

  it("fills the width it is given and grows past it for its columns", () => {
    const bare: RailModel = {
      sections: [{ id: "s", rails: [{ id: "r", label: "r" }] }],
      boxes: [],
    }
    expect(lay(bare).width).toBe(RAIL.MIN_W)
    // Three columns: the core card holds the first in every band it spans.
    const pitch = RAIL.BOX_W + RAIL.BOX_GAP
    expect(lay().width).toBe(2 * RAIL.PAD + RAIL.RESERVE + 3.5 * pitch)
    expect(lay(railModel, 1400).width).toBe(1400)
    expect(lay(railModel, 1400).rails[0].w).toBe(1400 - 2 * RAIL.PAD)
    const wide: RailModel = {
      sections: [{ id: "s", rails: [{ id: "r", label: "r" }] }],
      boxes: Array.from({ length: 12 }, (_, i) => ({
        id: `b${i}`,
        name: `b${String(i).padStart(2, "0")}`,
        legs: [{ rail: "r" }],
      })),
    }
    const l = lay(wide, 800)
    expect(l.width).toBeGreaterThan(800)
    const right = Math.max(...l.boxes.map((b) => b.x + b.w))
    expect(right).toBeLessThanOrEqual(l.width - RAIL.PAD)
  })

  it("lists the roles on the cards once each, in order", () => {
    expect(railRoles(railModel)).toEqual([
      { name: "Core", color: "#7c3aed" },
      { name: "Access", color: undefined },
    ])
  })
})

describe("railsDocument", () => {
  it("draws rails, cards and host NICs as cards and legs as lines", () => {
    const d = doc()
    const ids = [
      ...d.nodes.map((n) => n.id),
      ...d.links.map((l) => l.id),
      ...d.notes.map((n) => n.id),
    ]
    expect(new Set(ids).size).toBe(ids.length)
    const nodes = new Map(d.nodes.map((n) => [n.id, n]))
    for (const l of d.links) {
      expect(nodes.has(l.source.node), l.id).toBe(true)
      expect(nodes.has(l.target.node), l.id).toBe(true)
      expect(l.kind).toBe("straight")
    }
    expect(d.nodes.filter((n) => n.id.startsWith("rail:"))).toHaveLength(3)
    expect(d.nodes.filter((n) => n.id.startsWith("box:"))).toHaveLength(3)
    expect(nodes.get("adp:a1")).toMatchObject({
      title: "eno1",
      lines: ["hv-01"],
      link: "https://danbyte.example/interfaces/if-a1",
    })
    expect(nodes.get("ext")?.title).toBe("External network")
    expect(d.notes.map((n) => n.text)).toEqual(["Campus · VLAN group", "VLANs"])
    expect(d.meta).toMatchObject({ ...META, mode: "simple" })
    expect(d.bounds.w).toBeGreaterThan(0)
  })

  it("colors from the data: rails, cards and pills", () => {
    const nodes = new Map(doc().nodes.map((n) => [n.id, n]))
    expect(nodes.get("rail:v10")).toMatchObject({
      fill: "#2563eb",
      ink: "#ffffff",
      title: "MGMT · VLAN 10",
      pill: { kind: "status", text: "Planned", fill: "#f59e0b" },
      link: "https://danbyte.example/vlans/v10",
    })
    expect(nodes.get("box:device:d1")).toMatchObject({
      fill: "#7c3aed",
      pill: { text: "Active", fill: "#22c55e", ink: "#0a0a0a" },
      link: "https://danbyte.example/devices/d1",
    })
    expect(nodes.get("box:vm:v1")).toMatchObject({
      fill: NEUTRAL_CARD.fill,
      ink: NEUTRAL_CARD.ink,
      link: "https://danbyte.example/virtual-machines/v1",
    })
    // The rail's name sits where the screen puts it, from the left.
    const mgmt = lay().rails[0]
    expect(nodes.get("rail:v10")!.place!.title.x).toBe(
      mgmt.labelX + mgmt.labelW / 2
    )
  })

  it("strokes each leg in its rail's color, dashed when tagged, labelled at its card", () => {
    const d = doc()
    const legs = d.links.filter((l) => l.source.node === "box:device:d1")
    expect(legs.map((l) => [l.target.node, l.stroke, l.dash])).toEqual([
      ["rail:v10", "#2563eb", undefined],
      ["rail:v10", "#2563eb", RAIL.DASH],
      ["rail:v20", "#fde68a", RAIL.DASH],
      ["rail:v99", RAIL_PALETTE[2], RAIL.DASH],
    ])
    expect(legs[0].source.side).toBe("top")
    expect(legs[2].source.side).toBe("bottom")
    expect(legs[0].labels.a?.text).toBe("mgmt0, Eth1/1")
    expect(legs[1].labels.a).toBeUndefined()
    expect(legs[0].link).toBe("https://danbyte.example/interfaces/i1")
  })

  it("keeps only the visible area, rails cut to it", () => {
    const l = lay(railModel, 1200)
    const r = l.rails[1]
    const area = { x: 300, y: r.y - 4, w: 400, h: r.h + 8 }
    const d = railsDocument(l, { meta: META, area, measure })
    expect(d.nodes.map((n) => n.id)).toEqual(["rail:v20"])
    expect(d.nodes[0]).toMatchObject({ x: 300, w: 400 })
    // Its name moves in with the cut.
    expect(d.nodes[0].place!.title.x).toBeGreaterThan(300)
    expect(d.links).toEqual([])
  })

  it("links each target to its page", () => {
    expect(railPath({ kind: "vswitch", id: "a/b" })).toBe(
      "/virtual-switches/a%2Fb"
    )
  })

  it("writes the same SVG every time (golden)", async () => {
    const d = doc()
    d.meta.legend = [
      { kind: "role", label: "Core", fill: "#7c3aed", ink: "#ffffff" },
      { kind: "line", label: "VLAN", stroke: "#71717b", width: 8 },
      {
        kind: "line",
        label: "Tagged",
        stroke: "#71717b",
        width: 3,
        dash: "5 5",
      },
    ]
    const opts = { measure, titleBlock: true, legend: true, links: true }
    const out = toSvg(d, opts)
    expect(toSvg(structuredClone(d), opts)).toBe(out)
    await expect(out).toMatchFileSnapshot("./__golden__/rails.svg")
  })

  it("puts a rail's pill beside its name where draw.io centres it", () => {
    const rail = (d: DiagramDocument) =>
      d.nodes.find((n) => n.id === "rail:v10")!
    const mgmt = lay().rails[0]
    const shown = rail(doc())
    const file = rail(doc(railModel, true))
    expect(file.place!.title.x).toBe(shown.x + shown.w / 2)
    expect(file.place!.pill!.x).toBe(
      file.place!.title.x + mgmt.labelW / 2 + RAIL.PILL_GAP
    )
    // Everything else is where the screen puts it.
    expect({ ...file, place: undefined }).toEqual({
      ...shown,
      place: undefined,
    })
  })

  it("writes the same draw.io file every time (golden)", async () => {
    const out = toDrawio([doc(railModel, true)], { measure })
    expect(out).toContain('danbyte_id="rail:v10"')
    expect(out).toContain("dashPattern=5 5;")
    await expect(out).toMatchFileSnapshot("./__golden__/rails.drawio")
  })
})
