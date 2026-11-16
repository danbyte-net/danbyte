import { useEffect, useMemo, useState } from "react"
import type { ReactNode } from "react"
import { useThree } from "@react-three/fiber"
import * as THREE from "three"
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js"
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js"

import type { ModelBay, ModelEmptyMode } from "@/lib/api"
import { ledsKey, prefersReducedMotion } from "@/lib/led-state"
import type { DeviceLeds } from "@/lib/led-state"
import { coversKey } from "@/lib/port-covers"

import { applyLeds, findLeds, useLedBlink } from "./led-binding"
import { anchorNames, assembleModel } from "./model-assembly"
import { applyPortCovers, findPortCovers } from "./port-covers"
import { PortPlugs } from "./port-plugs"
import { modelRotation, modelScale } from "./world"
import type { SceneModel } from "./world"

/**
 * Uploaded device models (binary glTF) in the room.
 *
 * One download and one parse per URL, shared by every device that wears it:
 * each placed device draws a `clone(true)`, which copies the node tree but
 * shares geometry and materials. Entries are reference-counted and freed -
 * geometry, materials and textures - a short while after the last device
 * using one unmounts, so walking in and out of a hall doesn't reload them.
 *
 * The loader has meshopt's bundled decoder and nothing else: no Draco or
 * KTX2 decoder path, so nothing is fetched beyond the model itself (the
 * server refuses files that would need one).
 *
 * Each node keeps its exact glTF name in `userData.gltfName`, read from the
 * parser's associations: three rewrites `object.name` (`bay:FAN 1` becomes
 * `bayFAN_1`), and modular models are put together by those names
 * (model-assembly).
 */

/** A model this big draws as its bounding box - more triangles than the
 * whole of a well-filled hall. */
export const MODEL_TRIANGLE_LIMIT = 500_000
/** Every model in the room together; past this, the rest draw as boxes. */
export const SCENE_TRIANGLE_BUDGET = 2_000_000

/** How long an unused model stays parsed before it is freed (ms). */
const RELEASE_AFTER_MS = 30_000

export interface ModelEntry {
  status: "loading" | "ready" | "error"
  scene: THREE.Group | null
  /** Its triangles, once loaded. */
  triangles: number
  /** Its own bounding box, as authored. */
  box: THREE.Box3 | null
  /** The bays and covers it names (`bay:` / `empty:` nodes). */
  anchors: { bays: string[]; empties: string[] }
}

const NO_ANCHORS = { bays: [] as string[], empties: [] as string[] }

/** Tag every node with its glTF name (`userData.gltfName`). */
function keepNodeNames(gltf: {
  parser: {
    json: { nodes?: { name?: string }[] }
    associations: Map<unknown, { nodes?: number } | undefined>
  }
}) {
  const nodes = gltf.parser.json.nodes ?? []
  gltf.parser.associations.forEach((ref, obj) => {
    if (!(obj instanceof THREE.Object3D) || ref?.nodes === undefined) return
    const name = nodes[ref.nodes]?.name
    if (typeof name === "string") obj.userData.gltfName = name
  })
}

interface CacheSlot {
  entry: ModelEntry
  refs: number
  listeners: Set<() => void>
  timer: ReturnType<typeof setTimeout> | null
}

const cache = new Map<string, CacheSlot>()

function countTriangles(obj: THREE.Object3D): number {
  let n = 0
  obj.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return
    const m = o
    const g = m.geometry
    n += (g.index ? g.index.count : g.getAttribute("position").count) / 3
  })
  return Math.round(n)
}

function disposeScene(obj: THREE.Object3D) {
  obj.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return
    const m = o
    m.geometry.dispose()
    for (const mat of Array.isArray(m.material) ? m.material : [m.material]) {
      for (const v of Object.values(mat)) {
        if (v instanceof THREE.Texture) v.dispose()
      }
      mat.dispose()
    }
  })
}

/**
 * A binary glTF parsed as the room uses it: meshopt and quantized
 * attributes decoded, every node tagged with its glTF name. A pack's baked
 * ambient occlusion (`occlusionTexture` on TEXCOORD_1, export spec v1.8)
 * comes out as the material's `aoMap` on UV channel 1 and the geometry's
 * `uv1`; the assembly, LED, cover and instancing paths share both.
 */
export async function parseModel(buf: ArrayBuffer): Promise<THREE.Group> {
  const loader = new GLTFLoader()
  loader.setMeshoptDecoder(MeshoptDecoder)
  const gltf = await loader.parseAsync(buf, "")
  keepNodeNames(gltf)
  const scene = gltf.scene
  scene.updateMatrixWorld(true)
  return scene
}

/** Whether any material in `obj` carries a baked ambient occlusion map. */
export function hasBakedAo(obj: THREE.Object3D | null | undefined): boolean {
  let found = false
  obj?.traverse((o) => {
    if (found || !(o instanceof THREE.Mesh)) return
    const mats = Array.isArray(o.material) ? o.material : [o.material]
    if (mats.some((m) => (m as THREE.MeshStandardMaterial).aoMap)) found = true
  })
  return found
}

function load(url: string, slot: CacheSlot) {
  const done = (patch: Partial<ModelEntry>) => {
    slot.entry = { ...slot.entry, ...patch }
    slot.listeners.forEach((fn) => fn())
  }
  fetch(url, { credentials: "same-origin" })
    .then((r) => {
      if (!r.ok) throw new Error(String(r.status))
      return r.arrayBuffer()
    })
    .then((buf) => parseModel(buf))
    .then((scene) => {
      done({
        status: "ready",
        scene,
        triangles: countTriangles(scene),
        box: new THREE.Box3().setFromObject(scene),
        anchors: anchorNames(scene),
      })
    })
    .catch(() => done({ status: "error" }))
}

function acquire(url: string): CacheSlot {
  let slot = cache.get(url)
  if (!slot) {
    slot = {
      entry: {
        status: "loading",
        scene: null,
        triangles: 0,
        box: null,
        anchors: NO_ANCHORS,
      },
      refs: 0,
      listeners: new Set(),
      timer: null,
    }
    cache.set(url, slot)
    load(url, slot)
  }
  if (slot.timer) {
    clearTimeout(slot.timer)
    slot.timer = null
  }
  slot.refs += 1
  return slot
}

function release(url: string) {
  const slot = cache.get(url)
  if (!slot) return
  slot.refs -= 1
  if (slot.refs > 0) return
  slot.timer = setTimeout(() => {
    if (slot.refs > 0) return
    cache.delete(url)
    if (slot.entry.scene) disposeScene(slot.entry.scene)
  }, RELEASE_AFTER_MS)
}

/** The model at `url` once it has loaded or failed, outside React (the
 * studio renderer). Holds it in the shared cache until `releaseModel`. */
export function acquireModel(url: string): Promise<ModelEntry> {
  const slot = acquire(url)
  return new Promise((resolve) => {
    const check = () => {
      if (slot.entry.status === "loading") return
      slot.listeners.delete(check)
      resolve(slot.entry)
    }
    slot.listeners.add(check)
    check()
  })
}

export function releaseModel(url: string) {
  release(url)
}

/** The model at `url` (null: no model), loading it on first use. Kicks a
 * frame when it lands - the room draws on demand. */
export function useDeviceModel(url: string | null): ModelEntry | null {
  const invalidate = useThree((s) => s.invalidate)
  const [, bump] = useState(0)
  useEffect(() => {
    if (!url) return
    const slot = acquire(url)
    const fn = () => {
      bump((n) => n + 1)
      invalidate()
    }
    slot.listeners.add(fn)
    return () => {
      slot.listeners.delete(fn)
      release(url)
    }
  }, [url, invalidate])
  return url ? (cache.get(url)?.entry ?? null) : null
}

/** Several models at once (a device's installed parts), by URL. */
export function useDeviceModels(
  urls: readonly string[]
): Map<string, ModelEntry> {
  const invalidate = useThree((s) => s.invalidate)
  const [, bump] = useState(0)
  const key = [...new Set(urls)].sort().join("\n")
  useEffect(() => {
    if (!key) return
    const list = key.split("\n")
    const fn = () => {
      bump((n) => n + 1)
      invalidate()
    }
    const slots = list.map((u) => acquire(u))
    slots.forEach((s) => s.listeners.add(fn))
    return () => {
      slots.forEach((s) => s.listeners.delete(fn))
      list.forEach((u) => release(u))
    }
  }, [key, invalidate])
  const out = new Map<string, ModelEntry>()
  for (const u of key ? key.split("\n") : []) {
    const e = cache.get(u)?.entry
    if (e) out.set(u, e)
  }
  return out
}

/** Installed parts ready to pose: each bay's loaded module model. */
export interface ReadyPart {
  bay: string
  position: string
  entry: ModelEntry
}

/** The parts of `planned` whose models have loaded. */
export function readyParts(
  planned: readonly { bay: string; position: string; url: string }[],
  entries: ReadonlyMap<string, ModelEntry>
): ReadyPart[] {
  const out: ReadyPart[] = []
  for (const p of planned) {
    const e = entries.get(p.url)
    if (e?.status === "ready" && e.scene)
      out.push({ bay: p.bay, position: p.position, entry: e })
  }
  return out
}

/** The model's fitted placement: its upright size (m) and the transform
 * that stands it on the origin, centred, front on −Z. */
export function fittedModel(
  box: THREE.Box3,
  model: Pick<SceneModel, "fit" | "up" | "front">,
  target: { w?: number; h?: number; d?: number } | null
): {
  rotation: THREE.Euler
  scale: number
  position: [number, number, number]
  size: [number, number, number]
} {
  const [rx, ry, rz] = modelRotation(model.up, model.front)
  // Tip first (X), then turn (Y).
  const rotation = new THREE.Euler(rx, ry, rz, "YXZ")
  const upright = box
    .clone()
    .applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(rotation))
  const s3 = upright.getSize(new THREE.Vector3())
  const scale = modelScale([s3.x, s3.y, s3.z], target, model.fit)
  const c = upright.getCenter(new THREE.Vector3())
  return {
    rotation,
    scale,
    position: [-c.x * scale, -upright.min.y * scale, -c.z * scale],
    size: [s3.x * scale, s3.y * scale, s3.z * scale],
  }
}

/** One placed copy of a loaded model, fitted as configured. Its meshes
 * never take the pointer - the caller's hit box does, one cheap box
 * instead of a raycast through every triangle. */
export function PlacedModel({
  entry,
  fit,
  ghosted = false,
  parts = [],
  bays = null,
  emptyMode = "filler",
  leds,
  showPlugs = false,
  overlay,
}: {
  entry: ModelEntry
  fit: ReturnType<typeof fittedModel>
  ghosted?: boolean
  /** Installed modules to pose at their `bay:` nodes (model-assembly). */
  parts?: readonly ReadyPart[]
  /** The device's bays: which covers show. Null draws the model as
   * authored. */
  bays?: readonly ModelBay[] | null
  emptyMode?: ModelEmptyMode
  /** The device's status LEDs (led-binding) and the port covers its ports
   * in use hide (port-covers). Undefined leaves the lights as authored
   * (dark); null, or a light it doesn't name, is off. A cover hides only
   * when the payload names it. */
  leds?: DeviceLeds | null
  /** Seat the plugs `leds` names in its cabled ports (port-plugs) - the
   * full model up close, never a far copy. Skipped while ghosted. */
  showPlugs?: boolean
  /** Drawn in the assembled model's own frame, beside it: a viewer's bay
   * hit boxes. Gets the assembled root and the bays a part was posed in. */
  overlay?: (root: THREE.Object3D, drawn: ReadonlySet<string>) => ReactNode
}) {
  const invalidate = useThree((s) => s.invalidate)
  const partsKey = parts
    .map((p) => `${p.bay}\u0001${p.position}\u0001${p.entry.scene?.uuid}`)
    .join("\u0000")
  const baysKey = bays
    ? bays.map((b) => `${b.name}\u0001${b.installed ? 1 : 0}`).join("\u0000")
    : null
  const { root: obj, drawn } = useMemo(() => {
    const assembled = assembleModel(
      entry.scene!,
      parts.map((p) => ({
        bay: p.bay,
        position: p.position,
        scene: p.entry.scene!,
      })),
      bays,
      emptyMode
    )
    assembled.root.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return
      const m = o
      m.raycast = () => {}
      m.castShadow = true
      m.receiveShadow = true
    })
    return assembled
    // The keys stand for parts and bays: a re-render with equal ones keeps
    // the assembled copy.
  }, [entry.scene, partsKey, baysKey, emptyMode])
  // Status LEDs: each led: node's meshes take the shared material for its
  // state - on a state change only (the key), never per frame. Skipped
  // while ghosted; the ghost effect below puts these materials back after.
  const bound = useMemo(() => findLeds(obj), [obj])
  const reduced = useMemo(() => prefersReducedMotion(), [])
  const key = leds === undefined ? null : ledsKey(leds)
  const [blinks, setBlinks] = useState(false)
  useEffect(() => {
    if (key === null || ghosted || bound.length === 0) {
      setBlinks(false)
      return
    }
    setBlinks(applyLeds(bound, leds, reduced))
    invalidate()
    // `key` stands for `leds`: a poll that changed nothing applies nothing.
  }, [bound, key, ghosted, reduced, invalidate])
  useLedBlink(blinks)
  // Port covers: hidden for the ports the payload names, shown otherwise.
  const covers = useMemo(() => findPortCovers(obj), [obj])
  const coverKey = coversKey(leds)
  useEffect(() => {
    if (covers.length && applyPortCovers(covers, leds)) invalidate()
    // `coverKey` stands for `leds`' covers.
  }, [covers, coverKey, invalidate])
  // Focus ghosting: a see-through copy with its own materials, made only
  // while it is ghosted and dropped after.
  useEffect(() => {
    if (!ghosted) return
    const swapped: [THREE.Mesh, THREE.Material | THREE.Material[]][] = []
    const made: THREE.Material[] = []
    obj.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return
      const m = o
      swapped.push([m, m.material])
      const ghost = new THREE.MeshStandardMaterial({
        color: "#71717a",
        transparent: true,
        opacity: 0.12,
        depthWrite: false,
      })
      made.push(ghost)
      m.material = ghost
    })
    return () => {
      for (const [m, mat] of swapped) m.material = mat
      made.forEach((m) => m.dispose())
    }
  }, [obj, ghosted])
  return (
    <group position={fit.position} scale={fit.scale}>
      <group rotation={fit.rotation}>
        <primitive object={obj} />
        {showPlugs && !ghosted && leds?.plugs?.length ? (
          <PortPlugs root={obj} plugs={leds.plugs} />
        ) : null}
        {overlay?.(obj, drawn)}
      </group>
    </group>
  )
}
