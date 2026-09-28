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
import { BAND as CANVAS_BAND } from "@/components/topology/diagram/bands"

import { NOTE_ICONS } from "./icons"
import {
  BAND,
  bandPaint,
  groundAt,
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
    // A row's title strip is as tall as the canvas's.
    expect(BAND.ROW_TITLE).toBe(CANVAS_BAND.TITLE)
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
    // The canvas's light grey: --muted 70% toward --border.
    const grey = mix(PRINT.wash, PRINT.border, 0.7)
    expect(bandPaint({ kind: "row", fill: null }).fill).toBe(grey)
    expect(bandPaint({ kind: "row", fill: "#123456" }).fill).toBe(grey)
    expect(bandPaint({ kind: "column", fill: "#0ea5e9" }).fill).toBe(
      mix("#0ea5e9", "#ffffff", 0.12)
    )
    expect(bandPaint({ kind: "zone", fill: "#123456" }).edge).toBe(
      mix(ZONE_COLORS[0], "#ffffff", 0.75)
    )
  })

  it("finds the colour under a point: the top band there, else the page", () => {
    const band = (
      id: string,
      x: number,
      fill: string | null,
      kind: "row" | "zone" = "row"
    ) => ({
      id,
      kind,
      orient: "h" as const,
      label: id,
      x,
      y: 0,
      w: 100,
      h: 100,
      fill,
    })
    const bands = [band("r", 0, null), band("z", 50, "#10b981", "zone")]
    expect(groundAt(bands, { x: 10, y: 10 }, "#fff000")).toBe(
      bandPaint(bands[0]).fill
    )
    // Both hold it: the zone is drawn over the row.
    expect(groundAt(bands, { x: 60, y: 10 }, "#fff000")).toBe(
      bandPaint(bands[1]).fill
    )
    expect(groundAt(bands, { x: 500, y: 10 }, "#fff000")).toBe("#fff000")
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
