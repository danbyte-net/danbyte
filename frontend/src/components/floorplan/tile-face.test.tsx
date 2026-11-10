// @vitest-environment jsdom
import { render } from "@testing-library/react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import type { FloorPlan, FloorPlanTile } from "@/lib/api"
import { tileIcon } from "@/components/object-icon"

import { CELL, GUTTER } from "./canvas-geometry"
import { FloorCanvas } from "./floor-canvas"
import { planSvg } from "./plan-svg"
import {
  GLYPH_MAX,
  GLYPH_MIN,
  INK_DARK,
  INK_LIGHT,
  NEUTRAL_SOLID,
  PAGE_HEX,
  WHITE_INK_MIN,
  contrast,
  faceBox,
  glyphCap,
  inkOn,
  luminance,
  solidBorder,
  solidFill,
  tileFace,
} from "./tile-face"
import type { FaceBox, TileTheme } from "./tile-face"
import { TileShape } from "./tile-layer"
import { facingBarRect, figureBarRect, marksOverlap } from "./tile-marks"
import type { MarkRect } from "./tile-marks"
import { tilePaint } from "./tile-paint"

// Display > Tile icons: a tile solid in its colour with a glyph of what
// it is, laid out clear of its marks, the same on screen and on paper.

const tile = (patch: Partial<FloorPlanTile> = {}): FloorPlanTile =>
  ({
    id: "t1",
    x: 2,
    y: 1,
    width: 1,
    height: 2,
    orientation: 0,
    label: "",
    color: "",
    status: "",
    linked: null,
    tile_type: null,
    role_type: null,
    display: "tile",
    riser: false,
    ...patch,
  }) as FloorPlanTile

const rack = (patch: Partial<FloorPlanTile> = {}) =>
  tile({
    link_kind: "rack",
    linked: { kind: "rack", id: "r1", name: "A01", route: "/racks/r1" },
    ...patch,
  })

/** The catalog's colours as they come: the Tailwind 500s the seeds and
 * the role pickers use, and the zinc fallbacks. */
const PALETTE = [
  "#ef4444",
  "#f97316",
  "#f59e0b",
  "#eab308",
  "#84cc16",
  "#22c55e",
  "#10b981",
  "#14b8a6",
  "#06b6d4",
  "#0ea5e9",
  "#3b82f6",
  "#6366f1",
  "#8b5cf6",
  "#a855f7",
  "#d946ef",
  "#ec4899",
  "#64748b",
  "#71717a",
  "#a1a1aa",
]
const THEMES: TileTheme[] = ["light", "dark"]

const asMark = (b: FaceBox): MarkRect => ({
  x: b.x,
  y: b.y,
  width: b.w,
  height: b.h,
})

describe("the glyph a tile wears", () => {
  it("is a rack's and a cabinet's kind icon without a role icon", () => {
    expect(tileIcon(rack())).toBe("container")
    expect(
      tileIcon(
        tile({
          linked: { kind: "cabinet", id: "c1", name: "K1", route: "" },
        })
      )
    ).toBe("rows-4")
  })

  it("is a device's role icon, its own icon first", () => {
    const role = { id: "r", name: "Access", color: "#0ea5e9", icon: "router" }
    const device = (icon?: string) =>
      tile({
        linked: {
          kind: "device",
          id: "d1",
          name: "sw1",
          route: "",
          role,
          icon,
        },
      })
    expect(tileIcon(device())).toBe("router")
    expect(tileIcon(device("cctv"))).toBe("cctv")
  })

  it("is a planning tile's type icon, and none without one", () => {
    const ups = tile({
      tile_type: {
        id: "u",
        name: "UPS",
        color: "#f59e0b",
        icon: "battery-charging",
        is_zone: false,
      },
    } as Partial<FloorPlanTile>)
    expect(tileIcon(ups)).toBe("battery-charging")
    const crah = tile({
      tile_type: {
        id: "c",
        name: "CRAH",
        color: "#38bdf8",
        icon: "snowflake",
        is_zone: false,
      },
    } as Partial<FloorPlanTile>)
    expect(tileIcon(crah)).toBe("snowflake")
    expect(tileIcon(tile())).toBe("")
    // A stale name falls through to nothing, never a broken glyph.
    expect(
      tileIcon(
        tile({
          tile_type: {
            id: "x",
            name: "X",
            color: "",
            icon: "no-such-icon",
            is_zone: false,
          },
        } as Partial<FloorPlanTile>)
      )
    ).toBe("")
  })
})

describe("fill and ink", () => {
  it("is white wherever white keeps 3:1, near-black otherwise", () => {
    expect(inkOn("#6366f1")).toBe(INK_LIGHT)
    expect(inkOn("#ef4444")).toBe(INK_LIGHT)
    expect(inkOn("#71717a")).toBe(INK_LIGHT)
    expect(inkOn("#f59e0b")).toBe(INK_DARK)
    expect(inkOn("#0ea5e9")).toBe(INK_DARK)
    for (const c of PALETTE)
      if (inkOn(c) === INK_LIGHT)
        expect(contrast(INK_LIGHT, c)).toBeGreaterThanOrEqual(WHITE_INK_MIN)
  })

  it("keeps a readable ink on every catalog colour, in both themes", () => {
    for (const theme of THEMES)
      for (const c of PALETTE)
        for (const linked of [true, false]) {
          const fill = solidFill(c, { linked, theme })
          expect(contrast(inkOn(fill), fill)).toBeGreaterThanOrEqual(
            WHITE_INK_MIN
          )
        }
  })

  it("draws a linked tile in its own colour, a planning tile lighter or deeper", () => {
    expect(solidFill("#6366f1", { linked: true, theme: "light" })).toBe(
      "#6366f1"
    )
    expect(solidFill("#6366f1", { linked: true, theme: "dark" })).toBe(
      "#6366f1"
    )
    const light = solidFill("#6366f1", { linked: false, theme: "light" })
    const dark = solidFill("#6366f1", { linked: false, theme: "dark" })
    expect(luminance(light)).toBeGreaterThan(luminance("#6366f1"))
    expect(luminance(dark)).toBeLessThan(luminance("#6366f1"))
  })

  it("takes the neutral for a tile with no colour of its own", () => {
    expect(
      solidFill("#a1a1aa", { linked: true, theme: "light", own: false })
    ).toBe(NEUTRAL_SOLID)
    const p = tilePaint({
      tile: rack(),
      colorBy: "type",
      rack: null,
      solid: true,
    })
    expect(p.fill).toBe(NEUTRAL_SOLID)
    expect(p.ink).toBe(INK_LIGHT)
  })

  it("borders a solid tile subtly, standing off the page in both themes", () => {
    for (const theme of THEMES)
      for (const c of PALETTE) {
        const border = solidBorder(c, theme)
        expect(border).not.toBe(c)
        expect(contrast(border, c)).toBeLessThan(2)
      }
    // Darker on a light page, lighter on a dark one.
    expect(luminance(solidBorder("#6366f1", "light"))).toBeLessThan(
      luminance("#6366f1")
    )
    expect(luminance(solidBorder("#6366f1", "dark"))).toBeGreaterThan(
      luminance("#6366f1")
    )
    expect(PAGE_HEX.light).not.toBe(PAGE_HEX.dark)
  })
})

describe("solid paint", () => {
  const fig = {
    used_units: 30,
    u_height: 42,
    power: { available_w: 1000, allocated_w: 900, maximum_w: 1000 },
  }

  it("fills by Color by, the bar in ink where the fill is the measure", () => {
    const p = tilePaint({
      tile: rack(),
      colorBy: "power",
      rack: fig,
      solid: true,
    })
    expect(p.fillOpacity).toBe(1)
    expect(p.barColor).toBe(p.ink)
    // Under Type the bar keeps its level colour on the tile's own colour.
    const t = tilePaint({
      tile: rack({ color: "#6366f1" }),
      colorBy: "type",
      rack: fig,
      solid: true,
    })
    expect(t.fill).toBe("#6366f1")
    expect(t.barColor).toBe(t.figure!.color)
  })

  it("keeps monitoring on the stroke and selection in the page's ink", () => {
    const down = tilePaint({
      tile: rack({ color: "#6366f1" }),
      colorBy: "type",
      rack: null,
      check: "down",
      solid: true,
    })
    expect(down.stroke).toBe("#ef4444")
    expect(down.alarm).toBe(true)
    const sel = tilePaint({
      tile: rack({ color: "#6366f1" }),
      colorBy: "type",
      rack: null,
      selected: true,
      solid: true,
    })
    expect(sel.stroke).toBe("var(--foreground)")
  })

  it("leaves a tile the colouring is not about pale, so the racks read", () => {
    const p = tilePaint({
      tile: tile({ color: "#22c55e" }),
      colorBy: "space",
      rack: null,
      solid: true,
    })
    expect(p.muted).toBe(true)
    expect(p.ink).toBeNull()
    expect(p.fillOpacity).toBeLessThan(0.2)
  })
})

describe("glyph size", () => {
  it("is not drawn on a tile too small for it", () => {
    expect(tileFace({ w: 20, h: 20, orientation: 0 }).glyph).toBeNull()
  })

  it("fills a one-cell tile without a name, under the cap", () => {
    const g = tileFace({ w: CELL, h: CELL, orientation: 0 }).glyph!
    expect(g.size).toBeGreaterThanOrEqual(GLYPH_MIN)
    expect(g.size).toBeLessThanOrEqual(GLYPH_MAX)
  })

  it("sits beside a short name on a one-cell rack", () => {
    const f = tileFace({
      w: CELL,
      h: CELL,
      orientation: 0,
      figure: { text: false },
      name: { text: "A1", fontSize: 11 },
    })
    expect(f.glyph!.size).toBeGreaterThanOrEqual(GLYPH_MIN)
    expect(f.label!.x).toBeGreaterThan(f.glyph!.x + f.glyph!.size)
  })

  it("gives way to the name where both do not fit", () => {
    const f = tileFace({
      w: CELL,
      h: CELL,
      orientation: 0,
      figure: { text: false },
      name: { text: "A01-R12", fontSize: 11 },
    })
    expect(f.glyph).toBeNull()
    expect(f.label).toBeNull()
  })

  it("stands over the name on a tall tile, beside it on a wide one", () => {
    const tall = tileFace({
      w: CELL,
      h: CELL * 2,
      orientation: 0,
      name: { text: "A01", fontSize: 11 },
    })
    expect(tall.glyph).not.toBeNull()
    expect(tall.label!.y).toBeGreaterThan(tall.glyph!.y + tall.glyph!.size)
    const wide = tileFace({
      w: CELL * 3,
      h: CELL,
      orientation: 0,
      name: { text: "CRAH-01", fontSize: 11 },
    })
    expect(wide.glyph).not.toBeNull()
    expect(wide.label!.x).toBeGreaterThan(wide.glyph!.x + wide.glyph!.size)
  })

  it("stops at the cap on a rack, grows with a big tile", () => {
    expect(glyphCap({ w: 30, h: 70 })).toBe(GLYPH_MAX)
    const big = tileFace({ w: CELL * 5, h: CELL * 20, orientation: 0 }).glyph!
    expect(big.size).toBeGreaterThan(GLYPH_MAX)
    // Next to a big name it is never the smaller of the two.
    const named = tileFace({
      w: CELL * 5,
      h: CELL * 20,
      orientation: 0,
      name: { text: "GEN-01", fontSize: 44 },
    }).glyph!
    expect(named.size).toBeGreaterThanOrEqual(44)
  })
})

describe("the glyph and the marks", () => {
  const sizes = [
    [1, 1],
    [1, 2],
    [2, 1],
    [2, 2],
    [3, 1],
    [1, 3],
  ]
  it("never overlaps the front edge, the capacity bar, the count or the riser", () => {
    for (const [cw, ch] of sizes)
      for (const orientation of [0, 90, 180, 270])
        for (const figure of [null, { text: false }, { text: true }])
          for (const name of [null, { text: "A01", fontSize: 11 }]) {
            const w = cw * CELL
            const h = ch * CELL
            const riser = Math.min(14, (h - GUTTER * 2) * 0.32)
            const input = {
              w,
              h,
              orientation,
              figure,
              count: true,
              riser,
              name,
            }
            const f = tileFace(input)
            if (!f.glyph) continue
            const g = {
              x: f.glyph.x,
              y: f.glyph.y,
              width: f.glyph.size,
              height: f.glyph.size,
            }
            const facing = facingBarRect(w, h, orientation, !!figure)
            expect(marksOverlap(g, facing)).toBe(false)
            if (figure)
              expect(marksOverlap(g, figureBarRect(w, h, orientation))).toBe(
                false
              )
            // The device count's corner and the riser's.
            expect(
              marksOverlap(g, {
                x: w - GUTTER - 30,
                y: h - GUTTER - 12,
                width: 30,
                height: 12,
              })
            ).toBe(false)
            expect(
              marksOverlap(g, {
                x: w - GUTTER - 3 - riser,
                y: GUTTER + 3,
                width: riser,
                height: riser,
              })
            ).toBe(false)
            // Inside the tile.
            const box = asMark(faceBox(input))
            expect(g.x).toBeGreaterThanOrEqual(box.x - 0.01)
            expect(g.y).toBeGreaterThanOrEqual(box.y - 0.01)
            expect(g.x + g.width).toBeLessThanOrEqual(box.x + box.width + 0.01)
            expect(g.y + g.height).toBeLessThanOrEqual(
              box.y + box.height + 0.01
            )
          }
  })
})

/** The glyph a canvas tile draws, as plan numbers. */
function canvasGlyph(t: FloorPlanTile) {
  const html = renderToStaticMarkup(
    <svg>
      <TileShape
        tile={t}
        selected={false}
        editable={false}
        labelFit={false}
        icons
        hideName
        onPointerDown={() => {}}
        onResizeDown={() => {}}
        onDoubleClick={() => {}}
      />
    </svg>
  )
  const root = new DOMParser().parseFromString(html, "text/html").body
  const g = root.querySelector('[data-part="glyph"]')!
  const fill = root.querySelector('[data-part="fill"]')!
  return {
    x: Number(g.getAttribute("x")),
    y: Number(g.getAttribute("y")),
    size: Number(g.getAttribute("width")),
    color: g.getAttribute("color") ?? g.getAttribute("stroke"),
    fill: fill.getAttribute("fill"),
  }
}

describe("export parity", () => {
  const ups = tile({
    id: "u1",
    width: 2,
    height: 2,
    orientation: 90,
    tile_type: {
      id: "u",
      name: "UPS",
      color: "#f59e0b",
      icon: "battery-charging",
      is_zone: false,
    },
  } as Partial<FloorPlanTile>)
  const plan = { grid_width: 12, grid_height: 8, cell_mm: 600 }

  it("prints the glyph where the canvas draws it, in the same colours", () => {
    const screen = canvasGlyph(ups)
    const svg = planSvg({ plan, tiles: [ups], tileIcons: true })
    const root = new DOMParser().parseFromString(
      svg,
      "image/svg+xml"
    ).documentElement
    const use = root.querySelector("use")!
    expect(Number(use.getAttribute("x"))).toBeCloseTo(screen.x, 1)
    expect(Number(use.getAttribute("y"))).toBeCloseTo(screen.y, 1)
    expect(Number(use.getAttribute("width"))).toBeCloseTo(screen.size, 1)
    const rect = root.querySelector("g[transform] rect")!
    expect(rect.getAttribute("fill")).toBe(screen.fill)
    // The symbol it uses carries the ink the canvas draws in.
    const id = use.getAttribute("href")!.slice(1)
    const sym = root.querySelector(`symbol[id="${id}"]`)!
    expect(sym.innerHTML).toContain(screen.color!)
  })

  it("defines each icon once on the sheet, a <use> per tile", () => {
    const racks = [0, 1, 2, 3].map((i) =>
      rack({ id: `r${i}`, x: i, color: "#6366f1" })
    )
    const svg = planSvg({ plan, tiles: racks, tileIcons: true })
    const root = new DOMParser().parseFromString(
      svg,
      "image/svg+xml"
    ).documentElement
    expect(root.querySelectorAll("symbol")).toHaveLength(1)
    expect(root.querySelectorAll("use")).toHaveLength(4)
  })

  it("prints plain tiles with Tile icons off", () => {
    const svg = planSvg({ plan, tiles: [ups] })
    expect(svg).not.toContain("<use")
    expect(svg).not.toContain("<symbol")
  })
})

describe("the canvas", () => {
  const plan = {
    id: "p1",
    name: "Hall",
    grid_width: 12,
    grid_height: 8,
    cell_mm: 600,
    ceiling_mm: 3000,
    background_image: null,
    background_opacity: 60,
    state: {},
    layout_mode: "grid",
  } as unknown as FloorPlan
  const racks = [0, 1, 2].map((i) =>
    rack({ id: `r${i}`, x: i * 2, label: "", color: "#6366f1" })
  )
  const draw = (p: Partial<React.ComponentProps<typeof FloorCanvas>> = {}) =>
    render(
      <FloorCanvas
        plan={plan}
        tiles={racks}
        selectedId={null}
        editable={false}
        showGrid
        armed={null}
        {...p}
      />
    )

  it("draws its glyphs from one sprite symbol per icon", () => {
    const { container } = draw()
    expect(container.querySelectorAll("symbol")).toHaveLength(1)
    const uses = container.querySelectorAll('use[data-part="glyph"]')
    expect(uses).toHaveLength(3)
    const id = container.querySelector("symbol")!.id
    for (const u of uses) expect(u.getAttribute("href")).toBe(`#${id}`)
  })

  it("goes back to plain tiles with Tile icons off, or as the plan saved it", () => {
    const off = draw({ tileIcons: false })
    expect(off.container.querySelector('[data-part="glyph"]')).toBeNull()
    const fill = off.container.querySelector('[data-part="fill"]')!
    expect(Number(fill.getAttribute("fill-opacity"))).toBeLessThan(0.5)
    off.unmount()
    const saved = draw({
      plan: { ...plan, state: { tile_icons: false } },
    })
    expect(saved.container.querySelector('[data-part="glyph"]')).toBeNull()
  })
})
