import { useEffect, useLayoutEffect, useMemo, useRef } from "react"
import { useFrame, useThree } from "@react-three/fiber"
import * as THREE from "three"

import type { CordEnd, Vec3 } from "@/lib/cord-run"
import { recolourChannel } from "@/lib/fibre-colours"
import type { RecolourChannel } from "@/lib/fibre-colours"
import { parseAnchor } from "@/lib/model-assembly"
import {
  plugColours,
  plugsKey,
  plugUrls,
  receptacleNames,
} from "@/lib/port-plugs"
import type { CordCable, PortPlug } from "@/lib/port-plugs"

import { useCordEnds } from "./cord-ends"
import { useDeviceModels } from "./device-model"
import type { ModelEntry } from "./device-model"
import { usePlugOverlay } from "./plug-overlay"

/**
 * Parts seated in a device's ports (docs/dcim/model-packs.md → Accessory
 * types, export spec §13 v1.9): per port the server names (lib/port-plugs)
 * up to two stacked parts on the assembled model -
 *
 * - the **transceiver** at the port's `port:` anchor;
 * - the **cord** at the transceiver's `port:<connector>` empty (anchor ×
 *   that empty's transform in the transceiver), or at the port's anchor
 *   when the port has no transceiver (an RJ45 jack, an LC panel port, a
 *   power inlet) or the transceiver's model has no such empty. A cord
 *   waits for its transceiver's model, so it never jumps.
 *
 * A part is authored like the anchor - origin at the mating face, +Z out
 * along the cable, +Y up - so seating it is composing transforms. Parts
 * load through the device model cache (one download per part for the
 * whole room) and draw instanced: ONE InstancedMesh per mesh of a part for
 * every port that takes it. The recoloured materials (`CABLE`, `FIBRE`,
 * `LC_BODY`, lib/fibre-colours) are cloned once per source material in
 * white and take each port's colour as their instance colour.
 *
 * In the 3D room each cord's `cable` empty is published (cord-ends) so
 * the cable run starts there. Parts never take the pointer: the port
 * markers reach over them (port-pick).
 *
 * Ghosted (the Pluggables choice, or the Ports overlay), the parts draw
 * see-through and grey (ghostMaterialOf) without writing depth, so the
 * markers read through them - except the hovered or selected port's, which
 * stays solid. Each port's part front is published to the markers
 * (plug-overlay), which then draw their wash on it, not at the cage mouth.
 */

/** A part's mesh with its matrix in the part's own frame. */
interface PartMesh {
  geometry: THREE.BufferGeometry
  material: THREE.Material | THREE.Material[]
  local: THREE.Matrix4
  recolour: boolean
  /** Which port colour it takes, or null to keep its own. */
  channel: RecolourChannel | null
}

/** The white clones of recoloured materials, per source material. Freed
 * with the source (a WeakMap): the model cache disposes the source. */
const whiteClones = new WeakMap<THREE.Material, THREE.Material>()

function whiteOf(mat: THREE.Material): THREE.Material {
  let w = whiteClones.get(mat)
  if (!w) {
    w = mat.clone()
    if ("color" in w && w.color instanceof THREE.Color) w.color.set("#ffffff")
    whiteClones.set(mat, w)
  }
  return w
}

const channelOf = (m: THREE.Material) => recolourChannel(m.name)

/** A ghosted part's opacity and how much of its colour it keeps. */
export const GHOST_OPACITY = 0.25
const GHOST_SATURATION = 0.15

/** `c` greyed toward its own luminance, in place: a ghost keeps a hint of
 * its colour, never enough to fight the overlay's. */
export function ghostColour(c: THREE.Color): THREE.Color {
  const l = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b
  c.r = l + (c.r - l) * GHOST_SATURATION
  c.g = l + (c.g - l) * GHOST_SATURATION
  c.b = l + (c.b - l) * GHOST_SATURATION
  return c
}

/** The ghosted clones, per source material (freed with it, a WeakMap). */
const ghostClones = new WeakMap<THREE.Material, THREE.Material>()

/**
 * `mat`'s ghost: see-through at GHOST_OPACITY, greyed, writing no depth,
 * so what stands behind it (a port's wash) shows through and it never
 * hides another ghost. Transparent, it draws after the viewer's AO pass,
 * never through it (viewer-look). One clone per source material.
 */
export function ghostMaterialOf(mat: THREE.Material): THREE.Material {
  let g = ghostClones.get(mat)
  if (!g) {
    g = mat.clone()
    g.transparent = true
    g.opacity = mat.opacity * GHOST_OPACITY
    g.depthWrite = false
    if ("color" in g && g.color instanceof THREE.Color) ghostColour(g.color)
    if ("emissive" in g && g.emissive instanceof THREE.Color)
      ghostColour(g.emissive)
    ghostClones.set(mat, g)
  }
  return g
}

function ghostOf(
  m: THREE.Material | THREE.Material[]
): THREE.Material | THREE.Material[] {
  return Array.isArray(m) ? m.map(ghostMaterialOf) : ghostMaterialOf(m)
}

/** The meshes of a loaded part, each with its matrix in the part's frame. */
export function partMeshes(scene: THREE.Object3D): PartMesh[] {
  scene.updateMatrixWorld(true)
  const inv = new THREE.Matrix4().copy(scene.matrixWorld).invert()
  const out: PartMesh[] = []
  scene.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return
    const mats = Array.isArray(o.material) ? o.material : [o.material]
    const channel = mats.map(channelOf).find((c) => c !== null) ?? null
    out.push({
      geometry: o.geometry,
      material: channel
        ? Array.isArray(o.material)
          ? o.material.map((m) => (channelOf(m) ? whiteOf(m) : m))
          : whiteOf(o.material)
        : o.material,
      local: new THREE.Matrix4().multiplyMatrices(inv, o.matrixWorld),
      recolour: channel !== null,
      channel,
    })
  })
  return out
}

/** Each plug's anchor matrix in `root`'s frame, or null where the model
 * has no such anchor: the chassis' `port:` nodes outside any posed part,
 * a module's inside the part posed at its bay (model-assembly tags the
 * part's root `danbyteBay`; its names have `{module}` resolved). */
/**
 * An exported empty's frame turned into a part's frame. Blender's glTF
 * exporter gives every empty (camera, light) its Y-up correction: the
 * arrow a `port:` or `cable` empty points along in Blender (its local +Z)
 * comes out as the node's local +Y, and Blender's up as its local -Z.
 * Parts are modelled +Z out of the port, +Y up (spec §13), so a part
 * seated on an empty takes the empty's matrix times this.
 */
export const EMPTY_TO_PART = new THREE.Matrix4().makeRotationX(-Math.PI / 2)

/** `m` (an empty's matrix) as the frame a part on it takes. */
function partFrame(m: THREE.Matrix4): THREE.Matrix4 {
  return m.multiply(EMPTY_TO_PART)
}

export function anchorMatrices(
  root: THREE.Object3D,
  plugs: readonly Pick<PortPlug, "port" | "bay">[]
): (THREE.Matrix4 | null)[] {
  const byBay = new Map<string | null, Map<string, THREE.Object3D>>()
  const walk = (o: THREE.Object3D, bay: string | null) => {
    const here =
      typeof o.userData.danbyteBay === "string" ? o.userData.danbyteBay : bay
    const n = o.userData.gltfName
    if (typeof n === "string") {
      const a = parseAnchor(n)
      if (a?.kind === "port") {
        let m = byBay.get(here)
        if (!m) byBay.set(here, (m = new Map()))
        if (!m.has(a.name)) m.set(a.name, o)
      }
    }
    o.children.forEach((c) => walk(c, here))
  }
  walk(root, null)
  root.updateMatrixWorld(true)
  const inv = new THREE.Matrix4().copy(root.matrixWorld).invert()
  return plugs.map((p) => {
    const node = byBay.get(p.bay ?? null)?.get(p.port)
    return node
      ? partFrame(new THREE.Matrix4().multiplyMatrices(inv, node.matrixWorld))
      : null
  })
}

/** A node of a part's own model, as a matrix in the part's frame. */
function nodeMatrix(scene: THREE.Object3D, node: THREE.Object3D) {
  scene.updateMatrixWorld(true)
  return new THREE.Matrix4()
    .copy(scene.matrixWorld)
    .invert()
    .multiply(node.matrixWorld)
}

const receptacles = new WeakMap<THREE.Object3D, Map<string, THREE.Object3D>>()

/**
 * Where a transceiver takes its cord: its `port:<connector>` empty for the
 * first of `names` it has (lib/port-plugs receptacleNames), else its one
 * `port:` empty when it has only one; as a matrix in the transceiver's
 * frame, or null (the cord then sits at the cage's anchor).
 */
export function receptacleMatrix(
  scene: THREE.Object3D,
  names: readonly string[]
): THREE.Matrix4 | null {
  let ports = receptacles.get(scene)
  if (!ports) {
    ports = new Map()
    const found = ports
    scene.traverse((o) => {
      const a = parseAnchor(
        typeof o.userData.gltfName === "string" ? o.userData.gltfName : null
      )
      if (a?.kind === "port" && !found.has(a.name.toLowerCase()))
        found.set(a.name.toLowerCase(), o)
    })
    receptacles.set(scene, found)
  }
  for (const n of names) {
    const node = ports.get(n)
    if (node) return partFrame(nodeMatrix(scene, node))
  }
  if (ports.size === 1)
    return partFrame(nodeMatrix(scene, [...ports.values()][0]))
  return null
}

/** A cord's `cable` empty (Blender may suffix a copy `cable.001`). */
export const CABLE_NODE = /^cable(\.\d+)?$/i

const cableNodes = new WeakMap<THREE.Object3D, THREE.Object3D | null>()

/** A cord's `cable` empty as a matrix in the cord's frame, or null. */
export function cableEmptyMatrix(scene: THREE.Object3D): THREE.Matrix4 | null {
  let node = cableNodes.get(scene)
  if (node === undefined) {
    node = null
    scene.traverse((o) => {
      const n =
        typeof o.userData.gltfName === "string" ? o.userData.gltfName : o.name
      if (!node && CABLE_NODE.test(n)) node = o
    })
    cableNodes.set(scene, node)
  }
  return node ? partFrame(nodeMatrix(scene, node)) : null
}

/** One part drawn at one port. */
export interface Seat {
  url: string
  /** The part's frame in the assembled root's. */
  matrix: THREE.Matrix4
  colours: Record<RecolourChannel, string>
  plug: PortPlug
  role: "transceiver" | "cord"
}

/** A loaded part's scene; undefined while it loads, null when it failed. */
export type SceneOf = (url: string) => THREE.Object3D | null | undefined

/**
 * Every part to draw, with its frame in the root's: each transceiver at
 * its anchor, each cord at its transceiver's receptacle (anchor ×
 * receptacle) - or at the anchor without a transceiver, or when the
 * transceiver's model failed or lacks the empty. A cord whose transceiver
 * is still loading waits. `anchors` lines up with `plugs` (anchorMatrices;
 * a null anchor seats nothing).
 */
export function seatParts(
  plugs: readonly PortPlug[],
  anchors: readonly (THREE.Matrix4 | null)[],
  sceneOf: SceneOf
): Seat[] {
  const out: Seat[] = []
  plugs.forEach((p, i) => {
    const anchor = anchors[i]
    if (!anchor) return
    const colours = plugColours(p)
    const t = p.transceiver_part
    if (t)
      out.push({
        url: t.url,
        matrix: anchor,
        colours,
        plug: p,
        role: "transceiver",
      })
    const c = p.cord_part
    if (!c) return
    let base = anchor
    if (t) {
      const ts = sceneOf(t.url)
      if (ts === undefined) return
      const rec = ts ? receptacleMatrix(ts, receptacleNames(p)) : null
      if (rec) base = new THREE.Matrix4().multiplyMatrices(anchor, rec)
    }
    out.push({ url: c.url, matrix: base, colours, plug: p, role: "cord" })
  })
  return out
}

/** A loaded part's own box; null while it loads or when it failed. */
export type BoxOf = (url: string) => THREE.Box3 | null

const _o = new THREE.Vector3()
const _f = new THREE.Vector3()
const _out = new THREE.Vector3()

/**
 * How far each port's parts stand out of its opening, in the root's frame
 * along the anchor's out axis, by the port's name: a transceiver's nose
 * (its box's furthest +Z), a cord's mating face (its origin), the further
 * of the two. A port whose parts stay inside the opening is left out.
 */
export function partFronts(
  plugs: readonly PortPlug[],
  anchors: readonly (THREE.Matrix4 | null)[],
  seats: readonly Seat[],
  boxOf: BoxOf
): Map<string, number> {
  const anchorOf = new Map<PortPlug, THREE.Matrix4>()
  plugs.forEach((p, i) => {
    const a = anchors[i]
    if (a) anchorOf.set(p, a)
  })
  const out = new Map<string, number>()
  for (const s of seats) {
    const a = anchorOf.get(s.plug)
    if (!a) continue
    let z = 0
    if (s.role === "transceiver") {
      const box = boxOf(s.url)
      if (!box || box.isEmpty()) continue
      z = box.max.z
    }
    _f.set(0, 0, z).applyMatrix4(s.matrix)
    _o.setFromMatrixPosition(a)
    a.extractBasis(_x, _y, _out)
    if (_out.lengthSq() < 1e-18) continue
    const d = _f.sub(_o).dot(_out.normalize())
    if (d > 1e-6) out.set(s.plug.name, Math.max(out.get(s.plug.name) ?? 0, d))
  }
  return out
}

const _p = new THREE.Vector3()
const _x = new THREE.Vector3()
const _y = new THREE.Vector3()
const _z = new THREE.Vector3()

/** A cord's `cable` empty in `world`'s frame (the room), for its run. */
export function cordEndOf(
  world: THREE.Matrix4,
  seat: THREE.Matrix4,
  cableLocal: THREE.Matrix4,
  cable: CordCable | null
): CordEnd {
  const m = new THREE.Matrix4()
    .multiplyMatrices(world, seat)
    .multiply(cableLocal)
  m.extractBasis(_x, _y, _z)
  _p.setFromMatrixPosition(m)
  const scale = _x.length()
  const v = (a: THREE.Vector3): Vec3 => {
    const n = a.clone().normalize()
    return [n.x, n.y, n.z]
  }
  return { at: [_p.x, _p.y, _p.z], x: v(_x), y: v(_y), z: v(_z), scale, cable }
}

const _m = new THREE.Matrix4()
const _c = new THREE.Color()

/** One part at many ports, instanced; `ghost` draws them see-through. */
function PartInstances({
  entry,
  seats,
  ghost = false,
}: {
  entry: ModelEntry
  seats: readonly Seat[]
  ghost?: boolean
}) {
  const invalidate = useThree((s) => s.invalidate)
  const meshes = useMemo(() => partMeshes(entry.scene!), [entry.scene])
  const count = seats.length
  const instanced = useMemo(
    () =>
      meshes.map((pm) => {
        const im = new THREE.InstancedMesh(
          pm.geometry,
          ghost ? ghostOf(pm.material) : pm.material,
          count
        )
        im.raycast = () => {}
        im.castShadow = false
        im.receiveShadow = !ghost
        return im
      }),
    [meshes, count, ghost]
  )
  useLayoutEffect(
    () => () => instanced.forEach((im) => im.dispose()),
    [instanced]
  )
  useLayoutEffect(() => {
    instanced.forEach((im, k) => {
      const channel = meshes[k].channel
      seats.forEach((s, i) => {
        im.setMatrixAt(i, _m.multiplyMatrices(s.matrix, meshes[k].local))
        if (channel) {
          _c.set(s.colours[channel])
          im.setColorAt(i, ghost ? ghostColour(_c) : _c)
        }
      })
      im.instanceMatrix.needsUpdate = true
      if (im.instanceColor) im.instanceColor.needsUpdate = true
      im.computeBoundingSphere()
    })
    invalidate()
  }, [instanced, meshes, seats, ghost, invalidate])
  return (
    <>
      {instanced.map((im) => (
        <primitive key={im.uuid} object={im} />
      ))}
    </>
  )
}

/**
 * The parts of one placed model, in its assembled root's frame (mounted
 * beside the root, as PlacedModel's overlay is). Draws nothing until a
 * part has loaded; a port whose anchor the model lacks is left out. With
 * `deviceId`, in the 3D room, it publishes where its cords' cables start.
 * `ghost` draws them see-through but the hovered or selected port's; their
 * fronts go to the device's markers (plug-overlay) scaled by `scale`, the
 * root's size in the markers' frame.
 */
export function PortPlugs({
  root,
  plugs,
  deviceId,
  ghost = false,
  scale = 1,
}: {
  root: THREE.Object3D
  plugs: readonly PortPlug[]
  deviceId?: string
  ghost?: boolean
  scale?: number
}) {
  const overlay = usePlugOverlay()
  const key = plugsKey({ plugs: [...plugs] })
  // Keyed on the values: a poll with the same plugs keeps the draws.
  // `key` stands for `plugs`.
  const list = useMemo(() => [...plugs], [key])
  const anchors = useMemo(() => anchorMatrices(root, list), [root, list])
  const urls = useMemo(() => plugUrls(list), [list])
  const entries = useDeviceModels(urls)
  const readyKey = urls
    .map((u) => {
      const e = entries.get(u)
      return `${u}:${e?.status ?? ""}:${e?.scene?.uuid ?? ""}`
    })
    .join("\u0000")
  const sceneOf = (url: string) => {
    const e = entries.get(url)
    if (!e || e.status === "loading") return undefined
    return e.status === "ready" ? e.scene : null
  }
  const seats = useMemo(
    () => seatParts(list, anchors, sceneOf),
    // `readyKey` stands for `entries`.
    [list, anchors, readyKey]
  )
  // Ghosted, the hovered and selected ports' parts stay solid: one
  // instanced draw per part and look.
  const solid = ghost ? overlay?.solid : undefined
  const solidKey = solid ? [...solid].join("\u0000") : ""
  const groups = useMemo(() => {
    const out = new Map<string, { url: string; ghost: boolean; at: Seat[] }>()
    for (const s of seats) {
      const g = ghost && !solid?.has(s.plug.name)
      const k = `${g ? 1 : 0}\u0001${s.url}`
      const e = out.get(k)
      if (e) e.at.push(s)
      else out.set(k, { url: s.url, ghost: g, at: [s] })
    }
    return [...out.entries()]
    // `solidKey` stands for `solid`.
  }, [seats, ghost, solidKey])

  // Each port's part front, for the markers' washes.
  const fronts = useMemo(() => {
    const raw = partFronts(list, anchors, seats, (url) => {
      const e = entries.get(url)
      return e?.status === "ready" ? e.box : null
    })
    for (const [k, v] of raw) raw.set(k, v * scale)
    return raw
    // `readyKey` stands for `entries`.
  }, [list, anchors, seats, readyKey, scale])
  useEffect(() => {
    overlay?.setFronts(fronts, ghost)
  }, [overlay, fronts, ghost])
  useEffect(() => {
    if (!overlay) return
    return () => overlay.setFronts(new Map(), false)
  }, [overlay])

  // Where each cord's cable starts, in the room's frame: re-published when
  // the cords or the model's place change.
  const store = useCordEnds()
  const cords = useMemo(
    () =>
      seats.flatMap((s) => {
        if (s.role !== "cord") return []
        const sc = sceneOf(s.url)
        const local = sc ? cableEmptyMatrix(sc) : null
        return local
          ? [
              {
                name: s.plug.name,
                seat: s.matrix,
                local,
                cable: s.plug.cord_part?.cable ?? null,
              },
            ]
          : []
      }),
    [seats, readyKey]
  )
  const last = useRef<{ cords: typeof cords; world: number[] } | null>(null)
  useFrame(() => {
    if (!store || !deviceId) return
    root.updateWorldMatrix(true, false)
    const world = root.matrixWorld.elements
    const prev = last.current
    if (
      prev &&
      prev.cords === cords &&
      prev.world.every((v, i) => Math.abs(v - world[i]) < 1e-7)
    )
      return
    last.current = { cords, world: [...world] }
    const ends = new Map<string, CordEnd>()
    for (const c of cords)
      ends.set(c.name, cordEndOf(root.matrixWorld, c.seat, c.local, c.cable))
    store.setDevice(deviceId, ends)
  })
  useEffect(() => {
    if (!store || !deviceId) return
    return () => {
      last.current = null
      store.setDevice(deviceId, null)
    }
  }, [store, deviceId])

  return (
    <>
      {groups.map(([gk, g]) => {
        const e = entries.get(g.url)
        if (e?.status !== "ready" || !e.scene) return null
        return (
          <PartInstances key={gk} entry={e} seats={g.at} ghost={g.ghost} />
        )
      })}
    </>
  )
}
