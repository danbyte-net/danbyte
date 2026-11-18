import { describe, expect, it } from "vitest"

import type { CordEnd, Vec3 } from "./cord-run"
import type { DeviceLeds } from "./led-state"
import {
  STACK_JACKET_MM,
  memberText,
  stackCableIds,
  stackLinkText,
  stackMembers,
  stackModeLeds,
  stackRadiusM,
  stackRunPoints,
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

  it("bows out behind the ports and never goes in front", () => {
    const pts = stackRunPoints(a, b)
    const depth = Math.max(...pts.map((p) => p[2]))
    expect(depth).toBeGreaterThan(0.05)
    expect(Math.min(...pts.map((p) => p[2]))).toBeGreaterThanOrEqual(0)
  })

  it("bows further for members further apart", () => {
    const far = end([0, -0.4, 0])
    const d = (q: CordEnd) => Math.max(...stackRunPoints(a, q).map((p) => p[2]))
    expect(d(far)).toBeGreaterThan(d(b))
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
})
