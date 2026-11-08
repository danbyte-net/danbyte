import { describe, expect, it } from "vitest"

import {
  MODEL_PORT_UNDEFINED,
  PORT_MARKER_HIDE_M,
  PORT_MARKER_SHOW_M,
  denormalisePoint,
  historyOf,
  markersVisible,
  modelPortHex,
  nextUnmapped,
  normalisePoint,
  photoToModel,
  placePorts,
  portFromHit,
  portKey,
  portLocal,
  portsFromPhotos,
  pushHistory,
  redo,
  rowFill,
  runBetween,
  savePayload,
  similarBounds,
  undo,
} from "./model-ports"
import type { ModelPort, V3 } from "./model-ports"

const gi = (n: number) => `Gi1/0/${n}`
const names = (n: number) => Array.from({ length: n }, (_, i) => gi(i + 1))

describe("normalised positions", () => {
  const min: V3 = [-0.2, 0, -0.1]
  const max: V3 = [0.2, 0.05, 0.1]

  it("map the upright box to 0..1 and back", () => {
    expect(normalisePoint([0, 0.025, -0.1], min, max)).toEqual([0.5, 0.5, 0])
    expect(denormalisePoint([0.25, 1, 1], min, max)).toEqual([-0.1, 0.05, 0.1])
  })

  it("clamp a point outside the box", () => {
    expect(normalisePoint([1, -1, 0], min, max)).toEqual([1, 0, 0.5])
  })

  it("turn a raycast hit into a port with a unit normal", () => {
    const hit = portFromHit(
      { point: [0.1, 0.0125, -0.1], normal: [0, 0, -2] },
      min,
      max
    )
    expect(hit).toEqual({ p: [0.75, 0.25, 0], n: [0, 0, -1] })
  })

  it("place in the room's fitted frame: centred, standing on y = 0", () => {
    expect(portLocal([0.5, 0, 0], [0.44, 0.044, 0.3])).toEqual([0, 0, -0.15])
    expect(portLocal([1, 1, 1], [0.44, 0.044, 0.3])).toEqual([
      0.22, 0.044, 0.15,
    ])
  })
})

describe("row fill", () => {
  const a = { p: [0.9, 0.7, 0] as V3, n: [0, 0, -1] as V3 }
  const b = { p: [0.1, 0.3, 0] as V3, n: [0, 0, -1] as V3 }

  it("one row spaces the run evenly from first to last", () => {
    const run = rowFill(
      { p: [0.9, 0.5, 0], n: [0, 0, -1] },
      { p: [0.1, 0.5, 0], n: [0, 0, -1] },
      names(5),
      "interface",
      1
    )
    expect(run.map((r) => r.name)).toEqual(names(5))
    expect(run.map((r) => r.p[0])).toEqual([0.9, 0.7, 0.5, 0.3, 0.1])
    expect(run.every((r) => r.p[1] === 0.5)).toBe(true)
  })

  it("two rows put odd ports on the first's row, even on the last's", () => {
    const run = rowFill(a, b, names(24), "interface", 2)
    expect(run).toHaveLength(24)
    const odd = run.filter((_, i) => i % 2 === 0)
    const even = run.filter((_, i) => i % 2 === 1)
    expect(odd.every((r) => r.p[1] === 0.7)).toBe(true)
    expect(even.every((r) => r.p[1] === 0.3)).toBe(true)
    // Twelve columns from a's x to b's.
    expect(odd[0].p[0]).toBe(0.9)
    expect(even[11].p[0]).toBe(0.1)
    expect(odd[11].p[0]).toBe(0.1)
    expect(even[0].p[0]).toBe(0.9)
    // Gi1/0/1 over Gi1/0/2, one column per pair.
    expect(run[0].p[0]).toBe(run[1].p[0])
  })

  it("two rows with an odd count leave the last column half full", () => {
    const run = rowFill(a, b, names(7), "interface", 2)
    expect(run[6].p).toEqual([0.1, 0.7, 0])
    expect(run[5].p).toEqual([0.36667, 0.3, 0])
  })

  it("an empty run fills nothing", () => {
    expect(rowFill(a, b, [], "interface", 2)).toEqual([])
  })

  it("the run between two ports follows natural order, either way", () => {
    const all = [gi(10), gi(2), gi(1), gi(3)]
    expect(runBetween(all, gi(1), gi(3))).toEqual([gi(1), gi(2), gi(3)])
    expect(runBetween(all, gi(10), gi(2))).toEqual([gi(10), gi(3), gi(2)])
    expect(runBetween(all, gi(1), "x")).toEqual([])
  })
})

describe("photo ports as a start", () => {
  it("project the front photo onto the front face, seen from in front", () => {
    expect(photoToModel({ x: 0.1, y: 0.25 }, "front")).toEqual({
      p: [0.9, 0.75, 0],
      n: [0, 0, -1],
    })
  })

  it("project the rear photo onto the back face, seen from behind", () => {
    expect(photoToModel({ x: 0.1, y: 0.25 }, "rear")).toEqual({
      p: [0.1, 0.75, 1],
      n: [0, 0, 1],
    })
  })

  it("copy only mappable kinds and skip what is mapped", () => {
    const marker = (kind: string, name: string) => ({
      kind,
      name,
      x: 0.5,
      y: 0.5,
      w: 0.03,
      h: 0.3,
    })
    const out = portsFromPhotos(
      {
        front: [marker("interface", "Gi1"), marker("inventory-item", "Disk 1")],
        rear: [marker("power-port", "PSU1"), marker("interface", "Gi2")],
      },
      [{ kind: "interface", name: "Gi2", p: [0, 0, 0], n: [0, 0, -1] }]
    )
    expect(out.map(portKey)).toEqual(["interface:Gi1", "power-port:PSU1"])
  })
})

describe("editor helpers", () => {
  const list = names(4).map((name) => ({ kind: "interface", name }))

  it("next unmapped wraps round and ends when all are mapped", () => {
    const mapped = new Set([portKey(list[1]), portKey(list[2])])
    expect(nextUnmapped(list, mapped, list[0])?.name).toBe(gi(4))
    expect(nextUnmapped(list, mapped, list[3])?.name).toBe(gi(1))
    expect(nextUnmapped(list, new Set(list.map(portKey)), null)).toBeNull()
  })

  it("placing a port again moves it", () => {
    const p: ModelPort = {
      kind: "interface",
      name: gi(1),
      p: [0, 0, 0],
      n: [0, 0, -1],
    }
    const moved = placePorts([p], [{ ...p, p: [1, 1, 1] }])
    expect(moved).toHaveLength(1)
    expect(moved[0].p).toEqual([1, 1, 1])
  })

  it("save sends the whole mapping and the version it opened at", () => {
    const body = savePayload(
      [0.4400001, 0.044, 0.3],
      [{ kind: "interface", name: gi(1), p: [0.5, 1.2, 0], n: [0, 0, -3] }],
      "abc"
    )
    expect(body).toEqual({
      version: "abc",
      model_ports: {
        bounds: [0.44, 0.044, 0.3],
        ports: [
          { kind: "interface", name: gi(1), p: [0.5, 1, 0], n: [0, 0, -1] },
        ],
      },
    })
    expect(savePayload([1, 1, 1], [], "v").model_ports).toBeNull()
  })

  it("undo and redo walk the history", () => {
    let h = historyOf<number[]>([])
    h = pushHistory(h, [1])
    h = pushHistory(h, [1, 2])
    h = undo(h)
    expect(h.present).toEqual([1])
    h = redo(h)
    expect(h.present).toEqual([1, 2])
    h = pushHistory(undo(h), [9])
    expect(h.future).toEqual([])
  })

  it("keeps a mapping across a model of the same proportions", () => {
    expect(similarBounds([0.44, 0.044, 0.3], [440, 44, 300])).toBe(true)
    expect(similarBounds([0.44, 0.044, 0.3], [0.44, 0.2, 0.3])).toBe(false)
    expect(similarBounds(null, [1, 1, 1])).toBe(false)
  })
})

describe("room markers", () => {
  it("show inside the near ring and hide past the far one", () => {
    expect(markersVisible(PORT_MARKER_SHOW_M - 0.1, false)).toBe(true)
    expect(markersVisible(PORT_MARKER_SHOW_M + 0.5, false)).toBe(false)
    // Between the rings: stay as they are.
    expect(markersVisible(PORT_MARKER_SHOW_M + 0.5, true)).toBe(true)
    expect(markersVisible(PORT_MARKER_HIDE_M + 0.1, true)).toBe(false)
  })

  it("colour by port state", () => {
    const fp = {
      id: "x",
      enabled: true,
      connected: false,
      speed: "",
      type: "",
    }
    expect(modelPortHex(null)).toBe(MODEL_PORT_UNDEFINED)
    expect(modelPortHex({ ...fp, id: null })).toBe(MODEL_PORT_UNDEFINED)
    const free = modelPortHex(fp)
    const cabled = modelPortHex({ ...fp, connected: true, speed: "10G" })
    const down = modelPortHex(fp, { oper_status: "down", admin_status: "up" })
    expect(new Set([free, cabled, down]).size).toBe(3)
    expect(modelPortHex({ ...fp, enabled: false })).not.toBe(cabled)
  })
})
