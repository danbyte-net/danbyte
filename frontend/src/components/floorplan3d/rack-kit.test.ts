import * as THREE from "three"
import { describe, expect, it } from "vitest"

import {
  buildKit,
  indexKit,
  mirroredGeometry,
  partName,
  wantedParts,
} from "./rack-kit"
import { LEGACY_LOOK } from "./rack-kit-math"
import type { SceneLook } from "./rack-kit-math"

const LOOK: SceneLook = {
  ...LEGACY_LOOK,
  front_door: "split-perforated",
  rear_door: "solid",
  side_panels: true,
  top: "vented",
  base: "plinth",
  colour: "#c9ccce",
}

/** A part node as GLTFLoader leaves it: named, extras on userData. */
function part(
  name: string,
  size: [number, number, number],
  at: [number, number, number],
  extras: Record<string, unknown> = {},
  material = "FRAME"
) {
  const g = new THREE.Group()
  g.userData = { gltfName: name, ...extras }
  g.position.set(...at)
  const mat = new THREE.MeshStandardMaterial()
  mat.name = material
  g.add(new THREE.Mesh(new THREE.BoxGeometry(...size), mat))
  return g
}

/** A reference cabinet as the spec models it: glTF front +Z at z = 0,
 * 600 wide, 1000 deep, a 1U post segment and a door with its hinge. */
function kitScene() {
  const s = new THREE.Group()
  s.add(
    part("post:segment", [0.02, 0.04445, 0.02], [-0.28, 0.1 + 0.022225, -0.06])
  )
  s.add(
    part("beam:width", [0.56, 0.03, 0.02], [0, 1.95, -0.02], {
      danbyte_stretch: "x",
    })
  )
  s.add(
    part("top:vented", [0.6, 0.03, 1], [0, 1.985, -0.5], {
      danbyte_stretch: "xy",
    })
  )
  s.add(
    part("top:solid", [0.6, 0.03, 1], [0, 1.985, -0.5], {
      danbyte_stretch: "xy",
    })
  )
  s.add(
    part("base:plinth", [0.6, 0.1, 1], [0, 0.05, -0.5], {
      danbyte_stretch: "xy",
    })
  )
  s.add(
    part("side:panel", [0.01, 1.85, 1], [-0.295, 1.025, -0.5], {
      danbyte_stretch: "yz",
    })
  )
  const door = part("door:perforated", [0.58, 1.86, 0.01], [0, 1.03, 0.01], {
    danbyte_stretch: "xz",
  })
  const hinge = new THREE.Object3D()
  hinge.userData.gltfName = "hinge"
  hinge.position.set(-0.29, 0, 0)
  door.add(hinge)
  s.add(door)
  s.add(
    part("door:solid.001", [0.58, 1.86, 0.01], [0, 1.03, 0.01], {
      danbyte_stretch: "xz",
    })
  )
  s.updateMatrixWorld(true)
  return s
}

describe("kit parts", () => {
  it("drops Blender's numbered suffix", () => {
    expect(partName("door:solid.001")).toBe("door:solid")
    expect(partName("post:segment")).toBe("post:segment")
  })

  it("draws the parts the Look asks for", () => {
    const have = new Set([
      "top:vented",
      "top:solid",
      "base:plinth",
      "side:panel",
      "base:plate",
    ])
    const solid = wantedParts(LOOK, have, "solid")
    expect(solid.has("top:vented")).toBe(true)
    expect(solid.has("top:solid")).toBe(false)
    expect(solid.has("side:panel")).toBe(true)
    expect(wantedParts(LOOK, have, "cutaway").has("side:panel")).toBe(false)
    const fans = wantedParts({ ...LOOK, top: "fans" }, have, "solid")
    expect(fans.has("top:solid")).toBe(true)
    const two = wantedParts({ ...LOOK, frame: "2-post" }, have, "solid")
    expect(two.has("base:plate")).toBe(true)
    expect(two.has("top:vented")).toBe(false)
  })

  it("mirrors a geometry with its winding turned back", () => {
    const g = new THREE.BoxGeometry(1, 1, 1)
    const m = mirroredGeometry(g)
    expect(m).not.toBe(g)
    expect(mirroredGeometry(g)).toBe(m)
    const a = g.getIndex()!.array
    const b = m.getIndex()!.array
    expect([b[0], b[1], b[2]]).toEqual([a[0], a[2], a[1]])
  })
})

describe("buildKit", () => {
  const index = indexKit(kitScene())

  it("indexes parts in the rack frame (front on −Z)", () => {
    const seg = index.parts.find((p) => p.name === "post:segment")!
    // Modelled at glTF z = −0.06 (behind the front): the rack frame turns
    // it round, so it sits 0.06 behind the front plane at z = 0.
    expect(seg.box.getCenter(new THREE.Vector3()).z).toBeCloseTo(0.06)
    expect(
      index.parts.find((p) => p.name === "door:perforated")!.hinge
    ).not.toBeNull()
  })

  it("repeats the post per unit at four posts, in instanced draws", () => {
    const built = buildKit(
      index,
      "r1",
      LOOK,
      24,
      0.8,
      24 * 0.04445 + 0.13,
      1.2,
      "#c9ccce",
      "solid"
    )
    const posts = built.instanced.reduce((n, g) => n + g.matrices.length, 0)
    expect(posts).toBe(4 * 24)
    // Left and right posts draw from a plain and a mirrored geometry.
    expect(built.instanced.length).toBe(2)
    for (const g of built.instanced)
      for (const m of g.matrices) expect(m.determinant()).toBeGreaterThan(0)
    built.dispose()
  })

  it("stretches the frame to the rack and recolours FRAME", () => {
    const built = buildKit(
      index,
      "r1",
      LOOK,
      24,
      0.8,
      1.2,
      1.2,
      "#ff0000",
      "solid"
    )
    const sizes = built.plain.map((p) => {
      p.geometry.computeBoundingBox()
      return p.geometry.boundingBox!.clone().applyMatrix4(p.matrix)
    })
    const top = sizes.find((b) => b.max.y > 1.15 && b.max.z - b.min.z > 1)!
    expect(top.max.x - top.min.x).toBeCloseTo(0.8)
    // The beam keeps its 20 mm to each side.
    const beam = sizes.find((b) => b.max.y > 1.1 && b.max.z - b.min.z < 0.05)!
    expect(beam.max.x - beam.min.x).toBeCloseTo(0.76)
    expect(top.max.z - top.min.z).toBeCloseTo(1.2)
    // One side panel modelled, both drawn.
    const panels = sizes.filter((b) => b.max.x - b.min.x < 0.02)
    expect(panels).toHaveLength(2)
    const mat = built.plain[0].material as THREE.MeshStandardMaterial
    expect(mat.color.getHexString()).toBe("ff0000")
    built.dispose()
  })

  it("hangs split and solid doors as leaves on their hinges", () => {
    const built = buildKit(
      index,
      "r1",
      LOOK,
      24,
      0.8,
      1.2,
      1.2,
      "#c9ccce",
      "solid"
    )
    expect(built.doors.map((d) => d.id)).toEqual([
      "r1:front:0",
      "r1:front:1",
      "r1:rear:0",
    ])
    const [a, b] = built.doors
    expect(a.side).toBe("front")
    // Split: hinges at the two outer edges, leaves half the width each.
    expect(Math.sign(a.hingeX)).toBe(-Math.sign(b.hingeX))
    const leaf = a.draws[0].geometry
      .boundingBox!.clone()
      .applyMatrix4(a.draws[0].matrix)
    expect(leaf.max.x - leaf.min.x).toBeCloseTo(0.4, 1)
    expect(built.doors[2].z).toBeGreaterThan(0)
    const cut = buildKit(
      index,
      "r1",
      LOOK,
      24,
      0.8,
      1.2,
      1.2,
      "#c9ccce",
      "cutaway"
    )
    expect(cut.doors).toEqual([])
    built.dispose()
    cut.dispose()
  })
})

/** A part in the 1000 mm convention (§14 as packs deliver it): its node at
 * the part's start, the mesh 1 m along each stretch axis from there (glTF
 * x across, y up, depth toward −z), the other axes `size`. */
function part1000(
  name: string,
  stretch: string,
  size: [number, number, number],
  origin: [number, number, number]
) {
  const sx = stretch.includes("x") ? 1 : size[0]
  const sy = stretch.includes("z") ? 1 : size[1]
  const sz = stretch.includes("y") ? 1 : size[2]
  const g = new THREE.Group()
  g.userData = {
    gltfName: name,
    danbyte_stretch: stretch,
    danbyte_ref_mm: 1000,
  }
  g.position.set(...origin)
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(sx, sy, sz),
    new THREE.MeshStandardMaterial({ name: "FRAME" })
  )
  mesh.position.set(
    stretch.includes("x") ? sx / 2 : 0,
    stretch.includes("z") ? sy / 2 : 0,
    stretch.includes("y") ? -sz / 2 : 0
  )
  g.add(mesh)
  return g
}

/** The reference cabinet (600 × 1000, roof underside at 2.01 m) with its
 * parts as the cabinet kit delivers them. */
function kit1000() {
  const s = new THREE.Group()
  s.add(
    part("post:segment", [0.02, 0.04445, 0.02], [0.233, 0.13 + 0.022225, -0.1])
  )
  s.add(part1000("base:plinth", "xy", [0, 0.1, 0], [-0.3, 0.05, 0]))
  s.add(part1000("top:vented", "xy", [0, 0.01, 0], [-0.3, 2.015, 0]))
  s.add(part1000("beam:width", "x", [0, 0.03, 0.02], [-0.26, 1.97, -0.022]))
  s.add(part1000("beam:depth", "y", [0.02, 0.03, 0], [0.26, 1.97, -0.062]))
  s.add(part1000("side:panel", "yz", [0.01, 0, 0], [0.3, 0.1, 0]))
  const door = part1000("door:perforated", "xz", [0, 0, 0.022], [-0.3, 0.1, 0])
  const hinge = new THREE.Object3D()
  hinge.userData.gltfName = "hinge"
  door.add(hinge)
  s.add(door)
  s.add(part("door:handle", [0.02, 0.12, 0.03], [0.26, 1.1, 0.015]))
  s.updateMatrixWorld(true)
  return s
}

describe("kits in the 1000 mm convention", () => {
  const index = indexKit(kit1000(), 1)
  const box = (name: string) => index.parts.find((p) => p.name === name)!.box

  it("lays each stretched part out at its reference size", () => {
    expect(box("base:plinth").min.x).toBeCloseTo(-0.3)
    expect(box("base:plinth").max.x).toBeCloseTo(0.3)
    expect(box("base:plinth").max.z - box("base:plinth").min.z).toBeCloseTo(1)
    expect(box("beam:width").max.x - box("beam:width").min.x).toBeCloseTo(0.52)
    expect(box("beam:depth").min.z).toBeCloseTo(0.062)
    expect(box("beam:depth").max.z).toBeCloseTo(0.938)
    expect(box("side:panel").min.y).toBeCloseTo(0.1)
    expect(box("side:panel").max.y).toBeCloseTo(2.015)
    expect(
      box("door:perforated").max.x - box("door:perforated").min.x
    ).toBeCloseTo(0.6)
    expect(box("door:perforated").max.y).toBeCloseTo(2.015)
    expect(index.ref.max.x - index.ref.min.x).toBeCloseTo(0.6)
    expect(index.ref.max.z - index.ref.min.z).toBeCloseTo(1)
  })

  it("stretches a reference-size rack to exactly the reference", () => {
    const built = buildKit(
      index,
      "r",
      LOOK,
      42,
      0.6,
      2.02,
      1,
      "#c9ccce",
      "solid"
    )
    const plinth = built.plain
      .map((p) => p.geometry.boundingBox!.clone().applyMatrix4(p.matrix))
      .find((b) => b.max.y <= 0.1 + 1e-6 && b.max.x - b.min.x > 0.5)!
    expect(plinth.max.x - plinth.min.x).toBeCloseTo(0.6)
    expect(plinth.max.z - plinth.min.z).toBeCloseTo(1)
    built.dispose()
  })

  it("hangs split doors at half the width with handles at the meeting edge", () => {
    const built = buildKit(
      index,
      "r",
      LOOK,
      42,
      0.8,
      2.02,
      1.2,
      "#c9ccce",
      "solid"
    )
    const front = built.doors.filter((d) => d.side === "front")
    expect(front).toHaveLength(2)
    for (const leaf of front) {
      const boxes = leaf.draws.map((d) =>
        d.geometry.boundingBox!.clone().applyMatrix4(d.matrix)
      )
      const panel = boxes[0]
      expect(panel.max.x - panel.min.x).toBeCloseTo(0.4, 2)
      expect(panel.max.y - panel.min.y).toBeCloseTo(1.915, 2)
      const handle = boxes[boxes.length - 1]
      // Handle at its own size, near the centre line, away from the hinge.
      expect(handle.max.x - handle.min.x).toBeCloseTo(0.02, 3)
      const hx = (handle.min.x + handle.max.x) / 2
      expect(Math.abs(hx)).toBeLessThan(0.08)
      expect(Math.abs(hx - leaf.hingeX)).toBeGreaterThan(0.3)
    }
    built.dispose()
  })
})
