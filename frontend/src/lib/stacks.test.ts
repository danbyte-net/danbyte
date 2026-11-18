import { describe, expect, it } from "vitest"

import { dot, sub, tightestBend, unit } from "./cord-run"
import type { CordEnd, Vec3 } from "./cord-run"
import type { DeviceLeds } from "./led-state"
import {
  StackLinkStore,
  linkAtPort,
  partChoices,
  partLength,
  pathLength,
  recordPayload,
  shortPortName,
  stackCableGroups,
  stackLinkKey,
  stackLinkLine,
  stackRuns,
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
import type { SceneStack, StackLink } from "./stacks"

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

// ── picking, listing, lanes and lengths ──────────────────────────────────

const link = (
  a: [string, string],
  b: [string, string],
  over: Partial<StackLink> = {}
): StackLink => ({
  a: { device: a[0], port: a[1], name: a[1], id: `${a[0]}-${a[1]}` },
  b: { device: b[0], port: b[1], name: b[1], id: `${b[0]}-${b[1]}` },
  kind: "data",
  derived: true,
  cable: null,
  color: null,
  label: "",
  ...over,
})

const RING: SceneStack = {
  id: "s",
  name: "STACK",
  master: "m1",
  members: [
    { device: "m1", name: "sw1", position: 1 },
    { device: "m2", name: "sw2", position: 2 },
    { device: "m3", name: "sw3", position: 3 },
  ],
  links: [
    link(["m1", "StackPort1/1"], ["m2", "StackPort2/2"]),
    link(["m2", "StackPort2/1"], ["m3", "StackPort3/2"]),
    link(["m3", "StackPort3/1"], ["m1", "StackPort1/2"]),
    link(["m1", "StackPower1/B"], ["m2", "StackPower2/A"], { kind: "power" }),
    link(["m2", "StackPower2/B"], ["m3", "StackPower3/A"], { kind: "power" }),
    link(["m3", "StackPower3/B"], ["m1", "StackPower1/A"], { kind: "power" }),
  ],
}

describe("stack cable list", () => {
  it("labels a cable by its ports' short names", () => {
    expect(shortPortName("StackPort1/1")).toBe("1/1")
    expect(shortPortName("StackPower2/A")).toBe("2/A")
    expect(shortPortName("vcp-255/1/0")).toBe("255/1/0")
    expect(shortPortName("1/1/49")).toBe("1/1/49")
    expect(shortPortName("Stack")).toBe("Stack")
    expect(stackLinkLine(RING.links[0])).toBe("1/1 → 2/2")
  })

  it("groups Stack then StackPower, naming the stack when there are more", () => {
    const one = stackCableGroups([RING])
    expect(one.map((g) => [g.title, g.rows.map((r) => r.line)])).toEqual([
      ["Stack", ["1/1 → 2/2", "2/1 → 3/2", "3/1 → 1/2"]],
      ["StackPower", ["1/B → 2/A", "2/B → 3/A", "3/B → 1/A"]],
    ])
    const other = { ...RING, id: "t", name: "B", links: RING.links.slice(0, 1) }
    expect(stackCableGroups([RING, other]).map((g) => g.title)).toEqual([
      "STACK · Stack",
      "STACK · StackPower",
      "B · Stack",
    ])
    expect(stackCableGroups([{ ...RING, links: [] }])).toEqual([])
  })

  it("finds the cable at a port by name or anchor", () => {
    expect(linkAtPort([RING], "m2", "StackPort2/1")).toBe(RING.links[1])
    expect(linkAtPort([RING], "m2", "StackPort2/2")).toBe(RING.links[0])
    expect(linkAtPort([RING], "m2", "Te1/0/1")).toBeNull()
  })
})

describe("picking a stack cable", () => {
  const k = RING.links.map(stackLinkKey)

  it("toggles, previews and clears", () => {
    const s = new StackLinkStore()
    s.setStacks([RING])
    expect(s.look(k[0])).toBeNull()
    s.toggle(k[0])
    expect(s.active).toBe(k[0])
    expect(s.look(k[0])).toBe("active")
    expect(s.look(k[1])).toBe("dim")
    // A row's hover previews another; leaving it brings the pick back.
    s.setPreview(k[1])
    expect(s.active).toBe(k[1])
    s.setPreview(null)
    expect(s.active).toBe(k[0])
    // Clicking it again lets it go.
    s.toggle(k[0])
    expect(s.active).toBeNull()
    s.select(k[2])
    s.clear()
    expect(s.selected).toBeNull()
  })

  it("picks a port's cable and notifies", () => {
    const s = new StackLinkStore()
    let n = 0
    s.subscribe(() => n++)
    s.setStacks([RING])
    expect(s.selectPort("m3", "StackPower3/A")).toBe(true)
    expect(s.selected).toBe(k[4])
    expect(s.selectPort("m3", "nope")).toBe(false)
    expect(s.selected).toBe(k[4])
    expect(n).toBeGreaterThan(1)
  })

  it("lets go of a cable no longer drawn", () => {
    const s = new StackLinkStore()
    s.setStacks([RING])
    s.select(k[0])
    s.setStacks([{ ...RING, links: RING.links.slice(1) }])
    expect(s.selected).toBeNull()
  })

  it("opens Record cable for keys", () => {
    const s = new StackLinkStore()
    s.record([k[0], k[1]])
    expect(s.recording).toEqual([k[0], k[1]])
    s.record([])
    expect(s.recording).toBeNull()
  })
})

describe("recording a derived cable", () => {
  it("reads a length from a part number", () => {
    expect(partLength("STACK-T1-50CM")).toEqual({ length: 50, unit: "cm" })
    expect(partLength("STACK-T1-1M")).toEqual({ length: 1, unit: "m" })
    expect(partLength("STACK-T1-3M=")).toEqual({ length: 3, unit: "m" })
    expect(partLength("CAB-SPWR-150CM")).toEqual({ length: 150, unit: "cm" })
    expect(partLength("CAB-SPWR-30cm")).toEqual({ length: 30, unit: "cm" })
    expect(partLength("STACK-T1")).toBeNull()
    expect(partLength("C9300M")).toBeNull()
  })

  it("offers the readable parts, shortest first", () => {
    expect(
      partChoices(["STACK-T1-3M", "ODD", "STACK-T1-50CM", "STACK-T1-1M"]).map(
        (c) => c.part
      )
    ).toEqual(["STACK-T1-50CM", "STACK-T1-1M", "STACK-T1-3M"])
    expect(partChoices(undefined)).toEqual([])
  })

  it("builds the cable create payload", () => {
    expect(
      recordPayload(RING.links[0], {
        part: " STACK-T1-50CM ",
        length: "50",
        unit: "cm",
      })
    ).toEqual({
      a: [{ kind: "interface", id: "m1-StackPort1/1" }],
      b: [{ kind: "interface", id: "m2-StackPort2/2" }],
      label: "STACK-T1-50CM",
      length: "50",
      length_unit: "cm",
      type: "",
    })
    const power = recordPayload(RING.links[3], {
      part: "",
      length: "",
      unit: "",
    })
    expect(power.a[0].kind).toBe("power_port")
    expect(power.type).toBe("power")
    expect(power.length).toBeNull()
    expect(power.length_unit).toBe("m")
  })
})

describe("stack cables lie beside each other", () => {
  // Three 1U members as above; data ports at x ±0.06, StackPower at
  // x 0.12 / 0.16, their cable empties 40 mm out of the back.
  const U = 0.04445
  const at = (k: number, x: number): CordEnd => end([x, -k * U + U / 2, 0.04])
  const ends: Record<string, CordEnd> = {}
  for (let k = 0; k < 3; k++) {
    const m = `m${k + 1}`
    ends[`${m}:StackPort${k + 1}/1`] = at(k, -0.06)
    ends[`${m}:StackPort${k + 1}/2`] = at(k, 0.06)
    ends[`${m}:StackPower${k + 1}/A`] = at(k, 0.12)
    ends[`${m}:StackPower${k + 1}/B`] = at(k, 0.16)
  }
  const inputs = (links: readonly StackLink[]) =>
    links.map((l) => ({
      key: stackLinkKey(l),
      a: ends[`${l.a.device}:${l.a.name}`],
      b: ends[`${l.b.device}:${l.b.name}`],
      link: l,
    }))
  /** Points every `step` along a polyline. */
  const sample = (pts: readonly Vec3[], step = 0.002): Vec3[] => {
    const out: Vec3[] = []
    for (let i = 1; i < pts.length; i++) {
      const d = sub(pts[i], pts[i - 1])
      const n = Math.max(1, Math.ceil(Math.hypot(...d) / step))
      for (let j = 0; j < n; j++)
        out.push([
          pts[i - 1][0] + (d[0] * j) / n,
          pts[i - 1][1] + (d[1] * j) / n,
          pts[i - 1][2] + (d[2] * j) / n,
        ])
    }
    return out
  }

  it("keeps every two cables a jacket apart", () => {
    const runs = stackRuns(inputs(RING.links))
    expect(runs.size).toBe(6)
    const r = STACK_JACKET_MM / 2000
    const keys = [...runs.keys()]
    for (let i = 0; i < keys.length; i++)
      for (let j = i + 1; j < keys.length; j++) {
        // Leave out each run's lead out of its own head.
        const p = sample(runs.get(keys[i])!).filter((q) => q[2] > 0.075)
        const q = sample(runs.get(keys[j])!).filter((x) => x[2] > 0.075)
        let min = Infinity
        for (const u of p)
          for (const v of q) min = Math.min(min, Math.hypot(...sub(u, v)))
        expect(min, `${keys[i]} / ${keys[j]}`).toBeGreaterThanOrEqual(
          2 * r - 1e-6
        )
      }
  })

  it("never puts a lane inside a member", () => {
    const box = (k: number) => ({
      min: [-0.22, -k * U, -0.45] as Vec3,
      max: [0.22, -k * U + U, 0] as Vec3,
    })
    const runs = stackRuns(inputs(RING.links))
    for (const pts of runs.values())
      for (const p of sample(pts))
        for (const k of [0, 1, 2]) {
          const bx = box(k)
          expect(
            p.every((v, i) => v > bx.min[i] + 1e-9 && v < bx.max[i] - 1e-9)
          ).toBe(false)
        }
  })

  it("is the same on every render, whatever the order", () => {
    const one = stackRuns(inputs(RING.links))
    const two = stackRuns(inputs([...RING.links].reverse()))
    for (const [k, v] of one) expect(two.get(k)).toEqual(v)
  })

  it("hangs a recorded cable to its length, a longer one lower", () => {
    const l = (m: number) =>
      link(["m1", "StackPort1/1"], ["m2", "StackPort2/2"], {
        derived: false,
        length_m: m,
      })
    const a = ends["m1:StackPort1/1"]
    const b = ends["m2:StackPort2/2"]
    const half = stackRunPoints(a, b, l(0.5))
    const one = stackRunPoints(a, b, l(1))
    expect(pathLength(half)).toBeGreaterThan(0.5 * 0.97)
    expect(pathLength(half)).toBeLessThan(0.5 * 1.03)
    expect(pathLength(one)).toBeGreaterThan(1 * 0.97)
    expect(pathLength(one)).toBeLessThan(1 * 1.03)
    const low = (p: Vec3[]) => Math.min(...p.map((q) => q[1]))
    expect(low(one)).toBeLessThan(low(half))
    // Too short to reach: the shortest run, never shorter.
    const short = stackRunPoints(a, b, l(0.01))
    expect(short).toEqual(stackRunPoints(a, b))
    // Very long: the sag stops, the rest lies back along the bottom.
    const long = stackRunPoints(a, b, l(3))
    expect(pathLength(long)).toBeGreaterThan(3 * 0.97)
    expect(low(long)).toBeGreaterThan(-0.022 - 0.6 - 0.05)
    // A derived link keeps the default sag whatever it says.
    expect(stackRunPoints(a, b, { ...l(3), derived: true })).toEqual(
      stackRunPoints(a, b)
    )
  })
})
