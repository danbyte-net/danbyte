// @vitest-environment jsdom
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"

import * as THREE from "three"
import { describe, expect, it } from "vitest"

import {
  MODEL_TRIANGLE_CAP,
  formatDefaults,
  gltfExternalRefs,
  guessUnit,
  modelFormatOf,
  NATIVE_CAD_MESSAGE,
} from "@/lib/model-3d-formats"

import {
  boundsOf,
  conversionMatrix,
  exportGlb,
  gltfToGroup,
  objToGroup,
  occtToGroup,
  prepare,
  simplify,
  stlToGroup,
  triangleCount,
} from "./model-convert"
import type { OcctResult } from "./model-convert"

const require = createRequire(import.meta.url)
// The occt package's own test files: a 10 mm cube as STEP and STL.
const occtDir = dirname(require.resolve("occt-import-js/package.json"))
const cube = (ext: string) =>
  readFileSync(
    join(occtDir, "test/testfiles/cube-10x10mm", `Cube 10x10.${ext}`)
  )

const buf = (b: Uint8Array | Buffer): ArrayBuffer =>
  b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer

const size = (o: THREE.Object3D) => boundsOf(o).getSize(new THREE.Vector3())

describe("formats", () => {
  it("knows the exchange formats and refuses native CAD", () => {
    expect(modelFormatOf("a.STP")).toEqual({ format: "step" })
    expect(modelFormatOf("a.igs")).toEqual({ format: "iges" })
    expect(modelFormatOf("a.glb")).toEqual({ format: "glb" })
    expect(modelFormatOf("switch.sldprt")).toEqual({
      error: NATIVE_CAD_MESSAGE,
    })
    expect(modelFormatOf("a.f3d")).toEqual({ error: NATIVE_CAD_MESSAGE })
    expect("error" in modelFormatOf("a.zip")).toBe(true)
  })

  it("defaults CAD to mm, Z up and guesses STL units", () => {
    expect(formatDefaults("step")).toEqual({ unit: "mm", up: "z" })
    expect(formatDefaults("glb")).toEqual({ unit: "m", up: "y" })
    expect(guessUnit(482)).toBe("mm")
    expect(guessUnit(0.48)).toBe("m")
  })

  it("refuses a glTF with external files", () => {
    expect(gltfExternalRefs({ buffers: [{ uri: "a.bin" }] })).toMatch(
      /separate files/
    )
    expect(
      gltfExternalRefs({ buffers: [{ uri: "data:application/octet,AA" }] })
    ).toBeNull()
  })
})

describe("conversion", () => {
  it("maps Z up to Y up and mm to metres", () => {
    const v = new THREE.Vector3(0, -10, 20).applyMatrix4(
      conversionMatrix("mm", "z")
    )
    expect(v.x).toBeCloseTo(0)
    expect(v.y).toBeCloseTo(0.02) // CAD up → Y
    expect(v.z).toBeCloseTo(0.01) // CAD −Y front → +Z
    const inch = new THREE.Vector3(1, 0, 0).applyMatrix4(
      conversionMatrix("in", "y")
    )
    expect(inch.x).toBeCloseTo(0.0254)
  })

  it("STEP box → GLB in metres, standing on the origin", async () => {
    const occtimportjs = require("occt-import-js")
    const occt = await occtimportjs()
    const result: OcctResult = occt.ReadStepFile(new Uint8Array(cube("stp")), {
      linearUnit: "millimeter",
    })
    expect(result.success).toBe(true)
    const group = prepare(occtToGroup(result), "mm", "z")
    const s = size(group)
    expect(s.x).toBeCloseTo(0.01, 4)
    expect(s.y).toBeCloseTo(0.01, 4)
    expect(s.z).toBeCloseTo(0.01, 4)
    expect(boundsOf(group).min.y).toBeCloseTo(0, 6)
    expect(triangleCount(group)).toBe(12)
    // One material, one mesh: the parts merged.
    expect(group.children.length).toBe(1)

    const glb = await exportGlb(group)
    expect(new TextDecoder().decode(new Uint8Array(glb, 0, 4))).toBe("glTF")
    const back = await gltfToGroup(glb, true)
    expect(size(back).x).toBeCloseTo(0.01, 4)
  }, 30_000)

  it("reads binary STL", () => {
    const g = stlToGroup(buf(cube("stl")))
    expect(triangleCount(g)).toBe(12)
    expect(Math.max(...size(g).toArray())).toBeCloseTo(10)
  })

  it("reads ascii STL", () => {
    const ascii = `solid t
facet normal 0 0 1
outer loop
vertex 0 0 0
vertex 100 0 0
vertex 0 50 0
endloop
endfacet
endsolid t`
    const g = stlToGroup(buf(new TextEncoder().encode(ascii)))
    expect(triangleCount(g)).toBe(1)
    const s = size(prepare(g, "mm", "z"))
    expect(s.x).toBeCloseTo(0.1)
    expect(s.z).toBeCloseTo(0.05) // CAD +Y depth → Z
  })

  it("reads OBJ", () => {
    const obj = `v 0 0 0
v 2 0 0
v 2 1 0
v 0 1 0
f 1 2 3
f 1 3 4`
    const g = prepare(objToGroup(obj), "m", "y")
    expect(triangleCount(g)).toBe(2)
    expect(size(g).x).toBeCloseTo(2)
    expect(size(g).y).toBeCloseTo(1)
  })

  it("refuses a .gltf with external buffers", async () => {
    const json = JSON.stringify({
      asset: { version: "2.0" },
      buffers: [{ uri: "model.bin", byteLength: 4 }],
    })
    await expect(
      gltfToGroup(buf(new TextEncoder().encode(json)), false)
    ).rejects.toThrow(/separate files/)
  })

  it("simplifies a dense mesh below the cap", async () => {
    const dense = new THREE.Group()
    dense.add(new THREE.Mesh(new THREE.SphereGeometry(1, 400, 400)))
    const g = prepare(dense, "m", "y")
    expect(triangleCount(g)).toBeGreaterThan(MODEL_TRIANGLE_CAP)
    const small = await simplify(g, MODEL_TRIANGLE_CAP)
    expect(triangleCount(small)).toBeLessThanOrEqual(MODEL_TRIANGLE_CAP * 1.1)
    expect(size(small).x).toBeCloseTo(2, 1)
  }, 30_000)
})
