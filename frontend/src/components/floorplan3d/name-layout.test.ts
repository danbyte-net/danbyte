import { describe, expect, it } from "vitest"

import { boxesHit } from "@/components/floorplan/plan-labels"
import type { Box } from "@/components/floorplan/plan-labels"
import { CALLOUT_MAX_LEADER } from "@/components/floorplan/plan-callouts"

import { MAX_CALLOUT_CROWD, layoutNames3D, plateBox } from "./name-layout"
import type { Name3D, NameLayout3D } from "./name-layout"

// Readable names in the 3D room: a row of racks seen from afar must never
// show two plates over each other, nor drop names silently - its crowd is
// called out (boxes with leaders) or named by one summary plate.

const H = 18
const plateSize = (name: string, icon: string) => ({
  w: name.length * 7.2 + 6 + (icon ? 16 : 0),
  h: H,
})
const view: Box = { x: 0, y: 0, w: 1400, h: 900 }

/** A row of `n` racks, `step` px apart on screen, RACK-01 first. */
function row(n: number, step: number, opts: { x0?: number; y?: number } = {}) {
  const x0 = opts.x0 ?? 400
  const y = opts.y ?? 500
  return Array.from({ length: n }, (_, i): Name3D => {
    const name = `RACK-${String(i + 1).padStart(2, "0")}`
    return {
      id: `r${i + 1}`,
      name,
      kind: "rack",
      icon: "server",
      color: "#3f3f46",
      x: x0 + i * step,
      y,
      ...plateSize(name, "server"),
      // Nearer first: the later ones are farther off.
      priority: 1e6 - i,
    }
  })
}

/** Every plate drawn: plain over its anchor, called out, or a summary. */
function drawn(names: readonly Name3D[], l: NameLayout3D): Box[] {
  return [
    ...names.filter((n) => l.plain.has(n.id)).map(plateBox),
    ...[...l.callouts.values()].map((c) => c.box),
    ...l.summaries.map((s) => s.box),
  ]
}

const overlaps = (boxes: readonly Box[]) =>
  boxes.some((a, i) => boxes.some((b, j) => j > i && boxesHit(a, b)))

/** Each name shows somewhere: plain, in a callout or in a summary. */
function accounted(names: readonly Name3D[], l: NameLayout3D) {
  const inSummary = new Set(l.summaries.flatMap((s) => s.members))
  return names.every(
    (n) => l.plain.has(n.id) || l.callouts.has(n.id) || inSummary.has(n.id)
  )
}

describe("layoutNames3D", () => {
  it("keeps every plate over its rack when the row has room", () => {
    const names = row(6, 120)
    const l = layoutNames3D(names, { view, callouts: true, plateSize })
    expect(l.plain.size).toBe(6)
    expect(l.callouts.size).toBe(0)
    expect(l.summaries).toEqual([])
  })

  it("calls out a row of adjacent racks whose plates touch", () => {
    // Plates ~70 px wide, 60 px apart: neighbours overlap.
    const names = row(6, 60)
    const l = layoutNames3D(names, { view, callouts: true, plateSize })
    expect(l.callouts.size).toBe(6)
    expect(l.plain.size).toBe(0)
    expect(overlaps(drawn(names, l))).toBe(false)
    for (const [id, c] of l.callouts) {
      const n = names.find((x) => x.id === id)!
      // The leader runs back to its own rack.
      const end = c.leader[1]
      expect(Math.hypot(end[0] - n.x, end[1] - n.y)).toBeLessThan(4)
      const len = Math.hypot(
        c.leader[1][0] - c.leader[0][0],
        c.leader[1][1] - c.leader[0][1]
      )
      expect(len).toBeLessThanOrEqual(CALLOUT_MAX_LEADER * 2 + 1e-6)
    }
  })

  it("summarises a far row whose callouts would not reach", () => {
    // Seven racks 20 px apart: plates pile on each other.
    const names = row(7, 20)
    const l = layoutNames3D(names, { view, callouts: true, plateSize })
    expect(overlaps(drawn(names, l))).toBe(false)
    expect(accounted(names, l)).toBe(true)
    // Called out whole, or folded whole - never two plates and the rest gone.
    if (l.summaries.length) {
      expect(l.summaries).toHaveLength(1)
      expect(l.summaries[0].name).toBe("RACK-01–RACK-07")
      expect(l.callouts.size).toBe(0)
    } else expect(l.callouts.size).toBe(7)
  })

  it("folds a crowd past the callout limit into one plate", () => {
    const names = row(MAX_CALLOUT_CROWD + 4, 8)
    const l = layoutNames3D(names, { view, callouts: true, plateSize })
    expect(l.summaries).toHaveLength(1)
    expect(l.summaries[0].members).toHaveLength(names.length)
    expect(l.plain.size).toBe(0)
    expect(overlaps(drawn(names, l))).toBe(false)
  })

  it("counts a mixed crowd and keeps the selected on its own plate", () => {
    const names = row(MAX_CALLOUT_CROWD + 2, 8).map((n, i) =>
      i === 0 ? { ...n, name: "CORE", pinned: true } : n
    )
    const l = layoutNames3D(names, { view, callouts: true, plateSize })
    expect(l.plain.has("r1")).toBe(true)
    expect(l.summaries).toHaveLength(1)
    expect(l.summaries[0].members).not.toContain("r1")
    expect(l.summaries[0].name).toBe("RACK-02–RACK-10")
    expect(overlaps(drawn(names, l))).toBe(false)
  })

  it("names a crowd of different kinds by its count", () => {
    const names = row(MAX_CALLOUT_CROWD + 2, 8).map((n, i) =>
      i === 3 ? { ...n, name: "PDU A", kind: "device", icon: "plug" } : n
    )
    const l = layoutNames3D(names, { view, callouts: true, plateSize })
    expect(l.summaries[0].name).toBe(`${names.length} objects`)
    expect(l.summaries[0].icon).toBe("layers")
  })

  it("with Callouts off only thins, and still never overlaps", () => {
    const names = row(7, 20)
    const l = layoutNames3D(names, { view, callouts: false, plateSize })
    expect(l.callouts.size).toBe(0)
    expect(l.summaries).toEqual([])
    expect(l.plain.size).toBeGreaterThan(0)
    expect(overlaps(drawn(names, l))).toBe(false)
  })

  it("leaves a calm row alone beside a crowded one", () => {
    const names = [
      ...row(4, 140, { y: 200 }).map((n) => ({ ...n, id: `a${n.id}` })),
      ...row(6, 30, { y: 600 }),
    ]
    const l = layoutNames3D(names, { view, callouts: true, plateSize })
    for (const id of ["ar1", "ar2", "ar3", "ar4"])
      expect(l.plain.has(id)).toBe(true)
    expect(overlaps(drawn(names, l))).toBe(false)
    expect(accounted(names, l)).toBe(true)
  })

  it("is the same however often it is asked", () => {
    const names = row(6, 40)
    const a = layoutNames3D(names, { view, callouts: true, plateSize })
    const b = layoutNames3D(names, { view, callouts: true, plateSize })
    expect([...b.callouts]).toEqual([...a.callouts])
    expect(b.summaries).toEqual(a.summaries)
  })
})
