// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { afterEach, describe, expect, it, vi } from "vitest"

import type {
  FloorPlan,
  FloorPlanCablePath,
  FloorPlanTile,
  FloorPlanTray,
} from "@/lib/api"

import * as draw from "./cable-draw"
import { CableChooser, CHOOSER_SEARCH_FROM } from "./cable-chooser"
import { CableLayer } from "./cable-layer"
import type { Pt } from "./cable-route"
import { FloorCanvas } from "./floor-canvas"
import { TrayInspector } from "./tray-panels"

// Bundles on the 2D plan: every leg of a bundled run drawn at every zoom
// and pan (testmap: two cables down from a switch and across to the core
// drew only part of their route from afar), and picking one cable out of a
// bundle or a tray - the chooser, its rows, its hover, its keys.

afterEach(cleanup)
if (!("ResizeObserver" in globalThis)) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
}
Element.prototype.setPointerCapture = () => {}
Element.prototype.releasePointerCapture = () => {}
Element.prototype.hasPointerCapture = () => false
Element.prototype.scrollIntoView = () => {}

const CELL = 40

// ── testmap, as /api/floor-plans/{id}/cable-paths/ returns it ──────────────

const SW = "cad6a98c-ac3d-4d0f-9e7d-3654ad46b125"
const CORE = "c07f4862-0e92-4205-bf47-5d1aa642b046"
const tileAt = (id: string, x: number, y: number, w = 1, h = 1) =>
  ({ id, x, y, width: w, height: h }) as FloorPlanTile
const testmapTiles = [
  tileAt(SW, 208.34, 123.434, 5.66, 0.566),
  tileAt(CORE, 242, 148),
]
const status = {
  id: "s1",
  name: "Connected",
  color: "#10b981",
  text_color: "#fff",
  is_planned: false,
}
const directPath = (version: string) =>
  ({
    kind: "direct",
    legs: [
      {
        from: { end: "A", tile: CORE, device: "core", at: [242.5, 148.5] },
        to: { end: "B", tile: SW, device: "sw", at: [211.17, 123.717] },
        trays: [],
        points: [
          [242.5, 148.5],
          [211.17, 148.5],
          [211.17, 123.717],
        ],
        waypoints: [],
      },
    ],
    tray_order: [],
    run_mm: 66606,
    drop_a_mm: 0,
    drop_b_mm: 0,
    extra_mm: 0,
    slack_mm: 6661,
    length_mm: 73500,
    stale: false,
    version,
  }) as unknown as NonNullable<FloorPlanCablePath["path"]>
const testmapCable = (id: string, n: number, port: string) =>
  ({
    id,
    label: `Cable #${n}`,
    color: "#3b82f6",
    type: "",
    type_display: "",
    status,
    length: 20,
    length_unit: "m",
    path: directPath(`v${n}`),
    a_top_mm: 0,
    b_top_mm: 0,
    a_tiles: [CORE],
    b_tiles: [SW],
    a_points: [
      {
        device: "core",
        port: `Ethernet1/${n - 1249}`,
        device_name: "aalborg-core1",
      },
    ],
    b_points: [{ device: "sw", port, device_name: "aalborg-sw1" }],
    a_far: [],
    b_far: [],
    tray_ids: [],
  }) as unknown as FloorPlanCablePath
const testmap = [
  testmapCable("df9b", 1271, "Gi1/0/12"),
  testmapCable("9370", 1272, "Gi1/0/13"),
]
const testmapRoutes = new draw.CableRouteCache().routes(testmap, {
  trays: [],
  tiles: testmapTiles,
})

const layer = (
  k: number,
  patch: Partial<React.ComponentProps<typeof CableLayer>> = {}
) => (
  <svg>
    <CableLayer
      cablePaths={testmap}
      routes={testmapRoutes}
      k={k}
      cellMm={1187}
      colorBy="status"
      bundle
      showLabels
      highlightIds={[]}
      interactive
      onSelect={() => {}}
      onHover={() => {}}
      tiles={testmapTiles}
      {...patch}
    />
  </svg>
)

/** Every straight piece the layer strokes (plan px): lanes, bundles and
 * lifted runs, not the transparent hit bands. */
function drawnSegments(container: HTMLElement): [Pt, Pt][] {
  const out: [Pt, Pt][] = []
  const paths = container.querySelectorAll(
    "[data-bundle] path, [data-cable] path, [data-lifted] path"
  )
  for (const p of paths) {
    if (p.getAttribute("stroke") === "transparent") continue
    if (p.getAttribute("stroke") === "var(--background)") continue
    const d = p.getAttribute("d") ?? ""
    const pts: Pt[] = []
    for (const m of d.matchAll(/([MLQ])([^MLQ]*)/g)) {
      const nums = m[2]
        .trim()
        .split(/[\s,]+/)
        .map(Number)
      // A corner's curve: its end point (the corners are a few px).
      pts.push([nums[nums.length - 2], nums[nums.length - 1]])
    }
    for (let i = 0; i < pts.length - 1; i++) out.push([pts[i], pts[i + 1]])
  }
  return out
}

const distToSeg = (p: Pt, [a, b]: [Pt, Pt]) => {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const l2 = dx * dx + dy * dy
  const t = l2
    ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2))
    : 0
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy))
}

/** The part of segment a→b inside a box (Liang-Barsky), or null. */
function clipToBox(
  a: Pt,
  b: Pt,
  box: { x0: number; y0: number; x1: number; y1: number }
): [Pt, Pt] | null {
  let t0 = 0
  let t1 = 1
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  for (const [p, q] of [
    [-dx, a[0] - box.x0],
    [dx, box.x1 - a[0]],
    [-dy, a[1] - box.y0],
    [dy, box.y1 - a[1]],
  ]) {
    if (p === 0) {
      if (q < 0) return null
      continue
    }
    const r = q / p
    if (p < 0) t0 = Math.max(t0, r)
    else t1 = Math.min(t1, r)
    if (t0 > t1) return null
  }
  return [
    [a[0] + t0 * dx, a[1] + t0 * dy],
    [a[0] + t1 * dx, a[1] + t1 * dy],
  ]
}

describe("bundled runs: every leg at every zoom and pan (testmap)", () => {
  // From afar to up close: far (< 16 px a cell), mid, near.
  const zooms = [0.03, 0.06, 0.1, 0.2, 0.3, 0.39, 0.4, 0.6, 1, 1.2, 2, 3]
  // Views of 1200 × 800 screen px: the whole route, then one centred on
  // the corner, on the vertical leg's middle (both its ends out of view up
  // close) and on the horizontal leg's middle.
  const centres: Pt[] = [
    [226.8, 136.1],
    [211.17, 148.5],
    [211.17, 136],
    [226.8, 148.5],
  ]

  it.each(zooms)("draws every leg in view at zoom %s", (k) => {
    const { container } = render(layer(k))
    const segs = drawnSegments(container)
    expect(segs.length).toBeGreaterThan(0)
    // A lane sits within a few plan px of the centreline; a bundle on it.
    const tol = 0.25 * CELL
    for (const [cx, cy] of centres) {
      const w = 1200 / k
      const h = 800 / k
      const box = {
        x0: cx * CELL - w / 2,
        y0: cy * CELL - h / 2,
        x1: cx * CELL + w / 2,
        y1: cy * CELL + h / 2,
      }
      for (const [id, route] of testmapRoutes) {
        const pts = route.points.map(([x, y]) => [x * CELL, y * CELL] as Pt)
        for (let i = 0; i < pts.length - 1; i++) {
          const inView = clipToBox(pts[i], pts[i + 1], box)
          if (!inView) continue
          const [a, b] = inView
          for (let s = 0; s <= 20; s++) {
            const p: Pt = [
              a[0] + ((b[0] - a[0]) * s) / 20,
              a[1] + ((b[1] - a[1]) * s) / 20,
            ]
            const near = Math.min(...segs.map((g) => distToSeg(p, g)))
            expect(
              near,
              `${id} leg ${i} at ${p.map((v) => (v / CELL).toFixed(1))}, zoom ${k}, view at ${cx},${cy}`
            ).toBeLessThan(tol)
          }
        }
      }
    }
  })

  it("draws the shared legs as bundles from afar, where it drew nothing", () => {
    const { container } = render(layer(0.06))
    expect(
      container.querySelector("[data-layer=cables]")!.getAttribute("data-lod")
    ).toBe("far")
    const bundles = [...container.querySelectorAll("[data-bundle]")]
    expect(bundles.map((b) => b.getAttribute("aria-label"))).toEqual([
      "2 cables",
      "2 cables",
    ])
  })

  it("keeps a tray's stretches out of the bundles from afar", () => {
    const layout = draw.layoutCables(testmapRoutes, ["df9b", "9370"])
    const fake = {
      ...layout,
      groups: new Map([
        ...layout.groups,
        ["t:x:0", { ...[...layout.groups.values()][0], key: "t:x:0" }],
      ]),
    }
    const far = draw.bundledGroups(fake, {
      lod: "far",
      bundle: true,
      minGapCells: 1,
    })
    expect([...far].every((k) => k.startsWith("d:"))).toBe(true)
    expect(far.size).toBe(2)
  })
})

// ── Picking one cable ────────────────────────────────────────────────────────

const many = (n: number) =>
  Array.from({ length: n }, (_, i) =>
    testmapCable(`c${i + 1}`, 1260 + ((i * 7) % n), `Gi1/0/${i + 1}`)
  )

function chooser(
  ids: string[],
  cablePaths: readonly FloorPlanCablePath[],
  patch: Partial<React.ComponentProps<typeof CableChooser>> = {}
) {
  const props = {
    onClose: vi.fn(),
    onPreview: vi.fn(),
    onPick: vi.fn(),
    ...patch,
  }
  render(
    <CableChooser
      menu={{ x: 20, y: 30, ids }}
      cablePaths={cablePaths}
      colorBy="status"
      {...props}
    />
  )
  return props
}

const rows = () =>
  [...document.querySelectorAll("[data-cable-choice]")] as HTMLElement[]

describe("the cable chooser", () => {
  it("lists each cable with its colour, label, ends and status, in lane order", () => {
    const cps = [
      { ...testmap[1], label: "Cable 10" },
      { ...testmap[0], label: "Cable 9", color: "", status: null },
    ] as FloorPlanCablePath[]
    chooser(["9370", "df9b"], cps)
    expect(screen.getByText("2 cables")).toBeTruthy()
    const r = rows()
    // Naturally: 9 before 10.
    expect(r.map((x) => x.getAttribute("data-cable-choice"))).toEqual([
      "df9b",
      "9370",
    ])
    expect(r[1].textContent).toContain("Cable 10")
    expect(r[1].textContent).toContain(
      "aalborg-core1 · Ethernet1/23 → aalborg-sw1 · Gi1/0/13"
    )
    expect(r[1].textContent).toContain("Connected")
    const swatch = r[1].querySelector<HTMLElement>("[data-part=swatch]")!
    expect(swatch.style.background).toBe("rgb(16, 185, 129)")
    // No status: no colour, the neutral line.
    expect(
      r[0].querySelector<HTMLElement>("[data-part=swatch]")!.style.background
    ).toBe(draw.CABLE_NONE)
    expect(screen.queryByRole("textbox")).toBeNull()
  })

  it("searches when there are more than a handful", () => {
    const cps = many(CHOOSER_SEARCH_FROM + 3)
    chooser(
      cps.map((c) => c.id),
      cps
    )
    const box = screen.getByRole("textbox", { name: "Search cables" })
    expect(rows()).toHaveLength(CHOOSER_SEARCH_FROM + 3)
    fireEvent.change(box, { target: { value: "gi1/0/7" } })
    expect(rows().map((r) => r.getAttribute("data-cable-choice"))).toEqual([
      "c7",
    ])
    fireEvent.change(box, { target: { value: "nothing" } })
    expect(screen.getByText("No cables match.")).toBeTruthy()
  })

  it("shows the row under the pointer on the plan, and picks on a click", () => {
    const { onPreview, onPick } = chooser(["df9b", "9370"], testmap)
    fireEvent.pointerEnter(rows()[1])
    expect(onPreview).toHaveBeenLastCalledWith("9370")
    fireEvent.click(rows()[1])
    expect(onPick).toHaveBeenCalledWith("9370")
  })

  it("works from the keyboard: arrows, Enter, Esc", async () => {
    const { onPreview, onPick } = chooser(["df9b", "9370"], testmap)
    fireEvent.keyDown(screen.getByRole("menu"), { key: "ArrowDown" })
    expect(document.activeElement).toBe(rows()[0])
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" })
    // The menu moves the focus on the next tick.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(document.activeElement).toBe(rows()[1])
    expect(onPreview).toHaveBeenLastCalledWith("9370")
    fireEvent.keyDown(document.activeElement!, { key: "Enter" })
    expect(onPick).toHaveBeenCalledWith("9370")
    cleanup()
    const second = chooser(["df9b", "9370"], testmap)
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" })
    expect(second.onClose).toHaveBeenCalled()
    expect(second.onPreview).toHaveBeenLastCalledWith(null)
  })
})

describe("the plan's side of picking", () => {
  it("a click or Enter on a bundle asks which cable, at the pointer", () => {
    const onChoose = vi.fn()
    const onSelect = vi.fn()
    const { container } = render(layer(0.6, { onChoose, onSelect }))
    const bundle = container.querySelector("[data-bundle]")!
    expect(bundle.getAttribute("aria-haspopup")).toBe("menu")
    fireEvent.pointerDown(bundle, { clientX: 50, clientY: 70 })
    expect(onChoose).toHaveBeenCalledWith(["df9b", "9370"], expect.anything())
    fireEvent.keyDown(bundle, { key: "Enter" })
    expect(onChoose).toHaveBeenCalledTimes(2)
    expect(onSelect).not.toHaveBeenCalled()
    // Still bundled: the chooser, not a fan.
    expect(container.querySelector("[data-bundle]")).not.toBeNull()
  })

  it("a single run opens at once", () => {
    const onChoose = vi.fn()
    const onSelect = vi.fn()
    const { container } = render(
      layer(0.6, {
        onChoose,
        onSelect,
        cablePaths: [testmap[0]],
        routes: new Map([["df9b", testmapRoutes.get("df9b")!]]),
      })
    )
    fireEvent.pointerDown(container.querySelector("[data-cable='df9b']")!)
    expect(onSelect).toHaveBeenCalledWith("df9b")
    expect(onChoose).not.toHaveBeenCalled()
  })

  it("the hovered row: that cable alone, apart from its bundle, the rest dimmed", () => {
    const { container } = render(layer(0.6, { soloId: "9370" }))
    const solo = container.querySelector("[data-solo='9370']")
    expect(solo).not.toBeNull()
    for (const b of container.querySelectorAll("[data-bundle]"))
      expect(b.getAttribute("opacity")).toBe("0.45")
    // Its lane runs beside the bundle, not on it: a bundle's half width
    // and a gap off the centreline, on screen.
    const d = solo!.querySelector("path:not([stroke-opacity='0.25'])")!
    const first = /M([\d.-]+) ([\d.-]+)/.exec(d.getAttribute("d")!)!
    const off = (Number(first[2]) - 148.5 * CELL) * 0.6
    expect(Math.abs(off)).toBeGreaterThan(draw.bundleWidth(2) / 2)
    expect(Math.abs(off)).toBeLessThan(draw.bundleWidth(2) / 2 + 6)
  })

  it("a traced cable runs in its own lane beside its bundles all along", () => {
    const { container } = render(layer(0.6, { highlightIds: ["df9b"] }))
    const lines = draw.splitLanes(
      draw.layoutCables(testmapRoutes, ["df9b", "9370"]),
      "df9b",
      new Set([
        ...draw.layoutCables(testmapRoutes, ["df9b", "9370"]).groups.keys(),
      ]),
      CELL * 0.6
    )
    expect(lines).toHaveLength(1)
    // Both legs moved off the centreline, the corner joined.
    const [a, corner, b] = lines[0]
    expect(a[1]).not.toBeCloseTo(148.5, 3)
    expect(corner[0]).not.toBeCloseTo(211.17, 3)
    expect(b[0]).toBeCloseTo(corner[0], 6)
    expect(container.querySelector("[data-lifted='df9b']")).not.toBeNull()
  })
})

// ── The canvas: bundle → chooser → trace; a tray's Show cables ──────────────

const plan = {
  id: "p1",
  name: "testmap",
  grid_width: 300,
  grid_height: 200,
  cell_mm: 1187,
  ceiling_mm: 3000,
  background_image: null,
  background_opacity: 60,
  state: {},
} as unknown as FloorPlan
const tray = {
  id: "tr1",
  name: "Ladder A",
  points: [
    [200, 100],
    [250, 100],
  ],
  level: "overhead",
  elevation_mm: null,
  color: "",
  cables: [
    { id: "9370", numid: 1272, label: "Cable #1272", type: "", color: "" },
    { id: "df9b", numid: 1271, label: "Cable #1271", type: "", color: "" },
    { id: "gone", numid: 9, label: "Elsewhere", type: "", color: "" },
  ],
  hidden_cable_count: 0,
} as unknown as FloorPlanTray

function canvas(patch: Partial<React.ComponentProps<typeof FloorCanvas>> = {}) {
  const onSelectCable = vi.fn()
  const r = render(
    <FloorCanvas
      plan={plan}
      tiles={testmapTiles}
      selectedId={null}
      editable={false}
      showGrid={false}
      armed={null}
      liveState={null}
      cablePaths={testmap}
      cableRoutes={testmapRoutes}
      showCableLinks
      bundleCables
      trays={[tray]}
      showTrays
      onSelectCable={onSelectCable}
      {...patch}
    />
  )
  return { ...r, onSelectCable }
}

describe("FloorCanvas cable chooser", () => {
  it("a bundle's click opens the chooser; a pick traces that cable", async () => {
    const { container, onSelectCable } = canvas()
    const bundle = container.querySelector("[data-bundle]")
    // Whatever the fit made the zoom, the testmap runs draw as bundles
    // from afar or mid range.
    expect(bundle).not.toBeNull()
    await act(async () => {
      fireEvent.pointerDown(bundle!, { clientX: 40, clientY: 40 })
    })
    expect(rows().map((r) => r.getAttribute("data-cable-choice"))).toEqual([
      "df9b",
      "9370",
    ])
    // The row under the pointer: that cable alone on the plan.
    fireEvent.pointerEnter(rows()[0])
    expect(container.querySelector("[data-solo='df9b']")).not.toBeNull()
    fireEvent.click(rows()[0])
    expect(onSelectCable).toHaveBeenCalledWith("df9b")
    expect(container.querySelector("[data-solo]")).toBeNull()
  })

  it("a tray's right-click: Show cables lists the cables in it", async () => {
    vi.useFakeTimers()
    try {
      const { container, onSelectCable } = canvas()
      const g = container.querySelector("g[transform]")!
      const m = /translate\(([-\d.e]+),([-\d.e]+)\) scale\(([-\d.e]+)\)/.exec(
        g.getAttribute("transform")!
      )!
      const [tx, ty, k] = m.slice(1).map(Number)
      const at = (x: number, y: number) => ({
        clientX: tx + x * CELL * k,
        clientY: ty + y * CELL * k,
      })
      fireEvent.contextMenu(container.querySelector("svg")!, at(225, 100))
      const show = screen.getByRole("menuitem", { name: /Show cables/ })
      expect(show.textContent).toContain("2")
      fireEvent.click(show)
      await act(async () => {
        vi.runAllTimers()
      })
      expect(screen.getByText("Ladder A")).toBeTruthy()
      // Only the cables drawn on this plan, in lane order.
      expect(rows().map((r) => r.getAttribute("data-cable-choice"))).toEqual([
        "df9b",
        "9370",
      ])
      fireEvent.click(rows()[1])
      expect(onSelectCable).toHaveBeenCalledWith("9370")
    } finally {
      vi.useRealTimers()
    }
  })

  it("a click on a tray in View lists its cables; a drag pans", async () => {
    const { container } = canvas()
    const t = container.querySelector("[data-tray='tr1']")!
    const svg = container.querySelector("svg")!
    fireEvent.pointerDown(t, { button: 0, clientX: 100, clientY: 100 })
    fireEvent.pointerUp(svg, { button: 0, clientX: 140, clientY: 100 })
    expect(rows()).toHaveLength(0)
    await act(async () => {
      fireEvent.pointerDown(t, { button: 0, clientX: 100, clientY: 100 })
      fireEvent.pointerUp(svg, { button: 0, clientX: 101, clientY: 100 })
    })
    expect(rows()).toHaveLength(2)
  })
})

describe("TrayInspector Show cables", () => {
  it("opens the chooser at the button", () => {
    const onShowCables = vi.fn()
    render(
      <QueryClientProvider client={new QueryClient()}>
        <TrayInspector
          tray={tray}
          highlightCableId={null}
          editing={false}
          onEditShape={() => {}}
          onHighlightCable={() => {}}
          onPatch={() => {}}
          onDelete={() => {}}
          onShowCables={onShowCables}
        />
      </QueryClientProvider>
    )
    fireEvent.click(screen.getByRole("button", { name: "Show cables" }))
    expect(onShowCables).toHaveBeenCalledWith({ x: 0, y: 0 })
  })
})
