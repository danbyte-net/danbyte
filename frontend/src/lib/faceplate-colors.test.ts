import { describe, expect, it } from "vitest"

import {
  EMPTY_LEGEND,
  legendContent,
  legendIsEmpty,
  mergeLegend,
} from "./faceplate-colors"

const cabled = (speed: string, type = "") => ({
  enabled: true,
  cable: { id: "c1" },
  speed,
  type,
})

describe("legendContent", () => {
  it("keys only the tiers the drawn ports actually wear", () => {
    const c = legendContent({ ports: [cabled("1G"), cabled("10G")] })
    expect([...c.tiers].sort()).toEqual(["10G", "1G"])
    // Not "the whole ramp minus what's missing" — a panel of two speeds keys
    // two swatches.
    expect(c.tiers.size).toBe(2)
  })

  it("falls back to the cage type's max speed, like the colours do", () => {
    // No explicit speed recorded, but a QSFP28 cage can only be 100G.
    const c = legendContent({
      ports: [
        {
          enabled: true,
          cable: { id: "c1" },
          speed: "",
          type: "QSFP28 (100GE)",
        },
      ],
    })
    expect([...c.tiers]).toEqual(["100G"])
  })

  it("separates idle, disabled and observed-down", () => {
    const c = legendContent({
      ports: [
        { enabled: true, cable: null, speed: "" }, // idle
        { enabled: false, cable: null, speed: "" }, // off
      ],
      observed: new Map([
        ["eth1", { oper_status: "down", admin_status: "up" }],
      ]),
    })
    expect([...c.states].sort()).toEqual(["down", "idle", "off"])
    expect(c.tiers.size).toBe(0)
  })

  it("does not call an admin-down port 'down'", () => {
    // Admin-down is intent, not a fault — it gets the neutral zinc, and the
    // red "down" swatch would be a lie.
    const c = legendContent({
      observed: new Map([
        ["eth1", { oper_status: "down", admin_status: "down" }],
      ]),
    })
    expect(c.states.has("down")).toBe(false)
  })

  it("claims trunk only when a tagged port is drawn", () => {
    expect(legendContent({ ports: [cabled("1G")] }).trunk).toBe(false)
    expect(
      legendContent({ ports: [{ ...cabled("1G"), mode: "tagged" }] }).trunk
    ).toBe(true)
    expect(
      legendContent({ ports: [{ ...cabled("1G"), mode: "tagged-all" }] }).trunk
    ).toBe(true)
    expect(
      legendContent({ ports: [{ ...cabled("1G"), mode: "access" }] }).trunk
    ).toBe(false)
  })

  it("keys hardware by status id and never mixes it with speed tiers", () => {
    // The reported case: a photo panel of disk bays. It must NOT advertise the
    // FE…400G+ ramp just because the device also has ethernet ports elsewhere.
    const c = legendContent({
      parts: [
        { status: { id: "s-active" } },
        { status: { id: "s-empty" } },
        { status: { id: "s-active" } },
        { status: null },
      ],
    })
    expect([...c.partStatusIds].sort()).toEqual(["s-active", "s-empty"])
    expect(c.tiers.size).toBe(0)
    expect(c.states.size).toBe(0)
    expect(c.trunk).toBe(false)
  })

  it("is empty when nothing resolved", () => {
    expect(legendIsEmpty(legendContent({}))).toBe(true)
    expect(legendIsEmpty(EMPTY_LEGEND)).toBe(true)
    expect(legendIsEmpty(legendContent({ ports: [cabled("1G")] }))).toBe(false)
    expect(
      legendIsEmpty(legendContent({ parts: [{ status: { id: "s1" } }] }))
    ).toBe(false)
  })
})

describe("mergeLegend", () => {
  it("unions several panels — one legend under a whole stack", () => {
    const merged = mergeLegend([
      legendContent({ ports: [cabled("1G")] }),
      legendContent({ ports: [{ ...cabled("10G"), mode: "tagged" }] }),
      legendContent({ parts: [{ status: { id: "s-failed" } }] }),
    ])
    expect([...merged.tiers].sort()).toEqual(["10G", "1G"])
    expect(merged.trunk).toBe(true)
    expect([...merged.partStatusIds]).toEqual(["s-failed"])
  })

  it("of nothing is empty, and doesn't alias EMPTY_LEGEND", () => {
    const merged = mergeLegend([])
    expect(legendIsEmpty(merged)).toBe(true)
    // A shared mutable Set leaking into callers would poison every later
    // legend on the page.
    expect(merged.tiers).not.toBe(EMPTY_LEGEND.tiers)
  })
})
