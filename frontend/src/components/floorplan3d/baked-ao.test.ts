import { afterAll, beforeAll, describe, expect, it } from "vitest"
import * as THREE from "three"

import type { DeviceLeds } from "@/lib/led-state"

import { hasBakedAo, parseModel } from "./device-model"
import { applyLeds, findLeds } from "./led-binding"
import { assembleModel } from "./model-assembly"
import { fitMaterialToUvs, prepare, simplify } from "./model-convert"
import { applyPortCovers, findPortCovers } from "./port-covers"
import { farInstances, partMeshes } from "./rack-model-draw"

/**
 * A pack's baked ambient occlusion (export spec v1.8): an
 * `occlusionTexture` read through TEXCOORD_1, quantized as gltfpack -cc
 * leaves it. The material's `aoMap` on channel 1 and the geometry's `uv1`
 * must survive every path a model takes to the screen.
 */

const pad4 = (n: number) => (n + 3) & ~3

/** A binary glTF: a quad mesh worn by the chassis body, an `led:` node, a
 * port cover and a `bay:` node; TEXCOORD_1 as normalized uint16
 * (KHR_mesh_quantization); the material's occlusion map on texCoord 1. */
function bakedAoGlb(): ArrayBuffer {
  const pos = new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0])
  const nor = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1])
  const uv0 = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1])
  const uv1 = new Uint16Array([0, 0, 65535, 0, 65535, 65535, 0, 65535])
  const idx = new Uint16Array([0, 1, 2, 0, 2, 3])
  // Never decoded: createImageBitmap is stubbed below.
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const parts: ArrayBufferView[] = [pos, nor, uv0, uv1, idx, png]
  const views: { byteOffset: number; byteLength: number }[] = []
  let off = 0
  for (const p of parts) {
    views.push({ byteOffset: off, byteLength: p.byteLength })
    off = pad4(off + p.byteLength)
  }
  const bin = new Uint8Array(off)
  parts.forEach((p, i) =>
    bin.set(
      new Uint8Array(p.buffer, p.byteOffset, p.byteLength),
      views[i].byteOffset
    )
  )
  const json = {
    asset: { version: "2.0" },
    extensionsUsed: ["KHR_mesh_quantization"],
    extensionsRequired: ["KHR_mesh_quantization"],
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [
      { name: "chassis", children: [1, 2, 3, 4] },
      { name: "body", mesh: 0 },
      { name: "led:SYS", mesh: 0 },
      { name: "cover:port:Te1/0/1", mesh: 0 },
      { name: "bay:PS-0", translation: [0.5, 0, 0] },
    ],
    meshes: [
      {
        primitives: [
          {
            attributes: {
              POSITION: 0,
              NORMAL: 1,
              TEXCOORD_0: 2,
              TEXCOORD_1: 3,
            },
            indices: 4,
            material: 0,
          },
        ],
      },
    ],
    materials: [
      {
        name: "Chassis",
        pbrMetallicRoughness: {
          baseColorFactor: [0.6, 0.6, 0.6, 1],
          metallicFactor: 0.5,
          roughnessFactor: 0.4,
        },
        occlusionTexture: { index: 0, texCoord: 1, strength: 0.9 },
      },
    ],
    textures: [{ source: 0 }],
    images: [{ bufferView: 5, mimeType: "image/png" }],
    accessors: [
      {
        bufferView: 0,
        componentType: 5126,
        count: 4,
        type: "VEC3",
        min: [0, 0, 0],
        max: [1, 1, 0],
      },
      { bufferView: 1, componentType: 5126, count: 4, type: "VEC3" },
      { bufferView: 2, componentType: 5126, count: 4, type: "VEC2" },
      {
        bufferView: 3,
        componentType: 5123,
        normalized: true,
        count: 4,
        type: "VEC2",
      },
      { bufferView: 4, componentType: 5123, count: 6, type: "SCALAR" },
    ],
    bufferViews: views.map((v) => ({ buffer: 0, ...v })),
    buffers: [{ byteLength: bin.byteLength }],
  }
  const jsonBytes = new TextEncoder().encode(JSON.stringify(json))
  const jsonLen = pad4(jsonBytes.byteLength)
  const total = 12 + 8 + jsonLen + 8 + bin.byteLength
  const out = new ArrayBuffer(total)
  const dv = new DataView(out)
  const u8 = new Uint8Array(out)
  dv.setUint32(0, 0x46546c67, true)
  dv.setUint32(4, 2, true)
  dv.setUint32(8, total, true)
  dv.setUint32(12, jsonLen, true)
  dv.setUint32(16, 0x4e4f534a, true)
  u8.fill(0x20, 20, 20 + jsonLen)
  u8.set(jsonBytes, 20)
  dv.setUint32(20 + jsonLen, bin.byteLength, true)
  dv.setUint32(24 + jsonLen, 0x004e4942, true)
  u8.set(bin, 28 + jsonLen)
  return out
}

type Std = THREE.MeshStandardMaterial

const meshesOf = (o: THREE.Object3D) => {
  const out: THREE.Mesh[] = []
  o.traverse((c) => {
    if (c instanceof THREE.Mesh) out.push(c)
  })
  return out
}

/** The mesh carries the baked AO: the map on channel 1 and its UV set. */
function expectAo(mesh: THREE.Mesh | THREE.InstancedMesh) {
  const mat = (
    Array.isArray(mesh.material) ? mesh.material[0] : mesh.material
  ) as Std
  expect(mat.aoMap).toBeInstanceOf(THREE.Texture)
  expect(mat.aoMap!.channel).toBe(1)
  expect(mesh.geometry.getAttribute("uv1")).toBeTruthy()
}

const realBitmap = (globalThis as { createImageBitmap?: unknown })
  .createImageBitmap
const realCreate = URL.createObjectURL
const realRevoke = URL.revokeObjectURL
const hadSelf = "self" in globalThis
const realFetch = globalThis.fetch

let scene: THREE.Group

beforeAll(async () => {
  // Node has no image decoder: the loader's ImageBitmapLoader gets a 1×1
  // stand-in, and the blob URL it fetches answers with an empty body.
  ;(globalThis as { createImageBitmap?: unknown }).createImageBitmap =
    async () => ({ width: 1, height: 1, close() {} })
  // The loader reaches URL through `self`, as in a browser.
  if (!hadSelf) (globalThis as { self?: unknown }).self = globalThis
  URL.createObjectURL = () => "blob:baked-ao"
  URL.revokeObjectURL = () => {}
  globalThis.fetch = async () => new Response(new Blob([]))
  scene = await parseModel(bakedAoGlb())
})

afterAll(() => {
  ;(globalThis as { createImageBitmap?: unknown }).createImageBitmap =
    realBitmap
  URL.createObjectURL = realCreate
  URL.revokeObjectURL = realRevoke
  if (!hadSelf) delete (globalThis as { self?: unknown }).self
  globalThis.fetch = realFetch
})

describe("baked ambient occlusion", () => {
  it("loads as aoMap on UV channel 1 with the uv1 set", () => {
    const meshes = meshesOf(scene)
    expect(meshes).toHaveLength(3)
    meshes.forEach(expectAo)
    const mat = meshes[0].material as Std
    expect(mat.aoMapIntensity).toBeCloseTo(0.9)
    // Quantized, still normalized: three reads it as 0..1.
    const uv1 = meshes[0].geometry.getAttribute("uv1")
    expect(uv1.normalized).toBe(true)
    expect(uv1.getX(1)).toBeCloseTo(1)
    expect(hasBakedAo(scene)).toBe(true)
    expect(hasBakedAo(new THREE.Mesh(new THREE.BoxGeometry()))).toBe(false)
  })

  it("survives assembly, a posed part, covers and the LED swap", () => {
    const part = scene.clone(true)
    const { root } = assembleModel(
      scene,
      [{ bay: "PS-0", position: "1", scene: part }],
      null
    )
    const meshes = meshesOf(root)
    expect(meshes.length).toBe(6)
    meshes.forEach(expectAo)
    // Covers only show and hide.
    const covers = findPortCovers(root)
    applyPortCovers(covers, { covers: ["Te1/0/1"] })
    meshesOf(root).forEach(expectAo)
    // A lit LED glows in the shared material; off, its own comes back.
    const leds = findLeds(root)
    const dev: DeviceLeds = { leds: { SYS: "green" }, bays: {}, locate: null }
    applyLeds(leds, dev, true)
    const sys = leds.find((l) => l.name === "SYS" && l.bay === null)!
    expect((sys.meshes[0].material as Std).aoMap).toBeNull()
    applyLeds(leds, null, true)
    expectAo(sys.meshes[0])
  })

  it("survives the rack's far instancing", () => {
    const { root } = assembleModel(scene, [], null)
    const pms = partMeshes(root)
    const instanced = farInstances(pms, 3)
    // The lit-LED instances colour per instance, unlit; the rest are the
    // model's own.
    instanced.forEach((im, i) => {
      if (pms[i].led) return
      expectAo(im)
    })
    expect(instanced.filter((_, i) => !pms[i].led).length).toBeGreaterThan(0)
    instanced.forEach((im) => im.dispose())
  })

  it("survives the converter's merge, and drops a map whose UVs go", async () => {
    const group = prepare(scene, "m", "y")
    const merged = meshesOf(group)
    expect(merged).toHaveLength(1)
    expectAo(merged[0])
    // Three quads merged into one position set, as floats.
    expect(merged[0].geometry.getAttribute("uv1").count).toBe(12)
    expect(merged[0].geometry.getAttribute("uv1").array).toBeInstanceOf(
      Float32Array
    )
    // Simplification drops the UV sets: the AO map goes with them, on a
    // copy - the shared material keeps it.
    const simple = await simplify(group, 1)
    const sm = meshesOf(simple)[0]
    expect(sm.geometry.getAttribute("uv1")).toBeUndefined()
    expect((sm.material as Std).aoMap).toBeNull()
    expect((merged[0].material as Std).aoMap).toBeInstanceOf(THREE.Texture)
  })

  it("keeps a map whose UV set is there", () => {
    const mat = meshesOf(scene)[0].material as Std
    const geo = meshesOf(scene)[0].geometry
    expect(fitMaterialToUvs(mat, geo)).toBe(mat)
    const bare = new THREE.BufferGeometry()
    bare.setAttribute("position", geo.getAttribute("position"))
    const copy = fitMaterialToUvs(mat, bare) as Std
    expect(copy).not.toBe(mat)
    expect(copy.aoMap).toBeNull()
  })
})
