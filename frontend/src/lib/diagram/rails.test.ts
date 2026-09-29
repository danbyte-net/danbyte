// @vitest-environment jsdom
import { describe, expect, it } from "vitest"

import { railMeasure as measure, railModel } from "./__fixtures__/rails"
import { layoutRails, RAIL, RAIL_PALETTE, railRoles } from "./rails"
import type { RailModel } from "./rails"
import { cardTextHeight, PILL } from "./theme"
import type { Rect } from "./types"

const lay = (m: RailModel = railModel, width?: number) =>
  layoutRails(m, { measure, width })

const overlap = (a: Rect, b: Rect) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

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
