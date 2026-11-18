import * as THREE from "three"
import { describe, expect, it } from "vitest"

import {
  buildKit,
  indexKit,
  mirroredGeometry,
  partName,
  seeThrough,
  unitNumber,
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

/** A post segment as a pack delivers it (KHR_mesh_quantization): unsigned
 * short positions, normalised byte normals, dequantized by its node. */
function quantizedSegment() {
  const g = new THREE.Group()
  g.userData = { gltfName: "post:segment" }
  g.position.set(0.2326, 0.13, -0.1)
  const box = new THREE.BoxGeometry(0.035, 0.04445, 0.04).toNonIndexed()
  box.translate(0.0175, 0.022225, -0.02)
  const q = 1 / 65535
  const pos = box.getAttribute("position")
  const qpos = new Uint16Array(pos.count * 3)
  for (let i = 0; i < pos.count; i++) {
    qpos[i * 3] = Math.round((pos.getX(i) + 0.1) / q / 10)
    qpos[i * 3 + 1] = Math.round((pos.getY(i) + 0.1) / q / 10)
    qpos[i * 3 + 2] = Math.round((pos.getZ(i) + 0.1) / q / 10)
  }
  const nrm = box.getAttribute("normal")
  const qn = new Int8Array(nrm.count * 3)
  for (let i = 0; i < nrm.count * 3; i++)
    qn[i] = Math.round((nrm.array as Float32Array)[i] * 127)
  const geo = new THREE.BufferGeometry()
  geo.setAttribute("position", new THREE.BufferAttribute(qpos, 3))
  geo.setAttribute("normal", new THREE.BufferAttribute(qn, 3, true))
  const mat = new THREE.MeshStandardMaterial({ name: "RACK_Rail_Zinc" })
  mat.aoMap = new THREE.Texture()
  const mesh = new THREE.Mesh(geo, mat)
  mesh.scale.setScalar(q * 10)
  mesh.position.set(-0.1, -0.1, -0.1)
  g.add(mesh)
  return g
}

/** The v1.15 cabinet: split door and side panel, a 0U channel with its
 * bracket, a U strip and a quantized post segment. */
function splitKit() {
  const s = new THREE.Group()
  s.add(quantizedSegment())
  const label = part(
    "label:u",
    [0.0055, 0.0405, 0.0004],
    [0.241, 0.1525, -0.0998]
  )
  ;(label.children[0] as THREE.Mesh).material = new THREE.MeshStandardMaterial({
    name: "RACK_Label_White",
    color: "#ffffff",
  })
  s.add(label)
  s.add(part1000("top:vented", "xy", [0, 0.01, 0], [-0.3, 2.015, 0]))
  s.add(part1000("side:panel", "yz", [0.002, 0, 0], [0.299, 0.1, 0]))
  s.add(part1000("side:panel:edge", "y", [0.015, 0.03, 0], [0.2925, 0.115, 0]))
  s.add(part1000("side:panel:infill", "yz", [0.002, 0, 0], [0.299, 0.13, 0]))
  s.add(part1000("base:plinth", "xy", [0, 0.1, 0], [-0.3, 0.05, 0]))
  for (const kind of ["glass", "perforated"]) {
    s.add(part1000(`door:${kind}`, "xz", [0, 0, 0.022], [-0.3, 0.1, 0]))
    const stile = part1000(
      `door:${kind}:stile`,
      "z",
      [0.03, 0, 0.022],
      [-0.285, 0.1, 0]
    )
    const hinge = new THREE.Object3D()
    hinge.userData.gltfName = "hinge"
    stile.add(hinge)
    s.add(stile)
    s.add(
      part1000(`door:${kind}:rail`, "x", [0, 0.03, 0.022], [-0.27, 0.115, 0])
    )
    const infill = part1000(
      `door:${kind}:infill`,
      "xz",
      [0, 0, 0.002],
      [-0.27, 0.13, 0]
    )
    if (kind === "glass")
      (infill.children[0] as THREE.Mesh).material =
        new THREE.MeshStandardMaterial({
          name: "RACK_Glass_Smoked",
          transparent: true,
          opacity: 0.35,
          depthWrite: false,
        })
    s.add(infill)
  }
  s.add(part("door:handle", [0.02, 0.12, 0.03], [0.26, 1.1, 0.015]))
  const channel = new THREE.Group()
  channel.userData = { gltfName: "channel:0u:left:rear" }
  channel.position.set(-0.258, 0.165, -0.9308)
  channel.rotation.y = Math.PI / 2
  const bracket = part1000("pdu:bracket", "z", [0.05, 0, 0.003], [0, 0, 0])
  channel.add(bracket)
  s.add(channel)
  s.updateMatrixWorld(true)
  return s
}

describe("rack kit v2 parts", () => {
  const index = indexKit(splitKit(), 1)
  const look: SceneLook = {
    ...LOOK,
    front_door: "split-perforated",
    rear_door: "glass",
  }
  const glassLook: SceneLook = { ...look, front_door: "glass" }
  const boxes = (
    draws: { geometry: THREE.BufferGeometry; matrix: THREE.Matrix4 }[]
  ) =>
    draws.map((d) => {
      if (!d.geometry.boundingBox) d.geometry.computeBoundingBox()
      return d.geometry.boundingBox!.clone().applyMatrix4(d.matrix)
    })

  it("mirrors quantized posts in place, not metres away", () => {
    const built = buildKit(index, "r", look, 42, 0.6, 2.02, 1, "#000", "solid")
    expect(built.instanced.length).toBe(2)
    for (const g of built.instanced) {
      const mesh = new THREE.InstancedMesh(
        g.geometry,
        g.material,
        g.matrices.length
      )
      g.matrices.forEach((m, i) => mesh.setMatrixAt(i, m))
      mesh.computeBoundingBox()
      mesh.computeBoundingSphere()
      // Each draw holds two of the four posts, on both sides of the rack.
      expect(mesh.boundingBox!.min.x).toBeGreaterThan(-0.31)
      expect(mesh.boundingBox!.max.x).toBeLessThan(0.31)
      expect(mesh.boundingBox!.min.x).toBeLessThan(-0.2)
      expect(mesh.boundingBox!.max.x).toBeGreaterThan(0.2)
      expect(mesh.boundingSphere!.radius).toBeLessThan(1.5)
      expect(g.matrices).toHaveLength(2 * 42)
      // The baked AO is left off the repeated segment.
      expect((g.material as THREE.MeshStandardMaterial).aoMap).toBeNull()
    }
    const mirrored = built.instanced.find(
      (g) => g.geometry !== index.parts[0].meshes[0].geometry
    )!
    const n = mirrored.geometry.getAttribute("normal")
    for (let i = 0; i < n.count; i++)
      expect(Math.hypot(n.getX(i), n.getY(i), n.getZ(i))).toBeCloseTo(1, 2)
    built.dispose()
  })

  it("builds split leaves from stiles, rails and infill at their real size", () => {
    const built = buildKit(
      index,
      "r",
      glassLook,
      42,
      0.8,
      2.02,
      1.2,
      "#000",
      "solid"
    )
    for (const leaf of built.doors) {
      const b = boxes(leaf.draws)
      // Two stiles and two rails, 30 mm each, at any leaf width.
      const stiles = b.filter((x) => Math.abs(x.max.x - x.min.x - 0.03) < 1e-3)
      const rails = b.filter((x) => Math.abs(x.max.y - x.min.y - 0.03) < 1e-3)
      expect(stiles).toHaveLength(2)
      expect(rails).toHaveLength(2)
      expect(rails[0].max.x - rails[0].min.x).toBeCloseTo(0.8 - 0.06, 3)
      const glass = leaf.draws.filter((d) => d.renderOrder > 0)
      expect(glass).toHaveLength(1)
      expect(seeThrough(glass[0].material)).toBe(true)
    }
    const split = buildKit(
      index,
      "r",
      look,
      42,
      0.8,
      2.02,
      1.2,
      "#000",
      "solid"
    )
    const halves = split.doors.filter((d) => d.side === "front")
    expect(halves).toHaveLength(2)
    for (const leaf of halves) {
      // Half the width, the stiles still 30 mm.
      const b = boxes(leaf.draws)
      const stiles = b.filter((x) => Math.abs(x.max.x - x.min.x - 0.03) < 1e-3)
      expect(stiles).toHaveLength(2)
      const xs = stiles
        .map((x) => (x.min.x + x.max.x) / 2)
        .sort((p, q) => p - q)
      expect(xs[1] - xs[0]).toBeCloseTo(0.4 - 0.03, 3)
    }
    built.dispose()
    split.dispose()
  })

  it("draws a split side panel: its edge at the bottom and the top, both sides", () => {
    const have = new Set(index.parts.map((p) => p.name))
    const want = wantedParts(look, have, "solid")
    expect(want.has("side:panel:edge")).toBe(true)
    expect(want.has("side:panel")).toBe(false)
    const built = buildKit(index, "r", look, 42, 0.6, 2.02, 1, "#000", "solid")
    const edges = boxes(built.plain).filter(
      (b) =>
        Math.abs(b.max.y - b.min.y - 0.03) < 1e-3 && b.max.z - b.min.z > 0.9
    )
    expect(edges).toHaveLength(4)
    expect(Math.min(...edges.map((b) => b.min.y))).toBeCloseTo(0.1, 3)
    expect(Math.max(...edges.map((b) => b.max.y))).toBeCloseTo(2.015, 3)
    built.dispose()
  })

  it("puts a wall cabinet on its base panel", () => {
    const have = new Set(["base:panel", "base:plinth", "wall:bracket"])
    const want = wantedParts({ ...look, frame: "wall-cabinet" }, have, "solid")
    expect(want.has("base:panel")).toBe(true)
    expect(want.has("base:plinth")).toBe(false)
  })

  it("draws a pdu:bracket behind each seated device, as long as it", () => {
    const bracket = index.parts.find((p) => p.name === "pdu:bracket")!
    expect(bracket.channel).toBe("channel:0u:left:rear")
    const none = buildKit(index, "r", look, 42, 0.8, 2.02, 1.2, "#000", "solid")
    const seated = buildKit(
      index,
      "r",
      look,
      42,
      0.8,
      2.02,
      1.2,
      "#000",
      "solid",
      [{ name: "channel:0u:left:rear", y: 0.22, h: 1.7 }]
    )
    expect(seated.plain.length).toBe(none.plain.length + 1)
    const b = boxes(seated.plain.slice(-1))[0]
    expect(b.min.y).toBeCloseTo(0.22, 3)
    expect(b.max.y).toBeCloseTo(1.92, 3)
    // Kept 42 mm in from its side and as far from the rear as modelled.
    expect(b.max.x).toBeCloseTo(0.4 - 0.042 + 0.0015, 2)
    expect(b.max.z).toBeGreaterThan(0.5)
    none.dispose()
    seated.dispose()
  })

  it("puts a U strip on every post, facing its aisle", () => {
    const built = buildKit(index, "r", look, 42, 0.6, 2.02, 1, "#000", "solid")
    expect(built.labels).toHaveLength(4)
    expect(built.labels.filter((l) => l.facing === "front")).toHaveLength(2)
    const xs = built.labels.map((l) => l.x)
    expect(Math.min(...xs)).toBeCloseTo(-Math.max(...xs), 6)
    expect(built.labels[0].color).toBe("#ffffff")
    const two = buildKit(
      index,
      "r",
      { ...look, frame: "2-post" },
      42,
      0.6,
      2.02,
      1,
      "#000",
      "solid"
    )
    expect(two.labels).toHaveLength(2)
    built.dispose()
    two.dispose()
  })

  it("numbers units as the rack ruler does", () => {
    expect(unitNumber(0, 42, { start: 1, desc: false })).toBe(1)
    expect(unitNumber(41, 42, { start: 1, desc: false })).toBe(42)
    expect(unitNumber(0, 42, { start: 1, desc: true })).toBe(42)
    expect(unitNumber(41, 42, { start: 1, desc: true })).toBe(1)
  })
})
