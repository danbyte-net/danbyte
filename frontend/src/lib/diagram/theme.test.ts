import { describe, expect, it } from "vitest"
// @ts-expect-error -- Lucide's per-icon modules ship without types
import { __iconNode as lucideBuilding } from "lucide-react/dist/esm/icons/building.mjs"
// @ts-expect-error -- Lucide's per-icon modules ship without types
import { __iconNode as lucideCloud } from "lucide-react/dist/esm/icons/cloud.mjs"
// @ts-expect-error -- Lucide's per-icon modules ship without types
import { __iconNode as lucideGlobe } from "lucide-react/dist/esm/icons/globe.mjs"

import {
  CARD as CANVAS_CARD,
  NUB as CANVAS_NUB,
  PILL as CANVAS_PILL,
} from "@/components/topology/diagram/card-layout"
import { ELBOW_RADIUS as CANVAS_ELBOW } from "@/components/topology/diagram/link-geometry"
import { ZONE_COLORS as CANVAS_ZONE_COLORS } from "@/components/topology/view-positions"

import { NOTE_ICONS } from "./icons"
import {
  bandPaint,
  CARD,
  ELBOW_RADIUS,
  hex6,
  mix,
  NUB,
  PILL,
  printColor,
  PRINT,
  ZONE_COLORS,
} from "./theme"

describe("print theme", () => {
  it("keeps the canvas zone palette", () => {
    expect([...ZONE_COLORS]).toEqual([...CANVAS_ZONE_COLORS])
  })

  it("measures cards, pills, nubs and elbows like the canvas", () => {
    const card = [
      "RADIUS",
      "PAD_X",
      "PAD_Y",
      "TITLE_SIZE",
      "TITLE_WEIGHT",
      "TITLE_LH",
      "LINE_SIZE",
      "LINE_WEIGHT",
      "LINE_LH",
      "LINES_GAP",
    ] as const
    for (const k of card) expect(CARD[k], k).toBe(CANVAS_CARD[k])
    for (const k of Object.keys(PILL) as (keyof typeof PILL)[])
      expect(PILL[k], k).toBe(CANVAS_PILL[k])
    expect(NUB.RADIUS).toBe(CANVAS_NUB.RADIUS)
    expect(ELBOW_RADIUS).toBe(CANVAS_ELBOW)
  })

  it("normalises hex and resolves the canvas variables", () => {
    expect(hex6("ABC")).toBe("#aabbcc")
    expect(hex6(" #0EA5E9 ")).toBe("#0ea5e9")
    expect(hex6("red")).toBeNull()
    expect(hex6("#0ea5e980")).toBeNull()
    expect(printColor("var(--primary)", "#000000")).toBe(PRINT.primary)
    expect(printColor("var(--nope)", "#000000")).toBe("#000000")
    expect(printColor("2f6f9f", "#000000")).toBe("#2f6f9f")
  })

  it("mixes without alpha", () => {
    expect(mix("#000000", "#ffffff", 0.5)).toBe("#808080")
    expect(mix("#0ea5e9", "#ffffff", 1)).toBe("#0ea5e9")
    expect(mix("#0ea5e9", "#ffffff", 0)).toBe("#ffffff")
  })

  it("paints bands neutral unless they carry a swatch; zones always do", () => {
    expect(bandPaint({ kind: "row", fill: null }).fill).toBe(PRINT.tint)
    expect(bandPaint({ kind: "row", fill: "#123456" }).fill).toBe(PRINT.tint)
    expect(bandPaint({ kind: "column", fill: "#0ea5e9" }).fill).toBe(
      mix("#0ea5e9", "#ffffff", 0.06)
    )
    expect(bandPaint({ kind: "zone", fill: "#123456" }).edge).toBe(
      mix(ZONE_COLORS[0], "#ffffff", 0.75)
    )
  })
})

describe("note icons", () => {
  const strip = (node: [string, Record<string, string>][]) =>
    node.map(([tag, { key: _key, ...a }]) => [tag, a])

  it("are Lucide's own icon nodes", () => {
    expect(NOTE_ICONS.cloud).toEqual(strip(lucideCloud))
    expect(NOTE_ICONS.globe).toEqual(strip(lucideGlobe))
    expect(NOTE_ICONS.building).toEqual(strip(lucideBuilding))
  })
})
