// @vitest-environment jsdom
import { describe, expect, it } from "vitest"

import type { SiteMapConnection } from "@/lib/api"
import type { DrawnCable } from "./cable-geo-route"
import { connectionPaths } from "./connections-layer"
import {
  MAX_SPEED_LABELS,
  pathMidpoint,
  pickSpeedLabels,
  SPEED_LABEL_MIN_PX,
  SPEED_LABEL_MIN_ZOOM,
  speedLabelLines,
  stackedLabel,
} from "./speed-labels"
import type { LabelLine } from "./speed-labels"

// Speed labels on the site map (#246): only lines in view, at most 300, a
// line only once it is long enough on screen to carry one, nothing below the
// minimum zoom, and never two chips on top of each other.

type Pt = [number, number]

/** A flat test projection: one degree is `k` pixels, north up. */
const view = (zoom: number, k = 10, size = { x: 1000, y: 800 }) => ({
  zoom,
  size,
  project: ([lat, lng]: Pt) => ({ x: lng * k, y: size.y - lat * k }),
})

/** A horizontal line `len` degrees long, labelled at its middle. */
const line = (
  id: string,
  lat: number,
  lng: number,
  len: number
): LabelLine => ({
  id,
  label: "10G",
  a: [lat, lng],
  z: [lat, lng + len],
  at: [lat, lng + len / 2],
})

describe("pickSpeedLabels", () => {
  it("labels nothing below the minimum zoom", () => {
    const lines = [line("a", 40, 10, 20)]
    expect(pickSpeedLabels(lines, view(SPEED_LABEL_MIN_ZOOM - 1))).toEqual([])
    expect(pickSpeedLabels(lines, view(SPEED_LABEL_MIN_ZOOM))).toHaveLength(1)
  })

  it("labels only lines whose label point is in view", () => {
    const picked = pickSpeedLabels(
      [
        line("in", 40, 10, 20),
        line("west", 40, -60, 20),
        line("north", 95, 10, 20),
      ],
      view(8)
    )
    expect(picked.map((p) => p.id)).toEqual(["in"])
  })

  it("skips a line too short on screen, until zooming in makes it long enough", () => {
    const short = line("short", 30, 10, 5) // 50 px at k=10
    expect(5 * 10).toBeLessThan(SPEED_LABEL_MIN_PX)
    expect(pickSpeedLabels([short], view(8))).toEqual([])
    // Twice the pixels per degree: 100 px, and in view.
    expect(pickSpeedLabels([short], view(9, 20))).toHaveLength(1)
  })

  it("skips a line with no label", () => {
    expect(
      pickSpeedLabels([{ ...line("x", 40, 10, 20), label: "" }], view(8))
    ).toEqual([])
  })

  it("never draws more than the cap", () => {
    // 600 long lines on rows 20 px apart, each label clear of the others.
    const lines: LabelLine[] = []
    for (let i = 0; i < 600; i++) lines.push(line(`l${i}`, 1 + i * 2, 1, 90))
    const big = view(10, 10, { x: 2000, y: 100_000 })
    expect(pickSpeedLabels(lines, big)).toHaveLength(MAX_SPEED_LABELS)
    expect(pickSpeedLabels(lines, big, { max: 5 })).toHaveLength(5)
  })

  it("keeps the longer line's label when two would overlap", () => {
    const long = line("long", 40, 10, 40) // label at lng 30
    const shorter = { ...line("shorter", 40, 20, 20) } // label at lng 30 too
    const picked = pickSpeedLabels([shorter, long], view(8))
    expect(picked.map((p) => p.id)).toEqual(["long"])
  })

  it("places the label at the line's label point", () => {
    const [p] = pickSpeedLabels([line("a", 40, 10, 20)], view(8))
    expect(p).toEqual({ id: "a", label: "10G", at: [40, 20] })
  })
})

describe("pathMidpoint", () => {
  it("is halfway along the path, not the middle vertex", () => {
    expect(
      pathMidpoint([
        [0, 0],
        [0, 10],
      ])
    ).toEqual([0, 5])
    // Three vertices bunched at the start: halfway is still lng 5.
    const mid = pathMidpoint([
      [0, 0],
      [0, 1],
      [0, 2],
      [0, 10],
    ])
    expect(mid[0]).toBeCloseTo(0)
    expect(mid[1]).toBeCloseTo(5)
  })

  it("copes with a point or nothing", () => {
    expect(pathMidpoint([[3, 4]])).toEqual([3, 4])
    expect(
      pathMidpoint([
        [3, 4],
        [3, 4],
      ])
    ).toEqual([3, 4])
  })
})

const site = (id: string, latitude: number, longitude: number) => ({
  id,
  name: id,
  latitude,
  longitude,
})

const conn = (
  id: string,
  label: string | null,
  kind: SiteMapConnection["kind"] = "circuit"
): SiteMapConnection => ({
  id,
  kind,
  name: id,
  site_a: site("a", 55, 10),
  site_z: site("z", 56, 12),
  color: "",
  status: null,
  meta: {},
  capacity: label
    ? {
        kbps: 1,
        up_kbps: null,
        source: "commit",
        label,
        count: 1,
        unknown: 0,
      }
    : null,
})

const cable = (id: string, label: string | null): DrawnCable => ({
  id,
  label: id,
  color: "",
  path: [
    [55, 10],
    [55, 11],
  ],
  routed: false,
  capacity: label
    ? {
        kbps: 1,
        up_kbps: null,
        source: "cable",
        label,
        count: 1,
        unknown: 0,
      }
    : null,
})

describe("stackedLabel", () => {
  const capOf = (kbps: number, label: string, more = {}) => ({
    kbps,
    up_kbps: null,
    source: "cable" as const,
    label,
    count: 1,
    unknown: 0,
    ...more,
  })
  it("adds up cables on one line as the server adds a bundle", () => {
    expect(stackedLabel([capOf(1e7, "10G")])).toBe("10G")
    expect(stackedLabel([capOf(1e7, "10G"), capOf(1e7, "10G")])).toBe("2×10G")
    expect(stackedLabel([capOf(1e7, "10G"), capOf(2.5e7, "25G")])).toBe("35G")
    // A trunk of 3×10G beside a 10G: the sum, not "2×".
    expect(
      stackedLabel([capOf(3e7, "3×10G", { count: 3 }), capOf(1e7, "10G")])
    ).toBe("40G")
  })

  it("leaves out what is unknown, and says nothing when all is", () => {
    expect(stackedLabel([capOf(1e7, "10G"), null])).toBe("10G")
    expect(stackedLabel([null, undefined])).toBe("")
  })
})

describe("speedLabelLines", () => {
  it("takes the arcs and cables with a known speed, each at its middle", () => {
    const conns = [conn("circuit:1", "100G"), conn("circuit:2", null)]
    const lines = speedLabelLines({
      connections: conns,
      cables: [cable("c1", "10G"), cable("c2", null)],
    })
    expect(lines.map((l) => [l.id, l.label])).toEqual([
      ["circuit:1", "100G"],
      ["c1", "10G"],
    ])
    // The label sits on the arc the map draws, not on the straight chord.
    const arc = connectionPaths(conns).get("circuit:1")!
    expect(lines[0].at).toEqual(arc[Math.floor(arc.length / 2)])
    expect(lines[1].at).toEqual([55, 10.5])
  })

  it("gives cables drawn on one line one label for them all", () => {
    const apart = {
      ...cable("c3", "10G"),
      path: [
        [56, 10],
        [56, 11],
      ] as Pt[],
    }
    const lines = speedLabelLines({
      connections: [],
      cables: [cable("c1", "10G"), cable("c2", "10G"), apart],
    })
    expect(lines.map((l) => [l.id, l.label])).toEqual([
      ["c1", "2×10G"],
      ["c3", "10G"],
    ])
  })

  it("keeps only the traced cables' labels while a trace is lit", () => {
    const lines = speedLabelLines({
      connections: [conn("tunnel:1", "1G", "tunnel")],
      cables: [cable("c1", "10G"), cable("c2", "25G")],
      highlight: new Set(["c2"]),
    })
    expect(lines.map((l) => l.id)).toEqual(["tunnel:1", "c2"])
  })
})
