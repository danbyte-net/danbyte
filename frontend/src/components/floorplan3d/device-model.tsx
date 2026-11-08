import { useEffect, useMemo, useState } from "react"
import { useThree } from "@react-three/fiber"
import * as THREE from "three"
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js"
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js"

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
    .then((buf) => {
      const loader = new GLTFLoader()
      loader.setMeshoptDecoder(MeshoptDecoder)
      return loader.parseAsync(buf, "")
    })
    .then((gltf) => {
      const scene = gltf.scene
      scene.updateMatrixWorld(true)
      done({
        status: "ready",
        scene,
        triangles: countTriangles(scene),
        box: new THREE.Box3().setFromObject(scene),
      })
    })
    .catch(() => done({ status: "error" }))
}

function acquire(url: string): CacheSlot {
  let slot = cache.get(url)
  if (!slot) {
    slot = {
      entry: { status: "loading", scene: null, triangles: 0, box: null },
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
}: {
  entry: ModelEntry
  fit: ReturnType<typeof fittedModel>
  ghosted?: boolean
}) {
  const obj = useMemo(() => {
    const c = entry.scene!.clone(true)
    c.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return
      const m = o
      m.raycast = () => {}
      m.castShadow = true
      m.receiveShadow = true
    })
    return c
  }, [entry.scene])
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
      </group>
    </group>
  )
}
