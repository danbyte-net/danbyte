import { describe, expect, it } from "vitest"

import type { CablePlanRow, StoredCablePath } from "@/lib/api"

import { defaultChoice, upsertOf } from "./document-routes-panel"

// Document routes: which rows start ticked, and what a ticked row saves -
// never a length a person entered unless its own box is ticked.

const route = (patch: Partial<StoredCablePath> = {}): StoredCablePath => ({
  kind: "trays",
  legs: [
    {
      from: { end: "A", tile: "a", device: null, at: [0.5, 0.5] },
      to: { end: "B", tile: "b", device: null, at: [4.5, 0.5] },
      points: [
        [0.5, 0.5],
        [4.5, 0.5],
      ],
      trays: [],
      waypoints: [],
    },
  ],
  tray_order: ["t1"],
  run_mm: 2400,
  drop_a_mm: 0,
  drop_b_mm: 0,
  extra_mm: 0,
  slack_mm: 240,
  length_mm: 3000,
  ...patch,
})

const row = (patch: Partial<CablePlanRow> = {}): CablePlanRow => ({
  id: "c1",
  label: "C-1",
  length: null,
  length_unit: "m",
  length_source: "",
  can_change: true,
  path: null,
  route: route(),
  reason: "",
  delta_mm: null,
  write_length: true,
  ...patch,
})

describe("Document routes", () => {
  it("ticks a new route and its blank length", () => {
    expect(defaultChoice(row())).toEqual({ route: true, length: true })
  })

  it("leaves a length a person entered unticked", () => {
    expect(defaultChoice(row({ length: 9, write_length: false }))).toEqual({
      route: true,
      length: false,
    })
  })

  it("leaves an unchanged stored route alone, ticks a stale one", () => {
    const same = row({ path: { ...route(), version: "v1", stale: false } })
    expect(defaultChoice(same).route).toBe(false)
    const stale = row({ path: { ...route(), version: "v1", stale: true } })
    expect(defaultChoice(stale).route).toBe(true)
  })

  it("never ticks a cable the user may not change", () => {
    expect(defaultChoice(row({ can_change: false })).route).toBe(false)
  })

  it("saves the previewed legs against the stored version", () => {
    const r = row({ path: { ...route(), version: "v1", stale: true } })
    expect(upsertOf(r, { route: true, length: true })).toEqual({
      cable: "c1",
      kind: "trays",
      legs: [
        {
          points: [
            [0.5, 0.5],
            [4.5, 0.5],
          ],
        },
      ],
      tray_order: ["t1"],
      version: "v1",
      write_length: true,
    })
  })

  it("replaces an entered length only when its box is ticked", () => {
    const entered = row({ length: 9, write_length: false })
    expect(
      upsertOf(entered, { route: true, length: false })
    ).not.toHaveProperty("replace_length")
    expect(
      upsertOf(entered, { route: true, length: true }).replace_length
    ).toBe(true)
  })
})
