import { describe, expect, it } from "vitest"
import * as THREE from "three"

import { PORT_MARKERS_KEY, facesRay, portFirst } from "./port-pick"

// A C9300 with a C9300-NM-8X: the module's ports (TenGigabitEthernet1/1/N)
// open 1.5 mm into the chassis' front (-Z), their markers lifted 1 mm, and
// the module's bay box stands proud of the module - so the box is nearer
// to a front camera than the port on it.

const QUAD = new THREE.PlaneGeometry(1, 1)

function markers(spots: { at: V3; n: V3; u: V3 }[]): THREE.InstancedMesh {
  const im = new THREE.InstancedMesh(
    QUAD,
    new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }),
    spots.length
  )
  im.userData = { [PORT_MARKERS_KEY]: true }
  const m = new THREE.Matrix4()
  spots.forEach((s, i) => {
    const n = new THREE.Vector3(...s.n)
    const u = new THREE.Vector3(...s.u)
    const v = new THREE.Vector3().crossVectors(n, u)
    m.makeBasis(u, v, n)
    const q = new THREE.Quaternion().setFromRotationMatrix(m)
    m.compose(new THREE.Vector3(...s.at), q, new THREE.Vector3(0.012, 0.008, 1))
    im.setMatrixAt(i, m)
  })
  im.computeBoundingSphere()
  return im
}

type V3 = [number, number, number]

function box(center: V3, size: V3): THREE.Mesh {
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(...size),
    new THREE.MeshBasicMaterial({ visible: false })
  )
  mesh.position.set(...center)
  return mesh
}

/** The chassis' depth; its front face is at z = -D/2. */
const D = 0.445
const front = -D / 2
const portZ = front + 0.0015 - 0.001

function scene() {
  const root = new THREE.Group()
  // The module: 0.05 deep behind the front, its bay box 1% proud.
  const bay = box([0.13, 0.02, front + 0.025], [0.1 * 1.01, 0.03, 0.05 * 1.01])
  const ports = markers([
    // A module port on the front.
    { at: [0.13, 0.02, portZ], n: [0, 0, -1], u: [-1, 0, 0] },
    // A rear port right behind it, facing +Z.
    { at: [0.13, 0.02, -front - 0.002], n: [0, 0, 1], u: [1, 0, 0] },
  ])
  root.add(bay, ports)
  root.updateMatrixWorld(true)
  return { root, bay, ports }
}

function cast(root: THREE.Object3D, origin: V3, dir: V3) {
  const ray = new THREE.Raycaster(
    new THREE.Vector3(...origin),
    new THREE.Vector3(...dir).normalize()
  )
  return { hits: ray.intersectObject(root, true), dir: ray.ray.direction }
}

describe("portFirst", () => {
  it("puts a module port before the bay box it sits on", () => {
    const { root, bay, ports } = scene()
    const { hits, dir } = cast(root, [0.13, 0.02, -1], [0, 0, 1])
    // Unfiltered, the bay box is the nearest hit: it took every event.
    expect(hits[0].object).toBe(bay)
    const out = portFirst(hits, dir)
    expect(out[0].object).toBe(ports)
    expect(out[0].instanceId).toBe(0)
    expect(out[1].object).toBe(bay)
  })

  it("drops a port facing away, seen through the device", () => {
    const { root, ports } = scene()
    const { hits, dir } = cast(root, [0.13, 0.02, -1], [0, 0, 1])
    const out = portFirst(hits, dir)
    expect(
      out.filter((h) => h.object === ports).map((h) => h.instanceId)
    ).toEqual([0])
  })

  it("leaves the body first where no port is on its face", () => {
    const { root, bay } = scene()
    // The module's body beside the port; the rear port behind is dropped.
    const { hits, dir } = cast(root, [0.16, 0.02, -1], [0, 0, 1])
    const out = portFirst(hits, dir)
    expect(out[0].object).toBe(bay)
    expect(out.some((h) => h.object.userData[PORT_MARKERS_KEY])).toBe(false)
  })

  it("keeps a body well in front of a port first", () => {
    const { root, ports } = scene()
    const wall = box([0.13, 0.02, front - 0.1], [0.3, 0.3, 0.01])
    root.add(wall)
    root.updateMatrixWorld(true)
    const { hits, dir } = cast(root, [0.13, 0.02, -1], [0, 0, 1])
    const out = portFirst(hits, dir)
    expect(out[0].object).toBe(wall)
    expect(out.findIndex((h) => h.object === ports)).toBeGreaterThan(0)
  })

  it("puts the port first from a slant too", () => {
    const { root, ports } = scene()
    const target = new THREE.Vector3(0.13, 0.02, portZ)
    const origin = new THREE.Vector3(0.5, 0.4, -0.6)
    const d = target.clone().sub(origin)
    const { hits, dir } = cast(root, origin.toArray(), d.toArray())
    const out = portFirst(hits, dir)
    expect(out[0].object).toBe(ports)
    expect(out[0].instanceId).toBe(0)
  })

  it("is the plain order where a port is already nearest", () => {
    const { root, ports } = scene()
    const { hits, dir } = cast(root, [0.13, 0.02, -1], [0, 0, 1])
    const portFirstHits = [hits.find((h) => h.object === ports)!]
    expect(portFirst(portFirstHits, dir)).toEqual(portFirstHits)
  })
})

describe("facesRay", () => {
  it("reads the instance's turn and the mesh's", () => {
    const { root, ports } = scene()
    const { hits, dir } = cast(root, [0.13, 0.02, -1], [0, 0, 1])
    const mine = hits.filter((h) => h.object === ports)
    expect(mine.map((h) => facesRay(h, dir))).toEqual([true, false])
    // Turned half round, the front port faces away and the rear one in.
    ports.rotation.y = Math.PI
    ports.updateMatrixWorld(true)
    expect(mine.map((h) => facesRay(h, dir))).toEqual([false, true])
  })
})
