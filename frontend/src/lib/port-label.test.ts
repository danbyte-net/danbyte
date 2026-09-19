import { describe, expect, it } from "vitest"

import {
  effectivePortLabelSource,
  fitLabelFontPx,
  portLabelText,
} from "./port-label"

describe("fitLabelFontPx", () => {
  it("is bounded by the box height for short text", () => {
    expect(fitLabelFontPx("A", 100, 20)).toBeCloseTo(14.4)
  })

  it("shrinks with length and never exceeds the box width", () => {
    const w = 40
    for (const text of ["A01", "Xtra", "SS", "TenGig"]) {
      const fs = fitLabelFontPx(text, w, 30)
      expect(fs * 0.62 * text.length).toBeLessThanOrEqual(w)
      expect(fs).toBeLessThanOrEqual(30 * 0.72)
    }
    expect(fitLabelFontPx("TenGig", w, 30)).toBeLessThan(
      fitLabelFontPx("SS", w, 30)
    )
  })

  it("survives a degenerate box", () => {
    expect(fitLabelFontPx("A", 0, 0)).toBe(0)
  })
})

describe("effectivePortLabelSource", () => {
  it("lets a device force labels off, or on with the port's own label", () => {
    expect(effectivePortLabelSource("peer_device", "")).toBe("peer_device")
    expect(effectivePortLabelSource("peer_device", "off")).toBe("")
    expect(effectivePortLabelSource("", "on")).toBe("interface")
    expect(effectivePortLabelSource("cable", "on")).toBe("cable")
    expect(effectivePortLabelSource(undefined, undefined)).toBe("")
  })
})

describe("portLabelText", () => {
  const facts = {
    label: "A01",
    cableLabel: "C-206",
    peerDevice: "srv1",
    peerPortLabel: "S-07",
  }
  it("picks the field the source names", () => {
    expect(portLabelText("interface", facts)).toBe("A01")
    expect(portLabelText("cable", facts)).toBe("C-206")
    expect(portLabelText("peer_device", facts)).toBe("srv1")
    expect(portLabelText("peer_port", facts)).toBe("S-07")
    expect(portLabelText("", facts)).toBe("")
  })
  it("prints nothing for a port that opted out or has no such text", () => {
    expect(portLabelText("interface", { ...facts, hideLabel: true })).toBe("")
    expect(portLabelText("peer_device", { label: "A01" })).toBe("")
  })
})
