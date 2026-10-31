import type { Raster } from "./outline-detect"
import type { Pt } from "./shapes"

// Synthetic pictures for the outline detection tests: drawn here with
// anti-aliasing (4 × 4 samples a pixel) so they behave like the real thing
// - a map tile's building with its darker outline, a line drawing with a
// door gap - without binary files in the repository.

type Rgb = [number, number, number]

const hex = (s: string): Rgb => [
  parseInt(s.slice(1, 3), 16),
  parseInt(s.slice(3, 5), 16),
  parseInt(s.slice(5, 7), 16),
]

function inside(p: Pt, pts: readonly Pt[]): boolean {
  let hit = false
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i]
    const [xj, yj] = pts[j]
    if (
      yi > p[1] !== yj > p[1] &&
      p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi
    )
      hit = !hit
  }
  return hit
}

function edgeDist(p: Pt, pts: readonly Pt[]): number {
  let best = Infinity
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]
    const b = pts[(i + 1) % pts.length]
    const dx = b[0] - a[0]
    const dy = b[1] - a[1]
    const t = Math.max(
      0,
      Math.min(
        1,
        ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy)
      )
    )
    best = Math.min(
      best,
      Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy)
    )
  }
  return best
}

/** A blank picture of one colour. */
export function blank(width: number, height: number, colour: string): Raster {
  const data = new Uint8ClampedArray(width * height * 4)
  const [r, g, b] = hex(colour)
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = r
    data[i * 4 + 1] = g
    data[i * 4 + 2] = b
    data[i * 4 + 3] = 255
  }
  return { width, height, data }
}

/** Paint a polygon, filled and/or outlined (`stroke` px wide, centred on
 * the edges), anti-aliased. */
export function paint(
  r: Raster,
  pts: readonly Pt[],
  {
    fill,
    stroke,
    width = 1,
  }: { fill?: string; stroke?: string; width?: number }
) {
  const xs = pts.map((p) => p[0])
  const ys = pts.map((p) => p[1])
  const pad = width + 1
  const x0 = Math.max(0, Math.floor(Math.min(...xs) - pad))
  const x1 = Math.min(r.width - 1, Math.ceil(Math.max(...xs) + pad))
  const y0 = Math.max(0, Math.floor(Math.min(...ys) - pad))
  const y1 = Math.min(r.height - 1, Math.ceil(Math.max(...ys) + pad))
  const f = fill ? hex(fill) : null
  const s = stroke ? hex(stroke) : null
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++) {
      let cf = 0
      let cs = 0
      for (let sy = 0; sy < 4; sy++)
        for (let sx = 0; sx < 4; sx++) {
          const p: Pt = [x + (sx + 0.5) / 4, y + (sy + 0.5) / 4]
          if (s && edgeDist(p, pts) <= width / 2) cs++
          else if (f && inside(p, pts)) cf++
        }
      if (!cf && !cs) continue
      const k = (y * r.width + x) * 4
      for (let c = 0; c < 3; c++) {
        const base = r.data[k + c]
        const v =
          base * (1 - (cf + cs) / 16) +
          (f ? f[c] * (cf / 16) : 0) +
          (s ? s[c] * (cs / 16) : 0)
        r.data[k + c] = Math.round(v)
      }
    }
}

/** A rectangle w × h about (cx, cy), turned `deg` degrees. */
export function turnedRect(
  cx: number,
  cy: number,
  w: number,
  h: number,
  deg: number
): Pt[] {
  const a = (deg * Math.PI) / 180
  const c = Math.cos(a)
  const s = Math.sin(a)
  return (
    [
      [-w / 2, -h / 2],
      [w / 2, -h / 2],
      [w / 2, h / 2],
      [-w / 2, h / 2],
    ] as Pt[]
  ).map(([x, y]) => [cx + x * c - y * s, cy + x * s + y * c])
}

/** The street map's colours. */
export const MAP = {
  land: "#f2efe9",
  building: "#d9d0c9",
  outline: "#c4b6ab",
  road: "#ffffff",
  roadEdge: "#bbbbbb",
  text: "#555555",
}

/** A street map crop: a turned building, an L-shaped one beside it with a
 * house number in it, and a road between them. */
export function mapTile(): {
  raster: Raster
  turned: Pt[]
  ell: Pt[]
} {
  const r = blank(240, 180, MAP.land)
  // A road across the bottom.
  paint(
    r,
    [
      [0, 140],
      [240, 132],
      [240, 146],
      [0, 154],
    ],
    { fill: MAP.road, stroke: MAP.roadEdge }
  )
  const turned = turnedRect(70, 70, 80, 46, 20)
  paint(r, turned, { fill: MAP.building, stroke: MAP.outline })
  const ell: Pt[] = [
    [140.5, 20.5],
    [220.5, 20.5],
    [220.5, 60.5],
    [180.5, 60.5],
    [180.5, 110.5],
    [140.5, 110.5],
  ]
  paint(r, ell, { fill: MAP.building, stroke: MAP.outline })
  // A house number: dark specks inside the building.
  paint(
    r,
    [
      [150, 30],
      [158, 30],
      [158, 38],
      [150, 38],
    ],
    { fill: MAP.text }
  )
  return { raster: r, turned, ell }
}

/** A line drawing: two rooms side by side, 4 px walls, a 12 px door in the
 * wall between them and one in the outer wall. */
export function lineDrawing(): { raster: Raster; left: Pt[]; right: Pt[] } {
  const r = blank(200, 120, "#ffffff")
  const wall = (x0: number, y0: number, x1: number, y1: number) =>
    paint(
      r,
      [
        [x0, y0],
        [x1, y0],
        [x1, y1],
        [x0, y1],
      ],
      { fill: "#111111" }
    )
  // Outer walls (inner faces at x 14..186, y 14..106).
  wall(10, 10, 190, 14)
  wall(10, 106, 190, 110)
  wall(10, 10, 14, 110)
  wall(186, 10, 190, 50)
  wall(186, 62, 190, 110) // a 12 px door out on the right
  // The wall between, at x 98..102, with a 12 px door at y 54..66.
  wall(98, 14, 102, 54)
  wall(98, 66, 102, 106)
  // A word written in the left room.
  wall(40, 40, 60, 43)
  return {
    raster: r,
    left: [
      [14, 14],
      [98, 14],
      [98, 106],
      [14, 106],
    ],
    right: [
      [102, 14],
      [186, 14],
      [186, 106],
      [102, 106],
    ],
  }
}
