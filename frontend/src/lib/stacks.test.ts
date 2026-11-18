import { describe, expect, it } from "vitest"

import { dot, sub, tightestBend, unit } from "./cord-run"
import type { CordEnd, Vec3 } from "./cord-run"
import type { DeviceLeds } from "./led-state"
import {
  STACK_JACKET_MM,
  memberText,
  stackCableIds,
  stackLinkText,
  stackMembers,
  stackModeLeds,
  STACK_MIN_BEND_M,
  stackBendM,
  stackProfile,
  stackRadiusM,
  STACK_SAG_M,
  stackHangDir,
  stackRunPoints,
  straightened,
  withStackMode,
} from "./stacks"
import type { SceneStack } from "./stacks"

const dev = (over: Partial<DeviceLeds> = {}): DeviceLeds => ({
  leds: {},
  bays: {},
  locate: null,
  covers: ["Te1/0/1"],
  stack_covers: ["StackPort1/1"],
  stack_plugs: [
    {
      port: "StackPort1/1",
      bay: null,
      name: "StackPort2/1",
      color: null,
      transceiver_part: null,
      cord_part: null,
      derived: true,
    },
  ],
  ...over,
})

const end = (at: Vec3, z: Vec3 = [0, 0, 1]): CordEnd => ({
  at,
  x: [1, 0, 0],
  y: [0, 1, 0],
  z,
  scale: 1,
  cable: null,
})

const STACK: SceneStack = {
  id: "s",
  name: "STACK",
  master: "a",
  members: [
    { device: "a", name: "sw1", position: 1 },
    { device: "b", name: "sw2", position: 2 },
  ],
  links: [
    {
      a: { device: "a", port: "S1/1", name: "S1/1" },
      b: { device: "b", port: "S1/2", name: "S2/2" },
      derived: false,
      cable: "c1",
      color: null,
      label: "",
    },
  ],
}

describe("stacks mode", () => {
  it("shown or ghosted, a derived ring hides its covers too", () => {
    for (const mode of ["show", "ghost"] as const) {
      const d = withStackMode(dev(), mode)
      expect(d.covers).toEqual(["StackPort1/1", "Te1/0/1"])
      expect(d.stack_plugs).toHaveLength(1)
    }
  })

  it("hidden, the covers come back and the heads go", () => {
    const d = withStackMode(dev(), "hide")
    expect(d.covers).toEqual(["Te1/0/1"])
    expect(d.stack_plugs).toEqual([])
  })

  it("leaves a device outside a stack as it is", () => {
    const d = dev({ stack_covers: [], stack_plugs: [] })
    expect(withStackMode(d, "show")).toBe(d)
    expect(stackModeLeds({ x: d }, "hide").x).toBe(d)
  })
})

describe("stack facts", () => {
  it("names members, master and cables", () => {
    expect([...stackMembers([STACK], "s")]).toEqual(["a", "b"])
    expect(stackMembers([STACK], null).size).toBe(0)
    expect([...stackCableIds([STACK])]).toEqual(["c1"])
    expect(
      memberText({
        id: "s",
        name: "S",
        position: 1,
        master: true,
        master_name: "sw1",
      })
    ).toBe("Member 1 · master")
    expect(stackLinkText({ derived: true })).toBe(
      "Stack cable (derived from member order)"
    )
    expect(stackLinkText({ derived: false })).toBe("Stack cable")
    expect(stackLinkText({ derived: false, kind: "power" })).toBe(
      "StackPower cable"
    )
    expect(stackLinkText({ derived: true, kind: "power" })).toBe(
      "StackPower cable (derived from member order)"
    )
  })
})

describe("stack cable run", () => {
  // Two members one above the other, their stack ports at the back (+Z).
  const a = end([0, 0, 0])
  const b = end([0, -0.0445, 0])

  it("starts and ends at the ends", () => {
    const pts = stackRunPoints(a, b)
    expect(pts[0]).toEqual([0, 0, 0])
    expect(pts[pts.length - 1]).toEqual([0, -0.0445, 0])
  })

  it("hangs behind the ports and never goes in front", () => {
    const pts = stackRunPoints(a, b)
    expect(Math.max(...pts.map((p) => p[2]))).toBeGreaterThan(0.03)
    expect(Math.min(...pts.map((p) => p[2]))).toBeGreaterThanOrEqual(0)
    // The loop hangs below the lower end.
    expect(Math.min(...pts.map((p) => p[1]))).toBeLessThan(
      -0.0445 - STACK_SAG_M + 1e-9
    )
  })

  it("leaves each end along its +Z", () => {
    const down = unit([0, -1, 1])
    const ea = end([-0.05, 0, 0.04], down)
    const eb = end([0.05, -0.0445, 0.04], down)
    const pts = stackRunPoints(ea, eb)
    const first = unit(sub(pts[1], pts[0]))
    const last = unit(sub(pts[pts.length - 2], pts[pts.length - 1]))
    expect(dot(first, down)).toBeGreaterThan(0.999)
    expect(dot(last, down)).toBeGreaterThan(0.999)
  })

  // Three 1U members, 440 x 44.45 x 450 mm, their backs at z = 0; the
  // stack ports in the back, the heads' cable empties 40 mm out.
  const U = 0.04445
  const box = (k: number) => ({
    min: [-0.22, -k * U, -0.45] as Vec3,
    max: [0.22, -k * U + U, 0] as Vec3,
  })
  const inside = (p: Vec3, bx: { min: Vec3; max: Vec3 }) =>
    p.every((v, i) => v > bx.min[i] + 1e-9 && v < bx.max[i] - 1e-9)
  const port = (k: number, n: 1 | 2, z: Vec3 = [0, 0, 1]) =>
    end([n === 1 ? -0.06 : 0.06, -k * U + U / 2, 0.04], z)

  it("never passes through a member between adjacent members", () => {
    const boxes = [box(0), box(1), box(2)]
    for (const z of [
      [0, 0, 1],
      unit([0, -1, 0.3]),
      unit([0.3, -1, 0.5]),
    ] as Vec3[]) {
      // 1 -> 2, 2 -> 3 and the long return 3 -> 1.
      for (const [i, j] of [
        [0, 1],
        [1, 2],
        [2, 0],
      ]) {
        const pts = stackRunPoints(port(i, 1, z), port(j, 2, z))
        for (const p of pts)
          for (const bx of boxes) expect(inside(p, bx)).toBe(false)
      }
    }
  })

  it("bends no tighter than the head's bend where there is room", () => {
    const T: CordEnd["cable"] = {
      profile: "round",
      jacket_mm: 6,
      pitch_mm: null,
      min_bend_mm: 41,
    }
    const ea = { ...port(0, 1), cable: T }
    const eb = { ...port(1, 2), cable: T }
    const pts = stackRunPoints(ea, eb)
    expect(tightestBend(pts)).toBeGreaterThan(0.041 * 0.95)
    // Ends right above each other: the bottom is spread two bends wide,
    // its turns tighter but never a kink.
    const over = stackRunPoints(
      { ...end([0, 0, 0.04]), cable: T },
      { ...end([0, -U, 0.04]), cable: T }
    )
    expect(tightestBend(over)).toBeGreaterThan(0.041 * 0.5)
  })

  it("hangs in one plane behind the stack", () => {
    expect(stackHangDir(end([0, 0, 0]), end([0, -1, 0]))).toEqual([0, 0, 1])
    const turned = stackHangDir(
      end([0, 0, 0], unit([1, -1, 0])),
      end([0, 0, 0], unit([1, -1, 0]))
    )
    expect(turned[0]).toBeCloseTo(1)
    // Straight down: the level way falls back to +Z.
    expect(
      stackHangDir(end([0, 0, 0], [0, -1, 0]), end([0, 0, 0], [0, -1, 0]))
    ).toEqual([0, 0, 1])
  })

  it("drops points that make no turn", () => {
    expect(
      straightened([
        [0, 0, 0],
        [0, 0, 1],
        [0, 0, 2],
        [0, 0, 2],
        [0, -1, 2],
      ])
    ).toEqual([
      [0, 0, 0],
      [0, 0, 2],
      [0, -1, 2],
    ])
  })

  it("takes the head's jacket, else a plain one", () => {
    expect(stackRadiusM(a, b)).toBeCloseTo(STACK_JACKET_MM / 2000)
    const head = {
      ...a,
      cable: {
        profile: "round" as const,
        jacket_mm: 8,
        pitch_mm: null,
        min_bend_mm: 40,
      },
    }
    expect(stackRadiusM(head, b)).toBeCloseTo(0.004)
  })

  const head = (cable: CordEnd["cable"], at: Vec3 = [0, 0, 0]): CordEnd => ({
    ...end(at),
    cable,
  })
  const T1 = {
    profile: "ribbon" as const,
    count: 3,
    jacket_mm: 6.1,
    pitch_mm: 11.2,
    min_bend_mm: 41,
    min_bend_by_part: { "STACK-T1-3M": 82 },
  }

  it("draws the head's profile", () => {
    expect(stackProfile(a, b)).toEqual({
      kind: "round",
      radius: STACK_JACKET_MM / 2000,
    })
    const zip = { ...T1, profile: "zipcord" as const, count: undefined }
    const z = stackProfile(head(zip), b)
    expect(z.kind === "jackets" && z.count).toBe(2)
    const r = stackProfile(head(T1), head(T1, [0, -0.0445, 0]))
    expect(r.kind).toBe("jackets")
    if (r.kind !== "jackets") return
    expect(r.count).toBe(3)
    expect(r.pitch).toBeCloseTo(0.0112)
    expect(r.radius).toBeCloseTo(0.00305)
    expect(r.startUp).toEqual([0, 1, 0])
  })

  it("bends by the recorded cable's length, a derived one by the head's", () => {
    const h = head(T1)
    const recorded = { derived: false, label: "STACK-T1-3M" }
    expect(stackBendM(h, b, recorded)).toBeCloseTo(0.082)
    expect(
      stackBendM(h, b, { derived: true, label: "STACK-T1-3M" })
    ).toBeCloseTo(0.041)
    expect(
      stackBendM(h, b, { derived: false, label: "STACK-T1-1M" })
    ).toBeCloseTo(0.041)
    expect(stackBendM(h, b)).toBeCloseTo(0.041)
    expect(stackBendM(a, b, recorded)).toBe(STACK_MIN_BEND_M)
  })
})
