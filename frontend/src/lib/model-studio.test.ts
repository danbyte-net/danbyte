import { describe, expect, it } from "vitest"

import {
  PORT_BOX_MM,
  faceFrame,
  faceImagePx,
  faceOf,
  fitWindow,
  generatedImagePorts,
  imageLedsFromBoxes,
  imagePortsFromAnchors,
  ledSource,
  nearestFace,
  openingExtent,
  openingFromExtras,
  overwriteList,
  portBoxKind,
  projectToFace,
} from "./model-studio"

// A 1U 19-inch switch: 482.6 mm across the ears, 44.45 mm high.
const frame = faceFrame([482.6, 44.45], 0.044)

describe("faceFrame", () => {
  it("takes the server's frame in metres", () => {
    expect(frame.w).toBeCloseTo(0.4826)
    expect(frame.h).toBeCloseTo(0.04445)
  })
  it("falls back to the model's height without rack units", () => {
    expect(faceFrame([200, null], 0.3).h).toBe(0.3)
  })
  it("sizes a face image by its aspect, long edge 2000", () => {
    expect(faceImagePx(frame)).toEqual([2000, 184])
    expect(faceImagePx({ w: 0.1, h: 0.4 })).toEqual([500, 2000])
  })
})

describe("faces", () => {
  it("picks the face a port points out of", () => {
    expect(faceOf([0, 0, -1])).toBe("front")
    expect(faceOf([0, 0, 1])).toBe("rear")
    expect(faceOf([0, 1, 0])).toBeNull()
    expect(faceOf([0.8, 0, -0.6])).toBe("front")
    expect(faceOf([0, 0, 0])).toBeNull()
  })
  it("puts an LED on the nearer face plane", () => {
    expect(nearestFace([0, 0, -0.229], 0.46)).toBe("front")
    expect(nearestFace([0, 0, 0.22], 0.46)).toBe("rear")
    expect(nearestFace([0, 0, 0], 0.46)).toBeNull()
  })
})

describe("projectToFace", () => {
  it("mirrors X between the faces", () => {
    // +X in the room is on the left seen from the front, right from behind.
    const p: [number, number, number] = [0.2, 0.0222, -0.23]
    const f = projectToFace(p, "front", frame)
    const r = projectToFace(p, "rear", frame)
    expect(f.x).toBeCloseTo((0.2413 - 0.2) / 0.4826)
    expect(r.x).toBeCloseTo((0.2413 + 0.2) / 0.4826)
    expect(f.y).toBeCloseTo(0.5, 2)
    expect(r.y).toBeCloseTo(f.y)
  })
  it("maps the frame's corners to 0 and 1", () => {
    const tl = projectToFace([0.2413, 0.04445, 0], "front", frame)
    expect(tl.x).toBeCloseTo(0)
    expect(tl.y).toBeCloseTo(0)
    const br = projectToFace([-0.2413, 0, 0], "front", frame)
    expect(br.x).toBeCloseTo(1)
    expect(br.y).toBeCloseTo(1)
  })
})

describe("port box sizes", () => {
  it("reads the cage from the type slug", () => {
    expect(portBoxKind("interface", "25gbase-x-sfp28")).toBe("sfp")
    expect(portBoxKind("interface", "10gbase-x-sfpp")).toBe("sfp")
    expect(portBoxKind("interface", "100gbase-x-qsfp28")).toBe("qsfp")
    expect(portBoxKind("interface", "400gbase-x-osfp")).toBe("osfp")
    expect(portBoxKind("interface", "1000base-t")).toBe("rj45")
    expect(portBoxKind("interface", "10gbase-t")).toBe("rj45")
    expect(portBoxKind("console-port", "usb-mini-b")).toBe("usb")
    expect(portBoxKind("console-port", "rj-45")).toBe("rj45")
    expect(portBoxKind("console-port", "")).toBe("rj45")
    expect(portBoxKind("power-port", "iec-60320-c16")).toBe("iec")
    expect(portBoxKind("power-port", "iec-60320-c20")).toBe("iec_c20")
    expect(portBoxKind("front-port", "lc")).toBe("lc")
    expect(portBoxKind("interface", "")).toBe("other")
  })
  it("keeps every box a plausible face size", () => {
    for (const [w, h] of Object.values(PORT_BOX_MM)) {
      expect(w).toBeGreaterThan(3)
      expect(h).toBeGreaterThan(3)
      expect(w).toBeLessThan(50)
    }
  })
})

describe("imagePortsFromAnchors", () => {
  const index = {
    "TwentyFiveGigE1/0/1": ["interface", "25gbase-x-sfp28"] as const,
    "GigabitEthernet0/0": ["interface", "1000base-t"] as const,
    PSU0: ["power-port", "iec-60320-c16"] as const,
  }
  it("places each port on its face, sized by its cage", () => {
    const out = imagePortsFromAnchors(
      [
        { name: "TwentyFiveGigE1/0/1", p: [0, 0.0222, -0.23], n: [0, 0, -1] },
        { name: "PSU0", p: [0.1, 0.02, 0.23], n: [0, 0, 1] },
        { name: "Nope", p: [0, 0.02, -0.23], n: [0, 0, -1] },
        { name: "Up", p: [0, 0.044, 0], n: [0, 1, 0] },
        { name: "TwentyFiveGigE1/0/1", p: [0, 0, -0.23], n: [0, 0, -1] },
      ],
      index,
      frame
    )
    expect(out.doc.front.map((m) => m.name)).toEqual([
      "TwentyFiveGigE1/0/1",
      "Nope",
    ])
    expect(out.doc.rear).toHaveLength(1)
    const sfp = out.doc.front[0]
    expect(sfp.kind).toBe("interface")
    expect(sfp.x).toBeCloseTo(0.5)
    expect(sfp.w).toBeCloseTo(0.014 / 0.4826, 4)
    expect(sfp.h).toBeCloseTo(0.0095 / 0.04445, 4)
    expect(out.doc.rear[0].kind).toBe("power-port")
    expect(out.unknown).toEqual(["Nope"])
    expect(out.offFace).toEqual(["Up"])
  })
  it("uses the model's exact opening over the type's box", () => {
    const out = imagePortsFromAnchors(
      [
        {
          name: "TwentyFiveGigE1/0/1",
          p: [0, 0.0222, -0.23],
          n: [0, 0, -1],
          size: [0.0131, 0.0088],
          u: [-1, 0, 0],
        },
        // Stood on its side: width runs up the face.
        {
          name: "GigabitEthernet0/0",
          p: [0.05, 0.0222, -0.23],
          n: [0, 0, -1],
          size: [0.0131, 0.0088],
          u: [0, 1, 0],
        },
      ],
      index,
      frame
    )
    const [flat, side] = out.doc.front
    expect(flat.w).toBeCloseTo(0.0131 / 0.4826, 4)
    expect(flat.h).toBeCloseTo(0.0088 / 0.04445, 4)
    expect(side.w).toBeCloseTo(0.0088 / 0.4826, 4)
    expect(side.h).toBeCloseTo(0.0131 / 0.04445, 4)
  })
  it("drops points outside the frame", () => {
    const out = imagePortsFromAnchors(
      [{ name: "Far", p: [0.5, 0.02, -0.23], n: [0, 0, -1] }],
      index,
      frame
    )
    expect(out.doc.front).toHaveLength(0)
    expect(out.offFace).toEqual(["Far"])
  })
})

describe("LEDs", () => {
  const leds = {
    SYS: { source: "device.status" },
    "port:*": { source: "interface.oper_status" },
  }
  it("binds by id, port LEDs by the wildcard", () => {
    expect(ledSource("SYS", leds)).toBe("device.status")
    expect(ledSource("port:Te1/0/1", leds)).toBe("interface.oper_status")
    expect(ledSource("FAN", leds)).toBeUndefined()
    expect(ledSource("SYS", null)).toBeUndefined()
  })
  it("projects each LED's box onto its face", () => {
    const out = imageLedsFromBoxes(
      [
        { id: "SYS", min: [0.19, 0.03, -0.23], max: [0.194, 0.034, -0.229] },
        {
          id: "PS_OK",
          bay: "PS-0",
          min: [0.1, 0.01, 0.228],
          max: [0.104, 0.013, 0.23],
        },
        { id: "INSIDE", min: [0, 0.02, -0.01], max: [0.01, 0.03, 0.01] },
      ],
      (l) => (l.bay ? "module.status" : ledSource(l.id, leds)),
      frame,
      0.46
    )
    expect(out.doc.front).toHaveLength(1)
    const sys = out.doc.front[0]
    expect(sys).toMatchObject({
      kind: "led",
      name: "SYS",
      source: "device.status",
    })
    expect(sys.x).toBeCloseTo((0.2413 - 0.192) / 0.4826, 4)
    expect(sys.w).toBeCloseTo(0.004 / 0.4826, 4)
    expect(out.doc.rear[0]).toMatchObject({
      name: "PS_OK",
      bay: "PS-0",
      source: "module.status",
    })
    expect(out.offFace).toEqual(["INSIDE"])
  })
})

describe("fitWindow", () => {
  it("holds every point at the aspect, centred", () => {
    const [l, r, t, b] = fitWindow(
      [
        [-2, -1, 0],
        [2, 1, 0],
      ],
      4 / 3,
      0
    )
    expect(r - l).toBeCloseTo(4)
    expect(t - b).toBeCloseTo(3)
    expect((l + r) / 2).toBeCloseTo(0)
    expect((t + b) / 2).toBeCloseTo(0)
  })
})

describe("never overwrite by hand-made", () => {
  it("names only the ticked hand-made targets", () => {
    expect(overwriteList(["front", "image_ports"], new Set())).toEqual([])
    expect(
      overwriteList(["front", "image_ports"], new Set(["image_ports", "iso"]))
    ).toEqual(["image_ports"])
  })
  it("calibrates generated faces to the frame's width", () => {
    const doc = generatedImagePorts({ front: [], rear: [] }, 482.6)
    expect(doc.view?.front?.cal).toEqual({
      left: 0,
      right: 1,
      span_mm: 482.6,
      rail: null,
    })
  })
})

describe("opening size extras", () => {
  it("reads danbyte_w / danbyte_h / danbyte_r as the server's scan does", () => {
    expect(
      openingFromExtras({
        danbyte_w: 0.0142,
        danbyte_h: 0.0095,
        danbyte_r: 0.0005,
      })
    ).toEqual({ w: 0.0142, h: 0.0095, r: 0.0005 })
    expect(
      openingFromExtras({ danbyte_w: 0.01, danbyte_h: 0.004, danbyte_r: 1 })
    ).toEqual({ w: 0.01, h: 0.004, r: 0.002 })
    expect(openingFromExtras({ danbyte_w: 0.01, danbyte_h: 0.01 })?.r).toBe(0)
  })
  it("ignores missing or out-of-range sizes (the table applies)", () => {
    for (const e of [
      null,
      {},
      { danbyte_w: 0.01 },
      { danbyte_w: "0.01", danbyte_h: 0.01 },
      { danbyte_w: 0.01, danbyte_h: -1 },
      { danbyte_w: 2, danbyte_h: 0.01 },
    ])
      expect(openingFromExtras(e)).toBeNull()
  })
  it("spans a turned opening's box on the face", () => {
    expect(openingExtent([1, 0, 0], [0, 0, -1], 0.014, 0.01)).toEqual([
      0.014, 0.01,
    ])
    const [x, y] = openingExtent([0, 1, 0], [0, 0, -1], 0.014, 0.01)
    expect(x).toBeCloseTo(0.01)
    expect(y).toBeCloseTo(0.014)
  })
})
