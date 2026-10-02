import { describe, expect, it } from "vitest"

import type { DinProfile } from "@/lib/api"
import {
  PROFILE_HEIGHT_MM,
  PROFILE_LABELS,
  band,
  clampToPlate,
  deviceBody,
  firstFit,
  fmtGaps,
  freeGaps,
  newRail,
  nextRailLabel,
  parseRailDraft,
  railErrors,
  railSpans,
  roundMm,
  span,
  widestGap,
} from "./din-geometry"
import type { RailDevice, RailGeometry } from "./din-geometry"

// The twin of api/din.py: the editor shows what the server would refuse, in
// the server's words, before anything is sent. The messages are pinned here
// letter for letter - a drift between the two reads as a client error the
// server never gives, or a save that fails with no warning.

const rail = (
  label: string,
  y_mm: number,
  patch: Partial<RailGeometry> = {}
): RailGeometry => ({
  label,
  profile: "ts35",
  x_mm: 0,
  y_mm,
  length_mm: 500,
  ...patch,
})

describe("profiles", () => {
  it("takes a 35, 15 or 32 mm band, labelled as the server labels it", () => {
    expect(PROFILE_HEIGHT_MM).toEqual({ ts35: 35, ts15: 15, g32: 32 })
    expect(PROFILE_LABELS).toEqual({
      ts35: "TS 35",
      ts15: "TS 15",
      g32: "G 32",
    })
  })

  it("spans the band around the centreline and the length from the left end", () => {
    expect(band({ profile: "ts35", y_mm: 75 })).toEqual([57.5, 92.5])
    expect(band({ profile: "ts15", y_mm: 20 })).toEqual([12.5, 27.5])
    expect(band({ profile: "g32", y_mm: 100 })).toEqual([84, 116])
    expect(span({ x_mm: 12.5, length_mm: 300 })).toEqual([12.5, 312.5])
  })

  it("rounds to the tenth of a millimetre the API keeps", () => {
    expect(roundMm(75.3 + 125)).toBe(200.3)
    expect(roundMm(0.1 + 0.2)).toBe(0.3)
    expect(roundMm(12.34)).toBe(12.3)
  })
})

describe("railErrors", () => {
  it("passes rails that lie on the plate apart from each other", () => {
    expect(railErrors([rail("A", 75), rail("B", 200)], 500, 600)).toEqual([
      {},
      {},
    ])
  })

  it("answers as the server did for the same set, field for field", () => {
    // Sent to PATCH /api/cabinets/{id}/ on a 525×625 plate; this is the
    // server's 400 body, in order.
    const rails: RailGeometry[] = [
      rail("C", 75, { length_mm: 525 }),
      rail("D", 100, { length_mm: 525.5 }),
      rail("C", 10, { x_mm: 10, length_mm: 600 }),
      rail("E", 615, { profile: "g32", length_mm: 50 }),
    ]
    expect(railErrors(rails, 525, 625)).toEqual([
      {},
      {
        length_mm: ["Runs past the plate's right edge (525 mm)."],
        y_mm: ["Overlaps rail C."],
      },
      {
        label: ["Another rail has this label."],
        length_mm: ["Runs past the plate's right edge (525 mm)."],
        y_mm: ["Sticks out above the plate."],
      },
      { y_mm: ["Sticks out below the plate (625 mm)."] },
    ])
  })

  it("names the plate's width and height in the edge messages", () => {
    const [right, below] = railErrors(
      [
        rail("A", 75, { x_mm: 100, length_mm: 400.5 }),
        rail("B", 590, { profile: "ts35" }),
      ],
      500,
      600
    )
    expect(right.length_mm).toEqual([
      "Runs past the plate's right edge (500 mm).",
    ])
    expect(below.y_mm).toEqual(["Sticks out below the plate (600 mm)."])
  })

  it("puts an overlap on the later rail, naming the first it hits", () => {
    // A and B share a line end to end; C runs across both.
    const errors = railErrors(
      [
        rail("A", 75, { length_mm: 200 }),
        rail("B", 75, { x_mm: 300, length_mm: 200 }),
        rail("C", 80),
      ],
      500,
      600
    )
    expect(errors).toEqual([{}, {}, { y_mm: ["Overlaps rail A."] }])
  })

  it("lets rails touch, band against band or end to end", () => {
    // TS 35 at 75 ends at 92.5; a TS 15 at 100 starts there.
    expect(
      railErrors([rail("A", 75), rail("B", 100, { profile: "ts15" })], 500, 600)
    ).toEqual([{}, {}])
    // Two half rails on one line.
    expect(
      railErrors(
        [
          rail("L", 75, { length_mm: 250 }),
          rail("R", 75, { x_mm: 250, length_mm: 250 }),
        ],
        500,
        600
      )
    ).toEqual([{}, {}])
    // Side by side with overlapping bands but not running side by side.
    expect(
      railErrors(
        [
          rail("L", 75, { length_mm: 200 }),
          rail("R", 80, { x_mm: 300, length_mm: 200, profile: "g32" }),
        ],
        500,
        600
      )
    ).toEqual([{}, {}])
  })

  it("compares tenths, so float sums that touch never overlap", () => {
    // 93.2 + 17.5 is 110.7, but 128.2 - 17.5 is 110.69999999999999.
    expect(railErrors([rail("A", 93.2), rail("B", 128.2)], 500, 600)).toEqual([
      {},
      {},
    ])
    // 128.3 + 100.3 is 228.60000000000002.
    expect(
      railErrors(
        [
          rail("A", 75, { x_mm: 128.3, length_mm: 100.3 }),
          rail("B", 75, { x_mm: 228.6, length_mm: 100 }),
        ],
        500,
        600
      )
    ).toEqual([{}, {}])
    // Flush with every edge.
    expect(railErrors([rail("A", 17.5), rail("B", 582.5)], 500, 600)).toEqual([
      {},
      {},
    ])
  })

  it("prints a plate with a decimal the way the server does", () => {
    const [e] = railErrors([rail("A", 75, { length_mm: 600 })], 512.5, 600)
    expect(e.length_mm).toEqual([
      "Runs past the plate's right edge (512.5 mm).",
    ])
  })
})

describe("parseRailDraft", () => {
  const draft = (patch = {}) => ({
    label: "R1",
    profile: "ts35" as DinProfile,
    x_mm: "0",
    y_mm: "75",
    length_mm: "500",
    ...patch,
  })

  it("reads a rail, its label trimmed", () => {
    expect(parseRailDraft(draft({ label: " R1 ", x_mm: "12.5" }))).toEqual({
      rail: rail("R1", 75, { x_mm: 12.5 }),
      errors: {},
    })
  })

  it("answers a bad field with the serializer's message", () => {
    expect(parseRailDraft(draft({ label: "  " })).errors).toEqual({
      label: ["This field may not be blank."],
    })
    expect(parseRailDraft(draft({ label: "x".repeat(33) })).errors).toEqual({
      label: ["Ensure this field has no more than 32 characters."],
    })
    expect(parseRailDraft(draft({ x_mm: "12.55" })).errors).toEqual({
      x_mm: ["Ensure that there are no more than 1 decimal places."],
    })
    expect(parseRailDraft(draft({ y_mm: "-1" })).errors).toEqual({
      y_mm: ["Ensure this value is greater than or equal to 0."],
    })
    expect(parseRailDraft(draft({ length_mm: "5" })).errors).toEqual({
      length_mm: ["Ensure this value is greater than or equal to 10."],
    })
    expect(parseRailDraft(draft({ length_mm: "5000.1" })).errors).toEqual({
      length_mm: ["Ensure this value is less than or equal to 5000."],
    })
  })

  it("has no rail to draw while a number is blank", () => {
    const { rail: r, errors } = parseRailDraft(draft({ y_mm: "" }))
    expect(r).toBeNull()
    expect(errors).toEqual({ y_mm: ["A valid number is required."] })
  })
})

describe("Add rail", () => {
  it("labels the rail with the first free number", () => {
    expect(nextRailLabel([])).toBe("R1")
    expect(nextRailLabel(["R1", "R2"])).toBe("R3")
    expect(nextRailLabel(["R1", "R3"])).toBe("R2")
    expect(nextRailLabel([" R1 ", "Top"])).toBe("R2")
  })

  it("puts the first rail 75 mm from the top, across the plate", () => {
    expect(newRail([], 525, 625)).toEqual({
      label: "R1",
      profile: "ts35",
      x_mm: 0,
      y_mm: 75,
      length_mm: 525,
    })
  })

  it("puts the next 125 mm below the lowest rail", () => {
    const one = newRail([rail("R1", 75)], 500, 625)
    expect(one).toMatchObject({ label: "R2", x_mm: 0, y_mm: 200 })
    const two = newRail([rail("R2", 200), rail("R1", 75)], 500, 625)
    expect(two).toMatchObject({ label: "R3", y_mm: 325, length_mm: 500 })
    // Rounded to the tenth: 75.3 + 125 is 200.3, not 200.29999999999998.
    expect(newRail([rail("R1", 75.3)], 500, 625).y_mm).toBe(200.3)
  })

  it("takes the first free spot from the top when the next runs off", () => {
    // 325 would stick out below a 300 mm plate; the top edge is free.
    expect(newRail([rail("R1", 75), rail("R2", 200)], 500, 300).y_mm).toBe(17.5)
    // The top is taken: the spot right under the first band.
    expect(newRail([rail("R1", 30), rail("R2", 250)], 500, 300).y_mm).toBe(65)
  })

  it("keeps the rail on the plate when nothing is free", () => {
    const placed = newRail([rail("R1", 20), rail("R2", 55)], 500, 100)
    expect(placed.y_mm).toBe(82.5)
    // ...where it overlaps, for the operator to move.
    expect(
      railErrors([rail("R1", 20), rail("R2", 55), placed], 500, 100)[2]
    ).toEqual({ y_mm: ["Overlaps rail R2."] })
  })

  it("counts labels of rails it cannot place yet", () => {
    expect(newRail([], 500, 600, { labels: ["R1"] }).label).toBe("R2")
  })
})

describe("clampToPlate", () => {
  it("keeps a moved rail's span and band on the plate", () => {
    const r = { profile: "ts35" as DinProfile, length_mm: 400 }
    expect(clampToPlate(r, -20, 0, 500, 600)).toEqual({ x_mm: 0, y_mm: 17.5 })
    expect(clampToPlate(r, 150, 700, 500, 600)).toEqual({
      x_mm: 100,
      y_mm: 582.5,
    })
    expect(clampToPlate(r, 40.04, 300.06, 500, 600)).toEqual({
      x_mm: 40,
      y_mm: 300.1,
    })
  })

  it("holds a rail longer than the plate at the left edge", () => {
    const r = { profile: "ts15" as DinProfile, length_mm: 600 }
    expect(clampToPlate(r, 30, 50, 500, 600).x_mm).toBe(0)
  })
})

// ── devices on a rail ───────────────────────────────────────────────────────

/** A device on a rail, `width` mm wide (its type's), at `offset`. */
const on = (id: string, offset: number | null, width: number | null = 90) =>
  ({
    id,
    din_offset_mm: offset,
    device_type: { width_mm: width },
  }) satisfies RailDevice

describe("freeGaps", () => {
  it("is the whole rail while nothing is on it", () => {
    expect(freeGaps(400, [])).toEqual([[0, 400]])
  })

  it("leaves no gap between devices that touch, or at a rail's full end", () => {
    expect(
      freeGaps(400, [
        [0, 90],
        [90, 180],
      ])
    ).toEqual([[180, 400]])
    expect(
      freeGaps(180, [
        [90, 180],
        [0, 90],
      ])
    ).toEqual([])
  })

  it("finds the stretches between and around the devices, left to right", () => {
    expect(
      freeGaps(525, [
        [210, 300],
        [12.5, 120],
      ])
    ).toEqual([
      [0, 12.5],
      [120, 210],
      [300, 525],
    ])
  })

  it("compares tenths, so a hair of float never opens a gap", () => {
    expect(freeGaps(0.3, [[0, 0.1 + 0.2]])).toEqual([])
  })
})

describe("firstFit", () => {
  // The server's own sequence (api/tests_din_mounting.py): a 400 mm rail, a
  // 90 mm PLC at 100, then PLCs with no offset, then an 18 mm relay.
  it("takes the first gap from the left a device fits in, as the server does", () => {
    const devices = [on("a", 100)]
    const next = () => firstFit(freeGaps(400, railSpans(devices)), 90)
    for (const [id, want] of [
      ["b", 0],
      ["c", 190],
      ["d", 280],
    ] as const) {
      expect(next()).toBe(want)
      devices.push(on(id, want))
    }
    // "No gap on R1 is 90 mm wide."
    expect(next()).toBeNull()
    // A narrower device still fits the 30 mm left at the end, not the 10 mm
    // between the first two.
    expect(firstFit(freeGaps(400, railSpans(devices)), 18)).toBe(370)
  })

  it("fits a gap exactly as wide as the device", () => {
    expect(firstFit([[90, 180]], 90)).toBe(90)
    expect(firstFit([[90, 179.9]], 90)).toBeNull()
  })
})

describe("railSpans", () => {
  it("spans each device from its offset by its type's width, left to right", () => {
    expect(railSpans([on("b", 200, 45.5), on("a", 0)])).toEqual([
      [0, 90],
      [200, 245.5],
    ])
  })

  it("leaves out the device being moved, and devices off the rail", () => {
    const devices = [on("a", 0), on("b", 90), on("c", null)]
    expect(railSpans(devices, "a")).toEqual([[90, 180]])
  })

  it("counts a type with no width as taking nothing, like the server", () => {
    expect(railSpans([on("a", 50, null)])).toEqual([[50, 50]])
    expect(freeGaps(100, railSpans([on("a", 50, null)]))).toEqual([
      [0, 50],
      [50, 100],
    ])
  })
})

describe("gap labels", () => {
  it("prints gaps as the server prints a span", () => {
    expect(
      fmtGaps([
        [0, 12.5],
        [120, 525],
      ])
    ).toBe("0-12.5, 120-525 mm")
    expect(fmtGaps([])).toBe("")
  })

  it("measures the widest gap", () => {
    expect(
      widestGap([
        [0, 12.5],
        [120, 525],
      ])
    ).toBe(405)
    expect(widestGap([])).toBe(0)
  })
})

describe("deviceBody", () => {
  const r1 = { x_mm: 10, y_mm: 75 }
  const type = { width_mm: 60, height_mm: 147, din_rail_mm: null }

  it("sits at the rail's left end plus the offset, centred on the rail", () => {
    expect(deviceBody(r1, 120, type)).toEqual({
      x: 130,
      y: 1.5,
      width: 60,
      height: 147,
    })
  })

  it("hangs the body from the type's rail position when it has one", () => {
    expect(deviceBody(r1, 0, { ...type, din_rail_mm: 40 })).toMatchObject({
      x: 10,
      y: 35,
    })
  })

  it("draws nothing off a rail, or for a type without a size", () => {
    expect(deviceBody(r1, null, type)).toBeNull()
    expect(deviceBody(r1, 0, { ...type, height_mm: null })).toBeNull()
    expect(deviceBody(r1, 0, null)).toBeNull()
  })
})
