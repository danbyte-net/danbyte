import * as THREE from "three"
import { describe, expect, it } from "vitest"

import type { DeviceLeds } from "@/lib/led-state"
import { LED_COLORS } from "@/lib/led-state"

import { fittedModel } from "./device-model"
import type { ModelEntry } from "./device-model"
import {
  LED_BLINK,
  LED_ON,
  LED_TEX_WIDTH,
  buildLedBatch,
  fillLedStates,
  ledTextureSize,
} from "./led-instances"
import { assembleModel } from "./model-assembly"
import { anchorMatrices } from "./port-plugs"
import {
  instanceGroups,
  instancedParts,
  partMeshes,
  placeInstances,
  sharedAssembly,
  slotMatrix,
} from "./rack-model-draw"
import type { RackModelDraw } from "./rack-model-draw"
import { rackSlotPose, rackSlotTargetM } from "./rack-models"
import type { SceneDevice, SceneModel, SceneRack } from "./world"

/**
 * Full models in racks drawn instanced (rack-model-draw, led-instances):
 * the groups, the per-instance covers and LED looks, the anchors each
 * member's plugs take from the group's shared copy, and what it costs -
 * a synthetic 48-port switch, N identical devices, drawn per device as
 * PlacedModel did and instanced.
 */

const node = (name: string, mesh?: THREE.Mesh): THREE.Object3D => {
  const o = mesh ?? new THREE.Object3D()
  o.userData.gltfName = name
  return o
}

const quad = (color = "#444444") =>
  new THREE.Mesh(
    new THREE.PlaneGeometry(0.01, 0.01),
    new THREE.MeshStandardMaterial({ color })
  )

/** A 1U switch as a pack authors it: body parts, 48 ports each with a
 * port anchor, a cover and an LED, a SYS LED and a fan bay. */
function switchScene(ports = 48, bodyParts = 12): THREE.Group {
  const root = new THREE.Group()
  root.userData.gltfName = "Scene"
  // A root that carries a transform of its own, as some exports do.
  root.position.set(0.01, 0, -0.02)
  const box = new THREE.Mesh(
    new THREE.BoxGeometry(0.44, 0.044, 0.4, 4, 2, 4),
    new THREE.MeshStandardMaterial({ color: "#2a2a2a" })
  )
  root.add(node("body", box))
  for (let i = 1; i < bodyParts; i++) {
    const m = quad()
    m.position.set(-0.2 + i * 0.03, 0.03, -0.2)
    root.add(node(`detail${i}`, m))
  }
  for (let p = 1; p <= ports; p++) {
    const x = -0.2 + p * 0.008
    const a = node(`port:Gi1/0/${p}`)
    a.position.set(x, 0.02, -0.2)
    root.add(a)
    const c = node(`cover:port:Gi1/0/${p}`, quad("#111111"))
    c.position.set(x, 0.02, -0.201)
    root.add(c)
    const l = node(`led:port:Gi1/0/${p}`, quad("#0a0a0a"))
    l.position.set(x, 0.035, -0.201)
    root.add(l)
  }
  const sys = node("led:SYS", quad("#0a0a0a"))
  sys.position.set(0.2, 0.035, -0.201)
  root.add(sys)
  const bay = node("bay:FAN 1")
  bay.position.set(0, 0.02, 0.19)
  root.add(bay)
  root.updateMatrixWorld(true)
  return root
}

const RACK: SceneRack = {
  id: "r",
  name: "R1",
  u_height: 42,
  starting_unit: 1,
  desc_units: false,
  width: 19,
  outer_width_mm: 600,
  outer_depth_mm: 1000,
  devices: [],
} satisfies SceneRack

const MODEL: SceneModel = {
  url: "/sw.glb",
  source: "type",
  fit: "auto",
  up: "y",
  front: "-z",
}

const device = (i: number): SceneDevice =>
  ({
    id: `d${String(i).padStart(2, "0")}`,
    name: `sw${i}`,
    position: 1 + i,
    face: i % 2 ? "rear" : "front",
    rack_side: "",
    u_height: 1,
    rack_width: "full",
    is_full_depth: true,
    model: MODEL,
  }) as SceneDevice

const entryOf = (scene: THREE.Group): ModelEntry => ({
  status: "ready",
  scene,
  triangles: 0,
  box: new THREE.Box3().setFromObject(scene),
  anchors: { bays: ["FAN 1"], empties: [] },
})

function drawsFor(
  scene: THREE.Group,
  n: number,
  level: "full" | "far" = "full"
): Map<string, RackModelDraw> {
  const entry = entryOf(scene)
  const out = new Map<string, RackModelDraw>()
  for (let i = 0; i < n; i++) {
    const d = device(i)
    const fit = fittedModel(entry.box!, MODEL, rackSlotTargetM(RACK, d))
    out.set(d.id, {
      level,
      entry,
      parts: [],
      fit,
      pose: rackSlotPose(RACK, d, 1, fit.size),
      bays: null,
      emptyMode: "filler",
      groupKey: `/sw.glb|${level}`,
    })
  }
  return out
}

/** How DeviceMesh and PlacedModel stood a device's own copy in its slot:
 * the pose group, the fit's place and scale, its turn, then the copy. */
function perDeviceCopy(draw: RackModelDraw, scene: THREE.Object3D) {
  const pose = new THREE.Group()
  pose.position.set(...draw.pose.position)
  pose.rotation.set(0, draw.pose.rotY, 0)
  const g1 = new THREE.Group()
  g1.position.set(...draw.fit.position)
  g1.scale.setScalar(draw.fit.scale)
  const g2 = new THREE.Group()
  g2.rotation.copy(draw.fit.rotation)
  const { root } = assembleModel(scene, [], null)
  pose.add(g1)
  g1.add(g2)
  g2.add(root)
  pose.updateMatrixWorld(true)
  return { pose, g2, root }
}

const meshCount = (o: THREE.Object3D) => {
  let n = 0
  o.traverse((c) => {
    if (c instanceof THREE.Mesh && c.visible) n++
  })
  return n
}

const trianglesOf = (g: THREE.BufferGeometry) =>
  (g.index ? g.index.count : g.getAttribute("position").count) / 3

describe("instanced groups", () => {
  it("groups by level and look; a unique module set is a group of one", () => {
    const scene = switchScene(4, 2)
    const full = drawsFor(scene, 3)
    const far = drawsFor(scene, 2, "far")
    const all = new Map([...full])
    for (const [id, d] of far) all.set(`${id}-far`, d)
    const odd = { ...full.get("d00")!, groupKey: "/sw.glb|PS-0=/psu.glb" }
    all.set("odd", odd)
    const groups = instanceGroups(all)
    const sizes = groups.map((g) => [g.level, g.ids.length]).sort()
    expect(sizes).toEqual([
      ["far", 2],
      ["full", 1],
      ["full", 3],
    ])
  })

  it("shares one assembled copy per chassis and look", () => {
    const scene = switchScene(4, 2)
    const [a, b] = [...drawsFor(scene, 2).values()]
    expect(sharedAssembly(a)).toBe(sharedAssembly(b))
    const other = { ...a, groupKey: "other" }
    expect(sharedAssembly(other)).not.toBe(sharedAssembly(a))
  })
})

describe("instance placement", () => {
  const scene = switchScene(4, 2)
  const draws = drawsFor(scene, 3)
  const list = [...draws.values()]
  const ids = [...draws.keys()]
  const shared = sharedAssembly(list[0])
  const parts = instancedParts(shared.meshes, list.length, true)

  it("puts every part where the device's own copy drew it", () => {
    placeInstances(parts, null, list, ids, {})
    const body = parts.find((p) => p.part.mesh.userData.gltfName === "body")!
    list.forEach((d, i) => {
      const { root } = perDeviceCopy(d, scene)
      let own: THREE.Mesh | null = null
      root.traverse((o) => {
        if (o.userData.gltfName === "body") own = o as THREE.Mesh
      })
      const m = new THREE.Matrix4()
      body.im.getMatrixAt(i, m)
      const got = new THREE.Vector3().setFromMatrixPosition(m)
      const want = new THREE.Vector3().setFromMatrixPosition(own!.matrixWorld)
      // Instance matrices are 32-bit floats.
      expect(got.distanceTo(want)).toBeLessThan(1e-6)
    })
  })

  it("hides a cover for the device whose cabling hides it alone", () => {
    const leds: Record<string, DeviceLeds> = {
      [ids[1]]: { leds: {}, bays: {}, locate: null, covers: ["Gi1/0/2"] },
    }
    placeInstances(parts, null, list, ids, leds)
    const cover = parts.find((p) => p.part.cover?.name === "Gi1/0/2")!
    const scaleOf = (i: number) => {
      const m = new THREE.Matrix4()
      cover.im.getMatrixAt(i, m)
      return new THREE.Vector3().setFromMatrixScale(m).x
    }
    expect(scaleOf(0)).toBeGreaterThan(0)
    expect(scaleOf(1)).toBe(0)
    expect(scaleOf(2)).toBeGreaterThan(0)
  })

  it("gives each member's plugs its own anchors from the shared copy", () => {
    const plugs = [{ port: "Gi1/0/3", bay: null }]
    const [anchor] = anchorMatrices(shared.root, plugs)
    list.forEach((d) => {
      // Instanced: the overlay's empty stands where the copy would.
      const { pose, g2 } = perDeviceCopy(d, scene)
      const frame = new THREE.Group()
      frame.matrixAutoUpdate = false
      frame.matrix.copy(shared.root.matrix)
      g2.add(frame)
      pose.updateMatrixWorld(true)
      const got = new THREE.Vector3().setFromMatrixPosition(
        new THREE.Matrix4().multiplyMatrices(frame.matrixWorld, anchor!)
      )
      // Its own copy: the anchor node, in the room.
      const { root } = perDeviceCopy(d, scene)
      let port: THREE.Object3D | null = null
      root.traverse((o) => {
        if (o.userData.gltfName === "port:Gi1/0/3") port = o
      })
      const want = new THREE.Vector3().setFromMatrixPosition(port!.matrixWorld)
      expect(got.distanceTo(want)).toBeLessThan(1e-9)
    })
    // And the shared copy never joined the scene.
    expect(shared.root.parent).toBeNull()
  })

  it("matches the slot matrix to the posed groups", () => {
    const d = list[1]
    const { g2 } = perDeviceCopy(d, scene)
    const m = slotMatrix(d.pose, d.fit)
    const a = new THREE.Vector3(0.1, 0.02, -0.1).applyMatrix4(m)
    const b = new THREE.Vector3(0.1, 0.02, -0.1).applyMatrix4(g2.matrixWorld)
    expect(a.distanceTo(b)).toBeLessThan(1e-9)
  })
})

describe("instanced LEDs", () => {
  const scene = switchScene(4, 2)
  const { root } = assembleModel(scene, [], null)
  const meshes = partMeshes(root)
  const sources = meshes.flatMap((pm) =>
    pm.led
      ? [
          {
            mesh: pm.mesh,
            local: pm.local,
            name: pm.led.name,
            bay: pm.led.bay,
            off: pm.led.off,
          },
        ]
      : []
  )

  it("merges every light into one geometry, indexed per light", () => {
    const { geometry, leds } = buildLedBatch(sources)
    expect(leds.map((l) => l.name).sort()).toEqual([
      "SYS",
      "port:Gi1/0/1",
      "port:Gi1/0/2",
      "port:Gi1/0/3",
      "port:Gi1/0/4",
    ])
    const idx = geometry.getAttribute("ledIndex")
    const seen = new Set<number>()
    for (let i = 0; i < idx.count; i++) seen.add(idx.getX(i))
    expect(seen.size).toBe(5)
    expect(geometry.getAttribute("ledOff").count).toBe(idx.count)
    // Every light's triangles, in the copy's frame.
    expect(trianglesOf(geometry)).toBe(5 * 2)
    const sys = sources.find((s) => s.name === "SYS")!
    const at = new THREE.Vector3().setFromMatrixPosition(sys.local)
    const li = leds.findIndex((l) => l.name === "SYS")
    const pos = geometry.getAttribute("position")
    let near = Infinity
    for (let i = 0; i < pos.count; i++)
      if (idx.getX(i) === li)
        near = Math.min(
          near,
          new THREE.Vector3().fromBufferAttribute(pos, i).distanceTo(at)
        )
    expect(near).toBeLessThan(0.01)
  })

  it("lights each instance from its own device, blinking only up close", () => {
    const { leds } = buildLedBatch(sources)
    const devs: (DeviceLeds | null)[] = [
      { leds: { SYS: "green" }, bays: {}, locate: null },
      null,
      {
        leds: { SYS: "blue_blink", "port:Gi1/0/2": "amber" },
        bays: {},
        locate: null,
      },
    ]
    const { width, height } = ledTextureSize(leds.length, devs.length)
    const data = new Float32Array(width * height * 4)
    const texel = (d: number, name: string) => {
      const o = (d * leds.length + leds.findIndex((l) => l.name === name)) * 4
      return [...data.slice(o, o + 4)]
    }
    expect(fillLedStates(data, leds, devs, true)).toBe(true)
    const green = new THREE.Color(LED_COLORS.green)
    const sys = texel(0, "SYS")
    ;[green.r, green.g, green.b].forEach((v, k) =>
      expect(sys[k]).toBeCloseTo(v, 6)
    )
    expect(sys[3]).toBe(LED_ON)
    expect(texel(1, "SYS")[3]).toBe(0)
    expect(texel(2, "SYS")[3]).toBe(LED_BLINK)
    expect(texel(2, "port:Gi1/0/2")[3]).toBe(LED_ON)
    expect(texel(0, "port:Gi1/0/2")[3]).toBe(0)
    // A far copy (or reduced motion) holds the blink steady.
    expect(fillLedStates(data, leds, devs, false)).toBe(false)
    expect(texel(2, "SYS")[3]).toBe(LED_ON)
  })

  it("wraps the state texture into rows", () => {
    expect(ledTextureSize(5, 3)).toEqual({ width: 15, height: 1 })
    expect(ledTextureSize(100, 48)).toEqual({
      width: LED_TEX_WIDTH,
      height: Math.ceil(4800 / LED_TEX_WIDTH),
    })
  })
})

describe("what a rack of identical full models costs", () => {
  // A 48-port switch: 12 body parts, 48 covers, 49 LEDs - 109 meshes.
  const scene = switchScene(48, 12)
  const report: string[] = []

  for (const n of [1, 8, 24]) {
    it(`${n} devices`, () => {
      const draws = drawsFor(scene, n)
      const list = [...draws.values()]
      // Before: each device its own copy - one draw per visible mesh.
      let beforeCalls = 0
      let beforeTris = 0
      for (const d of list) {
        const { root } = perDeviceCopy(d, scene)
        beforeCalls += meshCount(root)
        root.traverse((o) => {
          if (o instanceof THREE.Mesh) beforeTris += trianglesOf(o.geometry)
        })
      }
      // After: one instanced mesh per part, one LED batch.
      const shared = sharedAssembly(list[0])
      const parts = instancedParts(shared.meshes, n, true)
      const ledSources = shared.meshes.filter((m) => m.led)
      const batch = buildLedBatch(
        ledSources.map((m) => ({
          mesh: m.mesh,
          local: m.local,
          name: m.led!.name,
          bay: m.led!.bay,
          off: m.led!.off,
        }))
      )
      const afterCalls = parts.length + 1
      const afterTris =
        n *
        (parts.reduce((t, p) => t + trianglesOf(p.part.mesh.geometry), 0) +
          trianglesOf(batch.geometry))
      report.push(
        `${n} devices: ${beforeCalls} -> ${afterCalls} draw calls, ` +
          `${beforeTris} -> ${afterTris} triangles`
      )
      // Every instance still costs its triangles.
      expect(afterTris).toBe(beforeTris)
      expect(beforeCalls).toBe(109 * n)
      expect(afterCalls).toBe(61)
      parts.forEach((p) => p.im.dispose())
      if (n === 24) console.info(report.join("\n"))
    })
  }
})
