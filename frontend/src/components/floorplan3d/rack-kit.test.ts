import * as THREE from "three"
import { describe, expect, it } from "vitest"

import {
  buildKit,
  indexKit,
  mirroredGeometry,
  partName,
  wantedParts,
} from "./rack-kit"
import { LEGACY_LOOK  } from "./rack-kit-math"
import type {SceneLook} from "./rack-kit-math";

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
