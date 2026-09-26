import { describe, expect, it } from "vitest"

import {
  bundleStroke,
  edgeLook,
  edgeStroke,
  flowEdgeStyle,
  speedColor,
  statusColor,
  typeColor,
} from "./edge-style"

const LABEL = { fontSize: 9 }
const LABEL_BG = { fill: "var(--card)" }

describe("edge style table", () => {
  it("draws each edge kind as the canvas always has", () => {
    const flow = (...args: Parameters<typeof edgeLook>) =>
      flowEdgeStyle(edgeLook(...args))
    expect(flow("cable")).toEqual({
      style: { strokeWidth: 1.25 },
      labelStyle: LABEL,
      labelBgStyle: LABEL_BG,
    })
    expect(flow("cable", { count: 2, stroke: "#123456", via: true })).toEqual({
      style: { strokeWidth: 1.75, stroke: "#123456", strokeDasharray: "10 4" },
      labelStyle: LABEL,
      labelBgStyle: LABEL_BG,
    })
    // The traced run wins over colour, count and via.
    expect(
      flow("cable", { count: 3, stroke: "#123456", via: true, marked: true })
        .style
    ).toEqual({ strokeWidth: 2.5, stroke: "var(--primary)" })
    expect(flow("lagbundle", { stroke: "#abcdef" })).toEqual({
      style: { strokeWidth: 2.5, stroke: "#abcdef" },
      labelStyle: { fontSize: 9, fontWeight: 600 },
      labelBgStyle: LABEL_BG,
    })
    expect(flow("lagbundle", { marked: true }).style).toEqual({
      strokeWidth: 3,
      stroke: "var(--primary)",
    })
    expect(flow("bundle")).toEqual({
      style: { strokeWidth: 1.75 },
      labelStyle: LABEL,
      labelBgStyle: LABEL_BG,
    })
    expect(flow("ghost")).toEqual({
      style: {
        strokeWidth: 1.5,
        stroke: "var(--muted-foreground)",
        strokeDasharray: "6 4",
        opacity: 0.8,
      },
      labelStyle: { fontSize: 9, fontStyle: "italic" },
      labelBgStyle: LABEL_BG,
    })
    expect(flow("through")).toEqual({
      style: {
        strokeWidth: 1.5,
        stroke: "var(--muted-foreground)",
        strokeDasharray: "4 3",
      },
      labelStyle: LABEL,
      labelBgStyle: LABEL_BG,
    })
    // Unlabelled kinds carry no label styling at all.
    expect(flow("bgp")).toEqual({
      style: {
        strokeWidth: 1.25,
        stroke: "var(--primary)",
        strokeDasharray: "3 5",
        opacity: 0.45,
      },
    })
    expect(flow("membership")).toEqual({
      style: { strokeWidth: 1, stroke: "var(--border)", opacity: 0.6 },
    })
  })

  it("widens a grouped edge gently with its cable count, capped", () => {
    expect(edgeLook("groupedge").width).toBeCloseTo(1.6)
    expect(edgeLook("groupedge", { count: 3 }).width).toBeCloseTo(2.2)
    expect(edgeLook("groupedge", { count: 500 }).width).toBe(3)
  })
})

describe("edge colours", () => {
  it("prefers the status record's own colour over the slug", () => {
    expect(
      statusColor({ status: "connected", status_mini: { color: "#123abc" } })
    ).toBe("#123abc")
    expect(
      edgeStroke(
        { status: "planned", status_mini: { color: "#654321" } },
        "status"
      )
    ).toBe("#654321")
  })

  it("falls back to the slug for payloads without a status record", () => {
    expect(statusColor({ status: "connected" })).toBe("#10b981")
    expect(statusColor({ status: "planned", status_mini: null })).toBe(
      "#f59e0b"
    )
    expect(statusColor({ status: "decommissioning" })).toBe("#ef4444")
    expect(statusColor({ status: "something-else" })).toBe("#71717a")
    expect(statusColor({ status: "active", status_mini: { color: "" } })).toBe(
      "#10b981"
    )
    expect(statusColor({})).toBeUndefined()
    expect(statusColor(undefined)).toBeUndefined()
  })

  it("colours by the active mode", () => {
    const cable = {
      cable_type: "smf",
      color: "#ff00ff",
      status: "connected",
      speed: "10G",
    }
    expect(edgeStroke(cable, "cable")).toBe("#ff00ff")
    expect(edgeStroke(cable, "type")).toBe(typeColor("smf"))
    expect(edgeStroke(cable, "status")).toBe("#10b981")
    expect(edgeStroke(cable, "speed")).toBe("#0ea5e9")
    expect(edgeStroke(cable, "none")).toBeUndefined()
    expect(edgeStroke({ color: "" }, "cable")).toBeUndefined()
    expect(edgeStroke(undefined, "type")).toBeUndefined()
  })

  it("hashes a cable type to one stable palette hue", () => {
    expect(typeColor("cat6")).toBe(typeColor("cat6"))
    expect(typeColor("cat6")).toMatch(/^#[0-9a-f]{6}$/)
  })

  it("tiers speeds, faster = hotter", () => {
    expect(speedColor("100G")).toBe("#e11d48")
    expect(speedColor("40G")).toBe("#f59e0b")
    expect(speedColor("25 Gbps")).toBe("#8b5cf6")
    expect(speedColor("10000")).toBe("#0ea5e9")
    expect(speedColor("1000")).toBe("#10b981")
    expect(speedColor("100")).toBe("#71717a")
    expect(speedColor("fast")).toBe("#71717a")
    expect(speedColor(null)).toBeUndefined()
  })

  it("keeps a bundle's colour only when every member agrees", () => {
    const a = { color: "#111111", cable_type: "smf" }
    const b = { color: "#222222", cable_type: "smf" }
    expect(bundleStroke([a, b], "type")).toBe(typeColor("smf"))
    expect(bundleStroke([a, b], "cable")).toBeUndefined()
    expect(bundleStroke([a, a], "cable")).toBe("#111111")
    expect(bundleStroke([a, {}], "cable")).toBeUndefined()
    expect(bundleStroke([{}, {}], "cable")).toBeUndefined()
  })
})
