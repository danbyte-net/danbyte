import { describe, expect, it } from "vitest"

import { approxMeasure } from "@/lib/diagram/measure"
import {
  CARD,
  NUB,
  PILL,
  cardLayout,
  normalizeHex,
  nubRect,
  nubSpan,
  pillWidth,
} from "./card-layout"
import type { CardLayoutInput } from "./card-layout"

// The card box drives the React Flow node size, the layout and the
// exports, so its rules are pinned here: compact in Simple, grown to fit
// every nub in Detailed, and never resized by a monitoring change.

const m = approxMeasure
const layout = (
  input: CardLayoutInput,
  demand?: Parameters<typeof cardLayout>[1]
) => cardLayout(input, demand, m)

const LINES = [
  { key: "primary_ip", text: "10.0.0.11" },
  { key: "loopback", text: "10.255.0.11" },
  { key: "serial", text: "SN FDO2231X0AB" },
]

describe("cardLayout: Simple (no nub demand)", () => {
  it("gives a short name the compact minimum box", () => {
    const b = layout({ name: "sw1", lines: [] })
    expect(b.w).toBe(CARD.MIN_W)
    expect(b.h).toBe(2 * CARD.PAD_Y + CARD.TITLE_LH)
    expect(b.title.text).toBe("sw1")
    expect(b.title.x).toBe(b.w / 2)
    expect(b.title.anchor).toBe("middle")
    expect(b.title.weight).toBe(700)
    expect(b.pill).toBeNull()
  })

  it("adds one line height per line", () => {
    const b = layout({ name: "leaf-01", lines: LINES })
    expect(b.h).toBe(
      2 * CARD.PAD_Y + CARD.TITLE_LH + CARD.LINES_GAP + 3 * CARD.LINE_LH
    )
    expect(b.lines.map((l) => l.text)).toEqual(LINES.map((l) => l.text))
    expect(b.lines.map((l) => l.top)).toEqual([
      CARD.PAD_Y + CARD.TITLE_LH + CARD.LINES_GAP,
      CARD.PAD_Y + CARD.TITLE_LH + CARD.LINES_GAP + CARD.LINE_LH,
      CARD.PAD_Y + CARD.TITLE_LH + CARD.LINES_GAP + 2 * CARD.LINE_LH,
    ])
    for (const l of b.lines) {
      expect(l.x).toBe(b.w / 2)
      expect(l.weight).toBe(400)
      expect(l.y).toBeGreaterThan(l.top)
      expect(l.y).toBeLessThan(l.top + l.lh)
    }
  })

  it("widens for the widest line and stays whole-pixel", () => {
    const long = { key: "tags", text: "production, core, dc1-hall-a" }
    const b = layout({ name: "sw1", lines: [long] })
    expect(b.w).toBeGreaterThan(CARD.MIN_W)
    expect(Number.isInteger(b.w)).toBe(true)
    expect(b.lines[0].text).toBe(long.text)
    expect(b.lines[0].w).toBeLessThanOrEqual(b.w - 2 * CARD.PAD_X)
  })

  it("caps the width and cuts what does not fit", () => {
    const name = "distribution-switch-building-a-floor-3-east-wing"
    const b = layout({
      name,
      lines: [{ key: "tags", text: name.repeat(2) }],
    })
    expect(b.w).toBe(CARD.MAX_W)
    expect(b.title.text.endsWith("…")).toBe(true)
    expect(b.title.w).toBeLessThanOrEqual(CARD.MAX_W - 2 * CARD.PAD_X)
    expect(b.lines[0].text.endsWith("…")).toBe(true)
  })
})

describe("cardLayout: pill", () => {
  const slot = ["Down", "Degraded"]

  it("puts the pill inside the top-left corner, beside the centred name", () => {
    const b = layout({
      name: "leaf-01",
      lines: LINES,
      pill: { kind: "check", text: "Down" },
      pillSlot: slot,
    })
    expect(b.stacked).toBe(false)
    expect(b.pill?.rect).toEqual({
      x: PILL.X,
      y: CARD.PAD_Y,
      w: pillWidth("Down", m),
      h: PILL.H,
    })
    // The centred name clears the widest pill the slot can hold.
    const widest = pillWidth("Degraded", m)
    expect(b.title.x).toBe(b.w / 2)
    expect(b.title.x - b.title.w / 2).toBeGreaterThanOrEqual(
      PILL.X + widest + PILL.GAP
    )
  })

  it("keeps the box when the monitoring pill comes and goes", () => {
    const up = layout({ name: "leaf-01", lines: LINES, pillSlot: slot })
    const down = layout({
      name: "leaf-01",
      lines: LINES,
      pill: { kind: "check", text: "Degraded" },
      pillSlot: slot,
    })
    expect(down.w).toBe(up.w)
    expect(down.h).toBe(up.h)
    expect(down.title).toEqual(up.title)
    expect(down.lines).toEqual(up.lines)
    expect(up.pill).toBeNull()
  })

  it("stacks the pill above a name too long to centre beside it", () => {
    const name = "core-router-01.dc1.example"
    const b = layout({
      name,
      lines: [],
      pill: { kind: "status", text: "Decommissioning" },
      pillSlot: ["Decommissioning"],
    })
    expect(b.stacked).toBe(true)
    expect(b.pill?.rect.y).toBe(CARD.PAD_Y)
    expect(b.title.top).toBe(CARD.PAD_Y + PILL.H + PILL.ROW_GAP)
    expect(b.title.text).toBe(name)
    expect(b.h).toBe(
      CARD.PAD_Y + PILL.H + PILL.ROW_GAP + CARD.TITLE_LH + CARD.PAD_Y
    )
  })

  it("caps a long status pill", () => {
    const text = "Waiting for the vendor to replace the chassis"
    const b = layout({
      name: "sw1",
      lines: [],
      pill: { kind: "status", text },
      pillSlot: [text],
    })
    expect(b.pill?.rect.w).toBeLessThanOrEqual(PILL.MAX_W)
    expect(b.pill?.text.endsWith("…")).toBe(true)
  })
})

describe("cardLayout: Detailed nubs", () => {
  it("is Simple's box when no side needs nubs", () => {
    const input = { name: "leaf-01", lines: LINES }
    expect(layout(input, { T: 0, R: 0, B: 0, L: 0 })).toEqual(layout(input))
  })

  it("grows the facing axis so every nub fits at full pitch", () => {
    const b = layout({ name: "leaf-01", lines: LINES }, { T: 2, B: 20 })
    expect(b.w).toBe(nubSpan(20))
    expect(nubSpan(20)).toBe(19 * NUB.PITCH + NUB.ALONG + 2 * NUB.INSET)
    expect(b.title.x).toBe(b.w / 2)
    const tall = layout({ name: "leaf-01", lines: LINES }, { L: 12 })
    expect(tall.h).toBe(nubSpan(12))
  })

  it("sizes for at most the per-side cap - the rest wrap", () => {
    const b = layout({ name: "leaf-01", lines: [] }, { B: 60 })
    expect(b.nubs.B).toBe(NUB.MAX_PER_SIDE)
    expect(b.w).toBe(nubSpan(NUB.MAX_PER_SIDE))
  })

  it("places nubs outside the card edge", () => {
    expect(nubRect(100, 40, "T", 50)).toEqual({
      x: 50 - NUB.ALONG / 2,
      y: -NUB.OUT,
      w: NUB.ALONG,
      h: NUB.OUT,
    })
    expect(nubRect(100, 40, "B", 50).y).toBe(40)
    expect(nubRect(100, 40, "L", 20)).toEqual({
      x: -NUB.OUT,
      y: 20 - NUB.ALONG / 2,
      w: NUB.OUT,
      h: NUB.ALONG,
    })
    expect(nubRect(100, 40, "R", 20).x).toBe(100)
  })
})

describe("cardLayout: fill", () => {
  it("fills with the role colour and picks readable ink", () => {
    const dark = layout({ name: "a", lines: [], color: "1D4ED8" })
    expect(dark.fill).toBe("#1d4ed8")
    expect(dark.ink).toBe("#fff")
    const light = layout({ name: "a", lines: [], color: "#facc15" })
    expect(light.ink).toBe("#0a0a0a")
  })

  it("is a neutral card without a usable role colour", () => {
    for (const color of [undefined, null, "", "red"]) {
      const b = layout({ name: "a", lines: [], color })
      expect(b.fill).toBeNull()
      expect(b.ink).toBeNull()
    }
  })

  it("normalises stored colours", () => {
    expect(normalizeHex("abc")).toBe("#aabbcc")
    expect(normalizeHex("#A1B2C3")).toBe("#a1b2c3")
    expect(normalizeHex("#12345")).toBeNull()
  })
})
