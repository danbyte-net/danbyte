import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react"
import type { ReactNode } from "react"
import { useFrame, useThree } from "@react-three/fiber"
import * as THREE from "three"

import type { ModelBay, ModelEmptyMode } from "@/lib/api"
import { ledsKey, prefersReducedMotion } from "@/lib/led-state"
import type { DeviceLeds } from "@/lib/led-state"
import { plannedParts } from "@/lib/model-assembly"
import { coverHidden, coversKey } from "@/lib/port-covers"
import type { PlannedPart } from "@/lib/model-assembly"
import type { PluggablesMode } from "@/lib/pluggables-pref"

import { isCameraMoving } from "./camera-motion"
import {
  MODEL_TRIANGLE_LIMIT,
  ModelOverlays,
  fittedModel,
  readyParts,
  sceneTriangleBudget,
  useDeviceModels,
} from "./device-model"
import type { ModelEntry, ReadyPart } from "./device-model"
import { findLeds, useLedBlink } from "./led-binding"
import {
  buildLedBatch,
  fillLedStates,
  ledBatchMaterial,
  ledStateTexture,
} from "./led-instances"
import type { BatchLed } from "./led-instances"
import { assembleModel } from "./model-assembly"
import { findPortCovers } from "./port-covers"
import {
  createModelBudget,
  instanceGroupKey,
  parseLevels,
  rackSlotPose,
  rackSlotTargetM,
  rackToWorld,
  screenSizePx,
  wantedRackLevel,
} from "./rack-models"
import type {
  ModelBudget,
  ModelWant,
  RackModelLevel,
  ScreenLens,
  SlotPose,
} from "./rack-models"
import { deviceBoxM } from "./world"
import type { SceneDevice, SceneModel, SceneRack } from "./world"

/**
 * Racked devices drawn as their 3D models (docs/features/floor-plans.md →
 * 3D models in racks). A rack in its detail tier asks, per device with a
 * model, for the level its size on screen wants (rack-models: full when
 * big, the far copy smaller, the photo box beyond); the room's shared
 * triangle budget grants it, biggest first. Both levels draw here, ONE
 * instanced mesh per part of the model for every device in the rack that
 * draws the same model with the same parts and covers - a rack of forty
 * identical switches costs one model's draw calls, not forty - and one
 * more for all their status LEDs (led-instances). A port cover a device's
 * cabling hides (port-covers) is dropped from that device's instance alone
 * (a zero-scale matrix), so the group stays shared.
 *
 * What rides on a full model per device - its plugs, stack heads, bay hit
 * boxes, port markers, hover and selection - stays in DeviceMesh, in the
 * device's slot: the anchors come from the group's one shared assembled
 * copy, which is never drawn itself (InstancedModelOverlays).
 */

/** The room's budget, shared by its floor devices and every rack. */
export const ModelBudgetContext = createContext<ModelBudget | null>(null)

export function newModelBudget(): ModelBudget {
  return createModelBudget(sceneTriangleBudget(), MODEL_TRIANGLE_LIMIT)
}

/** The room's budget - passed in, else from context; a view with no room
 * (a rack page) gets its own. */
export function useModelBudget(given?: ModelBudget | null): ModelBudget {
  const shared = useContext(ModelBudgetContext)
  const [own] = useState(() => (given || shared ? null : newModelBudget()))
  return given ?? shared ?? own!
}

/** The racked devices the room draws with a model now (comma-joined ids,
 * sorted) - whose LEDs it asks for. */
export function useDrawnModelDevices(budget: ModelBudget): string[] {
  const key = useSyncExternalStore(budget.subscribe, budget.drawnKey)
  return useMemo(() => (key ? key.split(",") : []), [key])
}

/** What one racked device draws as its model. */
export interface RackModelDraw {
  level: "full" | "far"
  entry: ModelEntry
  parts: readonly ReadyPart[]
  fit: ReturnType<typeof fittedModel>
  pose: SlotPose
  bays: ModelBay[] | null
  emptyMode: ModelEmptyMode
  /** Devices sharing it (and the level) draw as one instanced group. */
  groupKey: string
}

const NONE: ReadonlyMap<string, RackModelLevel> = new Map()
const NO_DRAWS: ReadonlyMap<string, RackModelDraw> = new Map()

const farUrlOf = (m: SceneModel) => m.far_url || m.url

/** One fit per loaded model and target, shared by every device wearing
 * it - a rack of identical switches computes it once. */
const fits = new WeakMap<
  ModelEntry,
  Map<string, ReturnType<typeof fittedModel>>
>()

function sharedFit(
  entry: ModelEntry,
  model: SceneModel,
  target: { w: number; h: number }
): ReturnType<typeof fittedModel> {
  let byKey = fits.get(entry)
  if (!byKey) {
    byKey = new Map()
    fits.set(entry, byKey)
  }
  const key = `${model.fit}|${model.up}|${model.front}|${target.w}|${target.h}`
  let f = byKey.get(key)
  if (!f) {
    f = fittedModel(entry.box!, model, target)
    byKey.set(key, f)
  }
  return f
}

/** How much a device's size on screen changes before the budget re-ranks
 * it (a share of the size it was ranked at). */
const RANK_STEP = 0.2

const _frustum = new THREE.Frustum()
const _vp = new THREE.Matrix4()

/** The camera's lens for screenSizePx, in a canvas `heightPx` tall. */
function lensOf(camera: THREE.Camera, heightPx: number): ScreenLens {
  return {
    projY: camera.projectionMatrix.elements[5],
    ortho: (camera as THREE.OrthographicCamera).isOrthographicCamera === true,
    heightPx,
  }
}

const ready = (e: ModelEntry | undefined): e is ModelEntry =>
  e?.status === "ready" && !!e.scene && !!e.box

/**
 * A rack's devices' models: the level each wants by its size on screen
 * (with hysteresis, re-tiered once the camera settles), the files that needs,
 * what the room's budget grants, and how each granted device draws.
 * `active` is the rack's detail tier; off, it asks for nothing.
 */
export function useRackModels({
  owner,
  rack,
  devices,
  rackDepthM,
  centre,
  rotY,
  active,
  skip,
  budget: given,
}: {
  /** The rack's tile id: its share of the budget. */
  owner: string
  rack: SceneRack
  devices: readonly SceneDevice[]
  rackDepthM: number
  centre: readonly [number, number]
  rotY: number
  active: boolean
  /** Devices that keep their box (focus-ghosted). */
  skip?: ReadonlySet<string> | null
  /** The room's budget (else context, else the rack's own). */
  budget?: ModelBudget | null
}): ReadonlyMap<string, RackModelDraw> {
  const budget = useModelBudget(given)
  const invalidate = useThree((s) => s.invalidate)
  const candidates = useMemo(
    () =>
      active
        ? devices.filter(
            (d) =>
              !!d.model &&
              d.position != null &&
              d.u_height > 0 &&
              !skip?.has(d.id)
          )
        : [],
    [active, devices, skip]
  )
  // Each candidate's centre in the room, the reach of its box (for the
  // view test) and its face's width (for its size on screen).
  const spots = useMemo(
    () =>
      candidates.map((d) => {
        const b = deviceBoxM(rack, d, 0, rackDepthM)
        const [x, y, z] = rackToWorld(centre, rotY, [b.dx, b.y + b.h / 2, b.dz])
        const face = rackSlotTargetM(rack, d).w
        return {
          sphere: new THREE.Sphere(
            new THREE.Vector3(x, y, z),
            Math.hypot(face, b.h, b.dd) / 2
          ),
          face,
        }
      }),
    [candidates, rack, rackDepthM, centre, rotY]
  )
  const levelsRef = useRef(new Map<string, RackModelLevel>())
  const sizesRef = useRef(new Map<string, { px: number; inView: boolean }>())
  const [wanted, setWanted] = useState<{
    levels: ReadonlyMap<string, RackModelLevel>
    sizes: ReadonlyMap<string, { px: number; inView: boolean }>
  }>({ levels: NONE, sizes: new Map() })
  // A rack leaving its detail tier, or a device leaving the candidates,
  // gives its levels up at once - no frame needed.
  useEffect(() => {
    const ids = new Set(candidates.map((d) => d.id))
    let dropped = false
    for (const id of [...levelsRef.current.keys()])
      if (!ids.has(id)) {
        levelsRef.current.delete(id)
        dropped = true
      }
    if (dropped)
      setWanted({
        levels: new Map(levelsRef.current),
        sizes: new Map(sizesRef.current),
      })
    // A rack just come near: measure on the next frame.
    if (candidates.length) invalidate()
  }, [candidates, invalidate])
  useFrame(({ camera, size }) => {
    if (candidates.length === 0 || isCameraMoving()) return
    let changed = false
    const p = camera.position
    const lens = lensOf(camera, size.height)
    _frustum.setFromProjectionMatrix(
      _vp.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
    )
    for (let i = 0; i < candidates.length; i++) {
      const d = candidates[i]
      const { sphere, face } = spots[i]
      const px = screenSizePx(face, p.distanceTo(sphere.center), lens)
      const cur = levelsRef.current.get(d.id) ?? "box"
      const next = wantedRackLevel(px, cur)
      const inView = _frustum.intersectsSphere(sphere)
      // The budget ranks by these: it hears again when a device comes
      // into view or leaves it, or grows or shrinks by a fifth - not on
      // every settle.
      const was = sizesRef.current.get(d.id)
      if (
        !was ||
        was.inView !== inView ||
        Math.abs(px - was.px) > was.px * RANK_STEP
      ) {
        sizesRef.current.set(d.id, { px: Math.round(px), inView })
        if (levelsRef.current.has(d.id) || next !== "box") changed = true
      }
      if (next !== cur) {
        if (next === "box") levelsRef.current.delete(d.id)
        else levelsRef.current.set(d.id, next)
        changed = true
      }
    }
    if (changed)
      setWanted({
        levels: new Map(levelsRef.current),
        sizes: new Map(sizesRef.current),
      })
  })

  // The chassis files: every wanting device's far copy (a full one keeps
  // it at hand for when it steps back), and the full model up close.
  const byId = useMemo(
    () => new Map(candidates.map((d) => [d.id, d])),
    [candidates]
  )
  const chassisUrls = useMemo(() => {
    const out = new Set<string>()
    for (const [id, level] of wanted.levels) {
      const m = byId.get(id)?.model
      if (!m) continue
      out.add(farUrlOf(m))
      if (level === "full") out.add(m.url)
    }
    return [...out]
  }, [wanted, byId])
  const chassis = useDeviceModels(chassisUrls)
  // Each device's parts at both levels, once its chassis names its bays.
  const planned = useMemo(() => {
    const out = new Map<string, { full: PlannedPart[]; far: PlannedPart[] }>()
    for (const [id, level] of wanted.levels) {
      const m = byId.get(id)?.model
      if (!m?.bays?.length) continue
      const farE = chassis.get(farUrlOf(m))
      const fullE = level === "full" ? chassis.get(m.url) : undefined
      out.set(id, {
        far: ready(farE)
          ? plannedParts(m.bays, new Set(farE.anchors.bays), true)
          : [],
        full: ready(fullE)
          ? plannedParts(m.bays, new Set(fullE.anchors.bays))
          : [],
      })
    }
    return out
  }, [wanted, byId, chassis])
  const partUrls = useMemo(() => {
    const out = new Set<string>()
    for (const p of planned.values())
      for (const part of [...p.full, ...p.far]) out.add(part.url)
    return [...out]
  }, [planned])
  const partEntries = useDeviceModels(partUrls)

  // What each wanting device costs at each level, loaded.
  const wants = useMemo(() => {
    const out: ModelWant[] = []
    for (const [id, level] of wanted.levels) {
      const m = byId.get(id)?.model
      if (!m) continue
      const cost = (e: ModelEntry | undefined, parts: PlannedPart[]) =>
        ready(e)
          ? readyParts(parts, partEntries).reduce(
              (n, r) => n + r.entry.triangles,
              e.triangles
            )
          : null
      const p = planned.get(id)
      const seen = wanted.sizes.get(id)
      out.push({
        id,
        px: seen?.px ?? 0,
        inView: seen?.inView ?? true,
        level: level === "full" ? "full" : "far",
        full: level === "full" ? cost(chassis.get(m.url), p?.full ?? []) : null,
        far: cost(chassis.get(farUrlOf(m)), p?.far ?? []),
      })
    }
    return out
  }, [wanted, byId, chassis, planned, partEntries])
  const wantsKey = wants
    .map(
      (w) => `${w.id}:${w.level}:${w.px}:${w.inView ? 1 : 0}:${w.full}:${w.far}`
    )
    .join(",")
  useEffect(() => {
    budget.setWants(owner, wants)
    // `wantsKey` stands for `wants`.
  }, [budget, owner, wantsKey])
  useEffect(() => () => budget.setWants(owner, []), [budget, owner])
  const grantKey = useSyncExternalStore(budget.subscribe, () =>
    budget.ownerKey(owner)
  )
  const granted = useMemo(() => parseLevels(grantKey), [grantKey])

  return useMemo(() => {
    if (granted.size === 0) return NO_DRAWS
    const out = new Map<string, RackModelDraw>()
    for (const [id, level] of granted) {
      if (level === "box") continue
      const d = byId.get(id)
      const m = d?.model
      if (!d || !m) continue
      const url = level === "full" ? m.url : farUrlOf(m)
      const entry = chassis.get(url)
      if (!ready(entry)) continue
      const p = planned.get(id)
      const parts = readyParts(
        (level === "full" ? p?.full : p?.far) ?? [],
        partEntries
      )
      const fit = sharedFit(entry, m, rackSlotTargetM(rack, d))
      const bays = m.bays?.length ? m.bays : null
      const emptyMode = m.empty_mode ?? "filler"
      out.set(id, {
        level,
        entry,
        parts,
        fit,
        pose: rackSlotPose(rack, d, rackDepthM, fit.size),
        bays,
        emptyMode,
        groupKey: instanceGroupKey(
          url,
          parts.map((r) => ({
            bay: r.bay,
            url: `${r.position}\u0001${r.entry.scene?.uuid}`,
          })),
          bays,
          emptyMode
        ),
      })
    }
    return out
  }, [granted, byId, chassis, planned, partEntries, rack, rackDepthM])
}

// ── instanced models ────────────────────────────────────────────────────────

const _slot = new THREE.Matrix4()
const _fit = new THREE.Matrix4()
const _m = new THREE.Matrix4()
const _q = new THREE.Quaternion()
const _p = new THREE.Vector3()
const _s = new THREE.Vector3()
const Y_AXIS = new THREE.Vector3(0, 1, 0)

/** A device's slot and fit as one matrix: the model's frame in the rack. */
export function slotMatrix(
  pose: SlotPose,
  fit: ReturnType<typeof fittedModel>,
  out = new THREE.Matrix4()
): THREE.Matrix4 {
  _q.setFromAxisAngle(Y_AXIS, pose.rotY)
  _p.set(...pose.position)
  _slot.compose(_p, _q, _s.set(1, 1, 1))
  _fit
    .makeRotationFromEuler(fit.rotation)
    .premultiply(new THREE.Matrix4().makeScale(fit.scale, fit.scale, fit.scale))
    .premultiply(new THREE.Matrix4().makeTranslation(...fit.position))
  return out.multiplyMatrices(_slot, _fit)
}

export interface PartMesh {
  mesh: THREE.Mesh
  /** Its matrix in the frame the assembled root stands in - the root's
   * own transform included, as PlacedModel draws it. */
  local: THREE.Matrix4
  led: { name: string; bay: string | null; off: THREE.Color } | null
  /** The port cover it belongs to, if any. */
  cover: { name: string; bay: string | null } | null
}

/** An instance's matrix while its cover hides: nothing drawn. */
const HIDDEN = new THREE.Matrix4().makeScale(0, 0, 0)

/** The visible meshes of an assembled copy, each with its matrix in the
 * frame the copy stands in, the LED it lights and the port cover it is
 * part of, if any. */
export function partMeshes(root: THREE.Object3D): PartMesh[] {
  root.updateMatrixWorld(true)
  const inv = root.parent
    ? new THREE.Matrix4().copy(root.parent.matrixWorld).invert()
    : new THREE.Matrix4()
  const leds = new Map<THREE.Mesh, { name: string; bay: string | null }>()
  for (const l of findLeds(root))
    for (const m of l.meshes) leds.set(m, { name: l.name, bay: l.bay })
  const covers = new Map<THREE.Mesh, { name: string; bay: string | null }>()
  for (const c of findPortCovers(root))
    for (const m of c.meshes) covers.set(m, { name: c.name, bay: c.bay })
  const out: PartMesh[] = []
  const walk = (o: THREE.Object3D) => {
    if (!o.visible) return
    if (o instanceof THREE.Mesh) {
      const led = leds.get(o)
      const mat = Array.isArray(o.material) ? o.material[0] : o.material
      const off =
        mat instanceof THREE.MeshStandardMaterial
          ? mat.color.clone()
          : new THREE.Color("#111111")
      out.push({
        mesh: o,
        local: new THREE.Matrix4().multiplyMatrices(inv, o.matrixWorld),
        led: led ? { ...led, off } : null,
        cover: covers.get(o) ?? null,
      })
    }
    o.children.forEach(walk)
  }
  walk(root)
  return out
}

/** A group's one assembled copy - never drawn itself: its meshes are what
 * the group's instanced meshes draw, and its anchors are where every
 * member's plugs, stack heads and bay boxes go. */
export interface SharedAssembly {
  root: THREE.Object3D
  drawn: ReadonlySet<string>
  meshes: readonly PartMesh[]
}

/** Per loaded chassis, its assemblies by group key - freed with the
 * chassis' scene (the model cache drops it). */
const assemblies = new WeakMap<THREE.Object3D, Map<string, SharedAssembly>>()

/** The one assembled copy of a draw's group, made on first use. */
export function sharedAssembly(
  draw: Pick<
    RackModelDraw,
    "entry" | "parts" | "bays" | "emptyMode" | "groupKey"
  >
): SharedAssembly {
  const scene = draw.entry.scene!
  let byKey = assemblies.get(scene)
  if (!byKey) {
    byKey = new Map()
    assemblies.set(scene, byKey)
  }
  let a = byKey.get(draw.groupKey)
  if (!a) {
    const { root, drawn } = assembleModel(
      scene,
      draw.parts.map((p) => ({
        bay: p.bay,
        position: p.position,
        scene: p.entry.scene!,
      })),
      draw.bays,
      draw.emptyMode
    )
    a = { root, drawn, meshes: partMeshes(root) }
    byKey.set(draw.groupKey, a)
  }
  return a
}

/** One instanced mesh per part mesh but the LEDs (drawn as one batch,
 * led-instances), `count` instances each. Geometry and material are the
 * cached model's own - its UV sets and any baked ambient occlusion
 * included. A full model casts shadows, as PlacedModel does; a far copy
 * only takes them. */
export function instancedParts(
  meshes: readonly PartMesh[],
  count: number,
  castShadow: boolean
): { part: PartMesh; im: THREE.InstancedMesh }[] {
  return meshes
    .filter((pm) => !pm.led)
    .map((part) => {
      const im = new THREE.InstancedMesh(
        part.mesh.geometry,
        part.mesh.material,
        count
      )
      im.raycast = () => {}
      im.receiveShadow = true
      im.castShadow = castShadow
      return { part, im }
    })
}

/**
 * Each member's instance matrices: every part at the device's slot (a
 * cover its cabling hides at zero scale, for that device alone) and the
 * LED batch at the slot itself - its geometry is in the copy's frame.
 */
export function placeInstances(
  parts: readonly { part: PartMesh; im: THREE.InstancedMesh }[],
  ledIm: THREE.InstancedMesh | null,
  draws: readonly Pick<RackModelDraw, "pose" | "fit">[],
  ids: readonly string[],
  leds: Readonly<Record<string, DeviceLeds | null | undefined>>
) {
  draws.forEach((d, i) => {
    const slot = slotMatrix(d.pose, d.fit)
    for (const { part, im } of parts) {
      const cover = part.cover
      if (cover && coverHidden(leds[ids[i]], cover.name, cover.bay))
        im.setMatrixAt(i, HIDDEN)
      else im.setMatrixAt(i, _m.multiplyMatrices(slot, part.local))
    }
    ledIm?.setMatrixAt(i, slot)
  })
  for (const { im } of parts) {
    im.instanceMatrix.needsUpdate = true
    im.computeBoundingSphere()
  }
  if (ledIm) {
    ledIm.instanceMatrix.needsUpdate = true
    ledIm.computeBoundingSphere()
  }
}

/** A group's LEDs as one instanced batch (led-instances). */
interface LedDraw {
  leds: BatchLed[]
  im: THREE.InstancedMesh
  states: THREE.DataTexture
}

function ledDrawFor(
  meshes: readonly PartMesh[],
  count: number
): LedDraw | null {
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
  if (sources.length === 0) return null
  const { geometry, leds } = buildLedBatch(sources)
  const states = ledStateTexture(leds.length, count)
  const im = new THREE.InstancedMesh(
    geometry,
    ledBatchMaterial(states, leds.length),
    count
  )
  im.raycast = () => {}
  im.castShadow = false
  im.receiveShadow = false
  return { leds, im, states }
}

function disposeLedDraw(d: LedDraw) {
  d.im.geometry.dispose()
  ;(d.im.material as THREE.Material).dispose()
  d.states.dispose()
  d.im.dispose()
}

/** One instanced group: every device in a rack drawing the same model at
 * the same level with the same parts and covers. */
function InstanceGroup({
  level,
  draws,
  ids,
  leds,
}: {
  level: "full" | "far"
  draws: readonly RackModelDraw[]
  ids: readonly string[]
  leds: Readonly<Record<string, DeviceLeds>>
}) {
  const invalidate = useThree((s) => s.invalidate)
  const first = draws[0]
  // The group key stands for the chassis, parts and covers.
  const shared = useMemo(
    () => sharedAssembly(first),
    [first.entry.scene, first.groupKey]
  )
  const count = draws.length
  const full = level === "full"
  const parts = useMemo(
    () => instancedParts(shared.meshes, count, full),
    [shared, count, full]
  )
  useEffect(() => () => parts.forEach((p) => p.im.dispose()), [parts])
  const ledDraw = useMemo(
    () => ledDrawFor(shared.meshes, count),
    [shared, count]
  )
  useEffect(
    () => () => {
      if (ledDraw) disposeLedDraw(ledDraw)
    },
    [ledDraw]
  )
  const posesKey = draws
    .map((d) => `${d.pose.position.join(":")}:${d.pose.rotY}:${d.fit.scale}`)
    .join(",")
  // Port covers: an instance whose device hides the cover draws nothing.
  const coverKey = ids.map((id) => coversKey(leds[id])).join("\u0003")
  useLayoutEffect(() => {
    placeInstances(parts, ledDraw?.im ?? null, draws, ids, leds)
    invalidate()
    // `posesKey` stands for the draws' poses, `coverKey` for their covers.
  }, [parts, ledDraw, posesKey, coverKey, invalidate])
  // LEDs: each instance's lights take their states - blinking on a full
  // model (unless the viewer asked for less motion), steady on a far copy,
  // too small for a blink to read.
  const reduced = useMemo(() => prefersReducedMotion(), [])
  const blinkOk = full && !reduced
  const ledKey = ids.map((id) => ledsKey(leds[id])).join("\u0003")
  const [blinks, setBlinks] = useState(false)
  useLayoutEffect(() => {
    if (!ledDraw) {
      setBlinks(false)
      return
    }
    const any = fillLedStates(
      ledDraw.states.image.data as Float32Array,
      ledDraw.leds,
      ids.map((id) => leds[id]),
      blinkOk
    )
    ledDraw.states.needsUpdate = true
    setBlinks(any)
    invalidate()
    // `ledKey` stands for `leds`.
  }, [ledDraw, ledKey, blinkOk, invalidate])
  useLedBlink(blinks)
  return (
    <>
      {parts.map(({ im }) => (
        <primitive key={im.uuid} object={im} />
      ))}
      {ledDraw && <primitive object={ledDraw.im} />}
    </>
  )
}

/** A rack's models, one instanced group per level and distinct look. */
export function RackModelInstances({
  draws,
  leds,
}: {
  draws: ReadonlyMap<string, RackModelDraw>
  leds: Readonly<Record<string, DeviceLeds>>
}) {
  const groups = useMemo(() => instanceGroups(draws), [draws])
  return (
    <>
      {groups.map((g) => (
        <InstanceGroup
          key={g.key}
          level={g.level}
          draws={g.draws}
          ids={g.ids}
          leds={leds}
        />
      ))}
    </>
  )
}

/** The draws by instanced group: level and group key. */
export function instanceGroups(draws: ReadonlyMap<string, RackModelDraw>): {
  key: string
  level: "full" | "far"
  ids: string[]
  draws: RackModelDraw[]
}[] {
  const out = new Map<
    string,
    {
      key: string
      level: "full" | "far"
      ids: string[]
      draws: RackModelDraw[]
    }
  >()
  for (const [id, d] of draws) {
    const key = `${d.level}\u0000${d.groupKey}`
    let g = out.get(key)
    if (!g) {
      g = { key, level: d.level, ids: [], draws: [] }
      out.set(key, g)
    }
    g.ids.push(id)
    g.draws.push(d)
  }
  return [...out.values()]
}

/**
 * What rides on one device's instanced full model, in its slot (inside
 * DeviceMesh's posed group): its plugs, stack heads and the caller's bay
 * hit boxes, on the anchors of the group's shared copy. An empty stands
 * where that copy would, so the cord ends it publishes are this device's.
 */
export function InstancedModelOverlays({
  draw,
  leds,
  pluggables,
  deviceId,
  overlay,
}: {
  draw: RackModelDraw
  leds?: DeviceLeds | null
  pluggables?: PluggablesMode
  deviceId: string
  overlay?: (root: THREE.Object3D, drawn: ReadonlySet<string>) => ReactNode
}) {
  // The group key stands for the chassis, parts and covers.
  const shared = useMemo(
    () => sharedAssembly(draw),
    [draw.entry.scene, draw.groupKey]
  )
  const [frame] = useState(() => {
    const g = new THREE.Group()
    g.matrixAutoUpdate = false
    return g
  })
  useLayoutEffect(() => {
    frame.matrix.copy(shared.root.matrix)
    frame.matrixWorldNeedsUpdate = true
  }, [frame, shared])
  return (
    <group position={draw.fit.position} scale={draw.fit.scale}>
      <group rotation={draw.fit.rotation}>
        <primitive object={frame} />
        <ModelOverlays
          root={shared.root}
          frame={frame}
          drawn={shared.drawn}
          leds={leds}
          showPlugs
          pluggables={pluggables}
          deviceId={deviceId}
          scale={draw.fit.scale}
          overlay={overlay}
        />
      </group>
    </group>
  )
}
