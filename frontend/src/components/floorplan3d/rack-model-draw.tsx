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
import { useFrame, useThree } from "@react-three/fiber"
import * as THREE from "three"

import type { ModelBay, ModelEmptyMode } from "@/lib/api"
import { ledLook, ledStateOf, ledsKey } from "@/lib/led-state"
import type { DeviceLeds } from "@/lib/led-state"
import { plannedParts } from "@/lib/model-assembly"
import type { PlannedPart } from "@/lib/model-assembly"

import { isCameraMoving } from "./camera-motion"
import {
  MODEL_TRIANGLE_LIMIT,
  SCENE_TRIANGLE_BUDGET,
  fittedModel,
  readyParts,
  useDeviceModels,
} from "./device-model"
import type { ModelEntry, ReadyPart } from "./device-model"
import { findLeds } from "./led-binding"
import { assembleModel } from "./model-assembly"
import {
  createModelBudget,
  instanceGroupKey,
  parseLevels,
  rackSlotPose,
  rackSlotTargetM,
  rackToWorld,
  wantedRackLevel,
} from "./rack-models"
import type {
  ModelBudget,
  ModelWant,
  RackModelLevel,
  SlotPose,
} from "./rack-models"
import { deviceBoxM } from "./world"
import type { SceneDevice, SceneModel, SceneRack } from "./world"

/**
 * Racked devices drawn as their 3D models (docs/features/floor-plans.md →
 * 3D models in racks). A rack in its detail tier asks, per device with a
 * model, for the level its distance wants (rack-models: full near, the far
 * copy further off, the photo box beyond); the room's shared triangle
 * budget grants it, nearest first. Full models draw per device (geometry
 * shared through the model cache), in DeviceMesh; far copies draw here,
 * ONE instanced mesh per part of the model for every device in the rack
 * with the same far copy, parts and covers - a rack of forty identical
 * switches costs one model's draw calls, not forty.
 */

/** The room's budget, shared by its floor devices and every rack. */
export const ModelBudgetContext = createContext<ModelBudget | null>(null)

export function newModelBudget(): ModelBudget {
  return createModelBudget(SCENE_TRIANGLE_BUDGET, MODEL_TRIANGLE_LIMIT)
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
  /** Devices sharing it draw as one instanced group (far level). */
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

const ready = (e: ModelEntry | undefined): e is ModelEntry =>
  e?.status === "ready" && !!e.scene && !!e.box

/**
 * A rack's devices' models: the level each wants by its distance (with
 * hysteresis, re-tiered once the camera settles), the files that needs,
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
  // Each candidate's centre in the room, for its distance.
  const centres = useMemo(
    () =>
      candidates.map((d) => {
        const b = deviceBoxM(rack, d, 0, rackDepthM)
        return rackToWorld(centre, rotY, [b.dx, b.y + b.h / 2, b.dz])
      }),
    [candidates, rack, rackDepthM, centre, rotY]
  )
  const levelsRef = useRef(new Map<string, RackModelLevel>())
  const distsRef = useRef(new Map<string, number>())
  const [wanted, setWanted] = useState<{
    levels: ReadonlyMap<string, RackModelLevel>
    dists: ReadonlyMap<string, number>
  }>({ levels: NONE, dists: new Map() })
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
        dists: new Map(distsRef.current),
      })
    // A rack just come near: measure on the next frame.
    if (candidates.length) invalidate()
  }, [candidates, invalidate])
  useFrame(({ camera }) => {
    if (candidates.length === 0 || isCameraMoving()) return
    let changed = false
    const p = camera.position
    for (let i = 0; i < candidates.length; i++) {
      const d = candidates[i]
      const c = centres[i]
      const dist = Math.hypot(p.x - c[0], p.y - c[1], p.z - c[2])
      const cur = levelsRef.current.get(d.id) ?? "box"
      const next = wantedRackLevel(dist, cur)
      distsRef.current.set(d.id, dist)
      if (next !== cur) {
        if (next === "box") levelsRef.current.delete(d.id)
        else levelsRef.current.set(d.id, next)
        changed = true
      }
    }
    if (changed)
      setWanted({
        levels: new Map(levelsRef.current),
        dists: new Map(distsRef.current),
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
      out.push({
        id,
        dist: Math.round((wanted.dists.get(id) ?? 0) * 10) / 10,
        level: level === "full" ? "full" : "far",
        full: level === "full" ? cost(chassis.get(m.url), p?.full ?? []) : null,
        far: cost(chassis.get(farUrlOf(m)), p?.far ?? []),
      })
    }
    return out
  }, [wanted, byId, chassis, planned, partEntries])
  const wantsKey = wants
    .map((w) => `${w.id}:${w.level}:${w.dist}:${w.full}:${w.far}`)
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

// ── far copies, instanced ───────────────────────────────────────────────────

const _slot = new THREE.Matrix4()
const _fit = new THREE.Matrix4()
const _m = new THREE.Matrix4()
const _q = new THREE.Quaternion()
const _p = new THREE.Vector3()
const _s = new THREE.Vector3()
const _c = new THREE.Color()
const Y_AXIS = new THREE.Vector3(0, 1, 0)

/** The lit LED instances' material: unlit, its colour per instance. */
const LED_INSTANCE_MATERIAL = new THREE.MeshBasicMaterial({
  color: "#ffffff",
  toneMapped: false,
})

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

interface PartMesh {
  mesh: THREE.Mesh
  /** Its matrix in the assembled root's frame. */
  local: THREE.Matrix4
  led: { name: string; bay: string | null; off: THREE.Color } | null
}

/** The visible meshes of an assembled copy, each with its matrix in the
 * copy's frame and the LED it lights, if any. */
function partMeshes(root: THREE.Object3D): PartMesh[] {
  root.updateMatrixWorld(true)
  const inv = new THREE.Matrix4().copy(root.matrixWorld).invert()
  const leds = new Map<THREE.Mesh, { name: string; bay: string | null }>()
  for (const l of findLeds(root))
    for (const m of l.meshes) leds.set(m, { name: l.name, bay: l.bay })
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
      })
    }
    o.children.forEach(walk)
  }
  walk(root)
  return out
}

/** One instanced group: every device in a rack drawing the same far copy
 * with the same parts and covers. */
function InstanceGroup({
  draws,
  ids,
  leds,
}: {
  draws: readonly RackModelDraw[]
  ids: readonly string[]
  leds: Readonly<Record<string, DeviceLeds>>
}) {
  const invalidate = useThree((s) => s.invalidate)
  const first = draws[0]
  // Assembled once for the group - the instanced meshes read its parts.
  const meshes = useMemo(() => {
    const { root } = assembleModel(
      first.entry.scene!,
      first.parts.map((p) => ({
        bay: p.bay,
        position: p.position,
        scene: p.entry.scene!,
      })),
      first.bays,
      first.emptyMode
    )
    return partMeshes(root)
    // The group key stands for the chassis, parts and covers.
  }, [first.groupKey])
  const count = draws.length
  const instanced = useMemo(
    () =>
      meshes.map((pm) => {
        const im = new THREE.InstancedMesh(
          pm.mesh.geometry,
          pm.led ? LED_INSTANCE_MATERIAL : pm.mesh.material,
          count
        )
        im.raycast = () => {}
        im.receiveShadow = true
        im.castShadow = false
        return im
      }),
    [meshes, count]
  )
  useEffect(() => () => instanced.forEach((im) => im.dispose()), [instanced])
  const posesKey = draws
    .map((d) => `${d.pose.position.join(":")}:${d.pose.rotY}:${d.fit.scale}`)
    .join(",")
  useLayoutEffect(() => {
    draws.forEach((d, i) => {
      const slot = slotMatrix(d.pose, d.fit)
      instanced.forEach((im, k) => {
        im.setMatrixAt(i, _m.multiplyMatrices(slot, meshes[k].local))
      })
    })
    for (const im of instanced) {
      im.instanceMatrix.needsUpdate = true
      im.computeBoundingSphere()
    }
    invalidate()
    // `posesKey` stands for the draws' poses.
  }, [instanced, meshes, posesKey, invalidate])
  // LEDs: each instance takes its state's colour, steady (a far copy is too
  // small for a blink to read), or the LED's own dark colour.
  const ledKey = ids.map((id) => ledsKey(leds[id])).join("\u0003")
  useLayoutEffect(() => {
    instanced.forEach((im, k) => {
      const led = meshes[k].led
      if (!led) return
      ids.forEach((id, i) => {
        const look = ledLook(ledStateOf(leds[id], led.name, led.bay))
        im.setColorAt(i, look.color ? _c.set(look.color) : led.off)
      })
      if (im.instanceColor) im.instanceColor.needsUpdate = true
    })
    invalidate()
    // `ledKey` stands for `leds`.
  }, [instanced, meshes, ledKey, invalidate])
  return (
    <>
      {instanced.map((im) => (
        <primitive key={im.uuid} object={im} />
      ))}
    </>
  )
}

/** A rack's far copies, one instanced group per distinct look. */
export function RackModelInstances({
  draws,
  leds,
}: {
  draws: ReadonlyMap<string, RackModelDraw>
  leds: Readonly<Record<string, DeviceLeds>>
}) {
  const groups = useMemo(() => {
    const out = new Map<string, { ids: string[]; draws: RackModelDraw[] }>()
    for (const [id, d] of draws) {
      if (d.level !== "far") continue
      let g = out.get(d.groupKey)
      if (!g) {
        g = { ids: [], draws: [] }
        out.set(d.groupKey, g)
      }
      g.ids.push(id)
      g.draws.push(d)
    }
    return [...out]
  }, [draws])
  return (
    <>
      {groups.map(([key, g]) => (
        <InstanceGroup key={key} draws={g.draws} ids={g.ids} leds={leds} />
      ))}
    </>
  )
}
