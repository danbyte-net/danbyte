import * as THREE from "three"
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js"
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js"
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js"
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js"
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js"
import { MeshoptSimplifier } from "three/examples/jsm/libs/meshopt_simplifier.module.js"
import {
  mergeGeometries,
  mergeVertices,
} from "three/examples/jsm/utils/BufferGeometryUtils.js"

import { UNIT_SCALE, gltfExternalRefs } from "@/lib/model-3d-formats"
import type { ModelFormat, ModelUnit, ModelUp } from "@/lib/model-3d-formats"

/**
 * The 3D model card's converter: whatever was picked (STEP, IGES, STL, OBJ,
 * glTF) becomes one Y-up, metre-scaled scene with as few meshes as it has
 * materials, and leaves as a binary glTF - the only thing the server keeps.
 * Everything runs in the browser; STEP and IGES go through OpenCascade in a
 * worker (cad-worker.ts), the rest through three's own loaders.
 */

/** What occt-import-js hands back (the parts the converter reads). */
export interface OcctResult {
  success: boolean
  meshes: {
    name: string
    color?: [number, number, number]
    brep_faces?: {
      first: number
      last: number
      color: [number, number, number] | null
    }[]
    attributes: {
      position: { array: ArrayLike<number> }
      normal?: { array: ArrayLike<number> }
    }
    index: { array: ArrayLike<number> }
  }[]
}

/** Parts with no colour of their own. */
export const NEUTRAL_GREY = "#9ca3af"

const materialCache = new Map<string, THREE.MeshStandardMaterial>()

/** One material per colour, so merging by material merges by colour. */
function partMaterial(hex: string): THREE.MeshStandardMaterial {
  let m = materialCache.get(hex)
  if (!m) {
    m = new THREE.MeshStandardMaterial({
      color: hex,
      roughness: 0.6,
      metalness: 0.2,
      name: hex,
    })
    materialCache.set(hex, m)
  }
  return m
}

function rgbHex(c: [number, number, number] | null | undefined): string | null {
  // occt reports an uncoloured part as black; a real black part reads the
  // same as no colour, which the neutral grey shows better anyway.
  if (!c || (c[0] === 0 && c[1] === 0 && c[2] === 0)) return null
  return `#${new THREE.Color(c[0], c[1], c[2]).getHexString()}`
}

/** The triangles `tris` of an indexed mesh as their own compact geometry. */
function subset(
  pos: ArrayLike<number>,
  nrm: ArrayLike<number> | undefined,
  idx: ArrayLike<number>,
  tris: number[]
): THREE.BufferGeometry {
  const remap = new Map<number, number>()
  const p: number[] = []
  const n: number[] = []
  const out: number[] = []
  for (const t of tris) {
    for (let k = 0; k < 3; k++) {
      const v = idx[t * 3 + k]
      let r = remap.get(v)
      if (r === undefined) {
        r = remap.size
        remap.set(v, r)
        p.push(pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2])
        if (nrm) n.push(nrm[v * 3], nrm[v * 3 + 1], nrm[v * 3 + 2])
      }
      out.push(r)
    }
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute("position", new THREE.Float32BufferAttribute(p, 3))
  if (nrm) g.setAttribute("normal", new THREE.Float32BufferAttribute(n, 3))
  else g.computeVertexNormals()
  g.setIndex(out)
  return g
}

/** occt meshes → a group, each part split by its faces' colours (STEP
 * carries per-face colours; a face without one takes its part's, then
 * neutral grey). */
export function occtToGroup(result: OcctResult): THREE.Group {
  const group = new THREE.Group()
  for (const m of result.meshes) {
    const pos = m.attributes.position.array
    const nrm = m.attributes.normal?.array
    const idx = m.index.array
    const partHex = rgbHex(m.color) ?? NEUTRAL_GREY
    const byColour = new Map<string, number[]>()
    const triCount = idx.length / 3
    const faces = m.brep_faces?.length
      ? m.brep_faces
      : [{ first: 0, last: triCount - 1, color: null }]
    for (const f of faces) {
      const hex = rgbHex(f.color) ?? partHex
      let list = byColour.get(hex)
      if (!list) byColour.set(hex, (list = []))
      for (let t = f.first; t <= f.last && t < triCount; t++) list.push(t)
    }
    for (const [hex, tris] of byColour) {
      if (tris.length === 0) continue
      const mesh = new THREE.Mesh(
        subset(pos, nrm, idx, tris),
        partMaterial(hex)
      )
      mesh.name = m.name
      group.add(mesh)
    }
  }
  return group
}

export function stlToGroup(buffer: ArrayBuffer): THREE.Group {
  const geometry = new STLLoader().parse(buffer)
  if (!geometry.hasAttribute("normal")) geometry.computeVertexNormals()
  const group = new THREE.Group()
  group.add(new THREE.Mesh(geometry, partMaterial(NEUTRAL_GREY)))
  return group
}

export function objToGroup(text: string): THREE.Group {
  const parsed = new OBJLoader().parse(text)
  const group = new THREE.Group()
  parsed.updateMatrixWorld(true)
  parsed.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return
    const mesh = o
    // An OBJ's own materials live in a separate .mtl the upload doesn't
    // carry: a neutral finish instead of three's default shiny phong.
    const g = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld)
    if (!g.hasAttribute("normal")) g.computeVertexNormals()
    group.add(new THREE.Mesh(g, partMaterial(NEUTRAL_GREY)))
  })
  return group
}

/** A glTF (binary, or a self-contained .gltf) → its scene. External files
 * are refused before parsing, so the loader never reaches for one. */
export async function gltfToGroup(
  buffer: ArrayBuffer,
  binary: boolean
): Promise<THREE.Group> {
  if (!binary) {
    let json: unknown
    try {
      json = JSON.parse(new TextDecoder().decode(buffer))
    } catch {
      throw new Error("Not a glTF file.")
    }
    const why = gltfExternalRefs(json)
    if (why) throw new Error(why)
  }
  const loader = new GLTFLoader()
  // Meshopt's decoder is bundled; no Draco or KTX2 decoder is configured,
  // so a file needing one fails here instead of fetching one.
  loader.setMeshoptDecoder(MeshoptDecoder)
  const gltf = await loader.parseAsync(buffer, "")
  return gltf.scene
}

/** Run STEP/IGES through the OpenCascade worker. */
export function readCad(
  format: "step" | "iges",
  buffer: ArrayBuffer
): Promise<OcctResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./cad-worker.ts", import.meta.url), {
      type: "module",
    })
    worker.onmessage = (
      ev: MessageEvent<
        { ok: true; result: OcctResult } | { ok: false; error: string }
      >
    ) => {
      worker.terminate()
      if (ev.data.ok) resolve(ev.data.result)
      else reject(new Error(ev.data.error))
    }
    worker.onerror = (e) => {
      worker.terminate()
      reject(new Error(e.message || "The CAD reader failed to start."))
    }
    worker.postMessage({ format, buffer }, [buffer])
  })
}

/** A picked file → its scene in the file's own units and axes. */
export async function loadSource(
  file: File,
  format: ModelFormat
): Promise<THREE.Group> {
  const buffer = await file.arrayBuffer()
  switch (format) {
    case "step":
    case "iges":
      return occtToGroup(await readCad(format, buffer))
    case "stl":
      return stlToGroup(buffer)
    case "obj":
      return objToGroup(new TextDecoder().decode(buffer))
    case "glb":
      return gltfToGroup(buffer, true)
    case "gltf":
      return gltfToGroup(buffer, false)
  }
}

export function boundsOf(obj: THREE.Object3D): THREE.Box3 {
  obj.updateMatrixWorld(true)
  return new THREE.Box3().setFromObject(obj)
}

/** Largest extent of the scene, in its own units. */
export function maxExtent(obj: THREE.Object3D): number {
  const s = boundsOf(obj).getSize(new THREE.Vector3())
  return Math.max(s.x, s.y, s.z)
}

export function triangleCount(obj: THREE.Object3D): number {
  let n = 0
  obj.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return
    const mesh = o
    const g = mesh.geometry
    n += (g.index ? g.index.count : g.getAttribute("position").count) / 3
  })
  return Math.round(n)
}

/** The matrix that takes a file's units and up axis to metres, Y up. Z up
 * turns −90° about X, so CAD's +Z lands on +Y and its −Y front on +Z -
 * glTF's front. */
export function conversionMatrix(unit: ModelUnit, up: ModelUp): THREE.Matrix4 {
  const s = UNIT_SCALE[unit]
  const m = new THREE.Matrix4().makeScale(s, s, s)
  if (up === "z") m.premultiply(new THREE.Matrix4().makeRotationX(-Math.PI / 2))
  return m
}

function materialsOf(mesh: THREE.Mesh): THREE.Material {
  return Array.isArray(mesh.material) ? mesh.material[0] : mesh.material
}

/**
 * The scene in metres, Y up, standing on the origin (its bottom centre at
 * 0,0,0), with one mesh per material: every transform is baked into the
 * geometry and same-material meshes are merged, so a 400-part assembly is a
 * handful of draw calls.
 */
export function prepare(
  source: THREE.Object3D,
  unit: ModelUnit,
  up: ModelUp
): THREE.Group {
  const conv = conversionMatrix(unit, up)
  source.updateMatrixWorld(true)
  const byMaterial = new Map<THREE.Material, THREE.BufferGeometry[]>()
  source.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return
    const mesh = o
    const mat = materialsOf(mesh)
    const g = mesh.geometry.clone()
    g.applyMatrix4(new THREE.Matrix4().multiplyMatrices(conv, mesh.matrixWorld))
    // Merging needs one attribute set: position + normal (+ uv where all
    // parts of that material have it), all indexed.
    if (!g.hasAttribute("normal")) g.computeVertexNormals()
    for (const name of Object.keys(g.attributes))
      if (!["position", "normal", "uv"].includes(name)) g.deleteAttribute(name)
    if (!g.index) {
      const n = g.getAttribute("position").count
      const idx = new Uint32Array(n)
      for (let i = 0; i < n; i++) idx[i] = i
      g.setIndex(new THREE.BufferAttribute(idx, 1))
    }
    g.morphAttributes = {}
    let list = byMaterial.get(mat)
    if (!list) byMaterial.set(mat, (list = []))
    list.push(g)
  })
  const out = new THREE.Group()
  for (const [mat, geos] of byMaterial) {
    const allUv = geos.every((g) => g.hasAttribute("uv"))
    if (!allUv) for (const g of geos) g.deleteAttribute("uv")
    // mergeGeometries answers null on mismatched attributes (typed as never).
    const merged = (
      geos.length === 1 ? geos[0] : mergeGeometries(geos, false)
    ) as THREE.BufferGeometry | null
    if (!merged) continue
    out.add(new THREE.Mesh(merged, mat))
  }
  // Stand it on the origin.
  const box = boundsOf(out)
  const c = box.getCenter(new THREE.Vector3())
  const shift = new THREE.Matrix4().makeTranslation(-c.x, -box.min.y, -c.z)
  for (const child of out.children)
    (child as THREE.Mesh).geometry.applyMatrix4(shift)
  return out
}

/** Fewer triangles, same shape: meshoptimizer's simplifier (bundled, no
 * fetch) per mesh, down to about `target` triangles in all. */
export async function simplify(
  group: THREE.Group,
  target: number
): Promise<THREE.Group> {
  await MeshoptSimplifier.ready
  const total = triangleCount(group)
  if (total <= target) return group
  const ratio = target / total
  const out = new THREE.Group()
  for (const child of group.children) {
    const mesh = child as THREE.Mesh
    let g = mesh.geometry.clone()
    g.deleteAttribute("normal")
    g.deleteAttribute("uv")
    g = mergeVertices(g, 1e-6)
    const idx = new Uint32Array(g.index!.array)
    const pos = new Float32Array(g.getAttribute("position").array)
    const want = Math.max(3, Math.floor((idx.length * ratio) / 3) * 3)
    let [next] = MeshoptSimplifier.simplify(idx, pos, 3, want, 0.02, [])
    if (next.length > want * 1.1) {
      // Detail the topology won't give up (disconnected parts, fine
      // holes): the sloppy pass ignores topology to reach the count.
      ;[next] = MeshoptSimplifier.simplifySloppy(idx, pos, 3, null, want, 0.05)
    }
    g.setIndex(new THREE.BufferAttribute(next, 1))
    g.computeVertexNormals()
    out.add(new THREE.Mesh(g, mesh.material))
  }
  return out
}

/** The scene as a binary glTF. */
export async function exportGlb(group: THREE.Object3D): Promise<ArrayBuffer> {
  const res = await new GLTFExporter().parseAsync(group, { binary: true })
  return res as ArrayBuffer
}

/** Free a converter scene's GPU-side buffers (shared part materials are
 * kept; they are a handful per session). */
export function disposeGroup(obj: THREE.Object3D) {
  obj.traverse((o) => {
    if (o instanceof THREE.Mesh) o.geometry.dispose()
  })
}
