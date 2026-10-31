import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { useFrame, useThree } from "@react-three/fiber"
import type { ThreeEvent } from "@react-three/fiber"
import * as THREE from "three"

import type { FloorTileCheck } from "@/lib/api"

import { isCameraMoving } from "./camera-motion"
import {
  DEVICE_EDGE,
  DEVICE_FALLBACK,
  DEVICE_SELECTED,
  sharedBox,
  sharedEdges,
  sharedFaceMaterial,
  useFaceTexture,
} from "./device-mesh"
import {
  MODEL_TRIANGLE_LIMIT,
  PlacedModel,
  SCENE_TRIANGLE_BUDGET,
  fittedModel,
  useDeviceModel,
} from "./device-model"
import type { ModelEntry } from "./device-model"
import { CHECK_COLOR } from "./rack-mesh"
import type { Sel } from "./rack-mesh"
import { TextSprite } from "./text-sprite"
import { TileGhostMesh } from "./tile-ghost-mesh"
import {
  TRANSPARENT_ORDER,
  cellToWorld,
  deviceViewpoint,
  floorBoxAsRackBox,
  floorDeviceBoxM,
  floorTopM,
  modelTargetM,
  tierFor,
} from "./world"
import type { ScenePayload, SceneFloorDevice, SceneTile, Tier } from "./world"

/**
 * Devices placed straight on the floor plan.
 *
 * A device with rack units stands on the floor as the same box a rack gives
 * it - 19" wide, its units tall, its type's depth - wearing its type's front
 * and rear photos, front on the tile's front edge. A device with an uploaded
 * 3D model (its own, else its type's) draws the model instead, fitted to the
 * hardware's size; the box (or the flat tile for 0U gear) stands in while it
 * loads or when it fails. 0U gear with no model keeps its flat tile.
 *
 * Far off, every box is ONE instanced draw call with no photos; near, each
 * is its own mesh. Models draw per device (geometry shared), within a
 * triangle budget: a model past it draws as its bounding box, and the room
 * says so.
 */

/** A tile this layer draws, with everything placement needs. */
interface Placed {
  tile: SceneTile
  dev: SceneFloorDevice
  /** Rack-unit box (m), null for 0U. */
  box: { w: number; h: number; d: number } | null
  floorY: number
  centre: [number, number]
  rotY: number
}

/** Whether a tile is a placed device this layer draws (rather than the
 * flat ghost): it has rack units, or a model to load. */
export function isPlacedDevice(t: SceneTile): boolean {
  const d = t.device
  return !!d && (d.u_height > 0 || !!d.model)
}

export function placedOf(scene: ScenePayload, tile: SceneTile): Placed | null {
  const dev = tile.device
  if (!dev) return null
  const [cx, cz] = cellToWorld(
    scene.plan,
    tile.x + tile.w / 2,
    tile.y + tile.h / 2
  )
  return {
    tile,
    dev,
    box: floorDeviceBoxM(dev),
    floorY: floorTopM(scene, tile),
    centre: [cx, cz],
    rotY: (-tile.orientation * Math.PI) / 180,
  }
}

const UNIT_BOX = new THREE.BoxGeometry(1, 1, 1)
const _m = new THREE.Matrix4()
const _q = new THREE.Quaternion()
const _p = new THREE.Vector3()
const _s = new THREE.Vector3()
const _c = new THREE.Color()
const Y_AXIS = new THREE.Vector3(0, 1, 0)

/** Far-off rack-unit boxes in one draw call, still clickable. */
function FarBoxes({
  items,
  onPick,
}: {
  items: Placed[]
  onPick: (p: Placed) => void
}) {
  const ref = useRef<THREE.InstancedMesh>(null)
  const invalidate = useThree((s) => s.invalidate)
  useLayoutEffect(() => {
    const im = ref.current
    if (!im) return
    items.forEach((p, i) => {
      const b = p.box!
      _q.setFromAxisAngle(Y_AXIS, p.rotY)
      _p.set(p.centre[0], p.floorY + b.h / 2, p.centre[1])
      _s.set(b.w, b.h, b.d)
      im.setMatrixAt(i, _m.compose(_p, _q, _s))
      im.setColorAt(i, _c.set(p.dev.role_color || DEVICE_FALLBACK))
    })
    im.instanceMatrix.needsUpdate = true
    if (im.instanceColor) im.instanceColor.needsUpdate = true
    im.computeBoundingSphere()
    invalidate()
  }, [items, invalidate])
  if (items.length === 0) return null
  return (
    <instancedMesh
      ref={ref}
      args={[UNIT_BOX, undefined, items.length]}
      castShadow
      receiveShadow
      onClick={(e: ThreeEvent<MouseEvent>) => {
        if (e.instanceId == null) return
        e.stopPropagation()
        onPick(items[e.instanceId])
      }}
      onPointerOver={(e) => {
        e.stopPropagation()
        document.body.style.cursor = "pointer"
      }}
      onPointerOut={() => {
        document.body.style.cursor = ""
      }}
    >
      <meshStandardMaterial color="#ffffff" roughness={0.6} metalness={0.15} />
    </instancedMesh>
  )
}

/** A face photo on one side of the box: front on −Z (turned π, as a rack
 * draws its front), rear on +Z. */
function FacePhoto({
  url,
  w,
  h,
  z,
}: {
  url: string | null
  w: number
  h: number
  z: number
}) {
  const tex = useFaceTexture(url)
  const plane = useMemo(() => new THREE.PlaneGeometry(w, h), [w, h])
  useEffect(() => () => plane.dispose(), [plane])
  if (!tex) return null
  return (
    <mesh
      position={[0, 0, z]}
      rotation={[0, z < 0 ? Math.PI : 0, 0]}
      geometry={plane}
      material={sharedFaceMaterial(tex)}
      raycast={() => null}
    />
  )
}

/** One placed device up close (or selected, or wearing a model). */
function PlacedDevice({
  p,
  entry,
  overBudget,
  check,
  selected,
  ghosted,
  showName,
  onSelect,
  onZoom,
}: {
  p: Placed
  entry: ModelEntry | null
  overBudget: boolean
  check: FloorTileCheck | null
  selected: boolean
  ghosted: boolean
  showName: boolean
  onSelect: (sel: Sel) => void
  /** Double-click: frame this device's front at its drawn size. */
  onZoom: (size: { w: number; h: number; d: number }) => void
}) {
  const [hovered, setHovered] = useState(false)
  const { dev, tile } = p
  const model = dev.model
  const fit = useMemo(
    () =>
      model && entry?.status === "ready" && entry.box
        ? fittedModel(entry.box, model, modelTargetM(dev))
        : null,
    [model, entry, dev]
  )
  // What stands here: the model when it has loaded (or its bounding box
  // when it is over the budget), else the rack-unit box.
  const size: [number, number, number] | null = fit
    ? fit.size
    : p.box
      ? [p.box.w, p.box.h, p.box.d]
      : null
  if (!size) return null
  const [w, h, d] = size
  const edgeColor = selected
    ? DEVICE_SELECTED
    : check
      ? (CHECK_COLOR[check] ?? DEVICE_EDGE)
      : DEVICE_EDGE
  const body = selected
    ? DEVICE_SELECTED
    : hovered && !ghosted
      ? "#71717a"
      : dev.role_color || DEVICE_FALLBACK
  const name = tile.label || dev.name
  return (
    <group
      position={[p.centre[0], p.floorY, p.centre[1]]}
      rotation={[0, p.rotY, 0]}
      onClick={(e) => {
        e.stopPropagation()
        onSelect({ kind: "device", tileId: tile.id, deviceId: dev.id })
      }}
      onDoubleClick={(e) => {
        e.stopPropagation()
        onZoom({ w, h, d })
      }}
      onPointerOver={(e) => {
        e.stopPropagation()
        setHovered(true)
        document.body.style.cursor = "pointer"
      }}
      onPointerOut={() => {
        setHovered(false)
        document.body.style.cursor = ""
      }}
    >
      {fit && !overBudget ? (
        <>
          <PlacedModel entry={entry!} fit={fit} ghosted={ghosted} />
          {/* The pointer's target: one invisible box, not every triangle. */}
          <mesh position={[0, h / 2, 0]} geometry={sharedBox(w, h, d)}>
            <meshBasicMaterial colorWrite={false} depthWrite={false} />
          </mesh>
        </>
      ) : (
        <mesh
          position={[0, h / 2, 0]}
          geometry={sharedBox(w, h, d)}
          castShadow={!ghosted && !overBudget}
          receiveShadow={!ghosted && !overBudget}
          renderOrder={ghosted || overBudget ? TRANSPARENT_ORDER.ghost : 0}
        >
          <meshStandardMaterial
            key={ghosted || overBudget ? "ghost" : "solid"}
            color={body}
            roughness={0.55}
            metalness={0.2}
            transparent={ghosted || overBudget}
            opacity={ghosted ? 0.12 : overBudget ? 0.3 : 1}
            depthWrite={!(ghosted || overBudget)}
          />
        </mesh>
      )}
      {!fit && !ghosted && p.box && (
        <group position={[0, h / 2, 0]}>
          <FacePhoto
            url={dev.front_image ?? null}
            w={w}
            h={h}
            z={-(d / 2 + 0.002)}
          />
          <FacePhoto
            url={dev.rear_image ?? null}
            w={w}
            h={h}
            z={d / 2 + 0.002}
          />
        </group>
      )}
      {!ghosted && (
        // The outline: the selection blue, else the monitoring state's
        // colour, else the plain edge line.
        <lineSegments
          position={[0, h / 2, 0]}
          geometry={sharedEdges(w, h, d)}
          raycast={() => null}
        >
          <lineBasicMaterial
            color={edgeColor}
            transparent={!selected && !check}
            opacity={selected || check ? 1 : 0.5}
          />
        </lineSegments>
      )}
      {showName && !ghosted && name && (
        <TextSprite text={name} heightM={0.12} position={[0, h + 0.18, 0]} />
      )}
    </group>
  )
}

/** Loads a placed device's model and reports it to the layer. */
function ModelProbe({
  url,
  onEntry,
}: {
  url: string
  onEntry: (url: string, e: ModelEntry | null) => void
}) {
  const entry = useDeviceModel(url)
  useEffect(() => {
    onEntry(url, entry)
  }, [url, entry, entry?.status, onEntry])
  useEffect(() => () => onEntry(url, null), [url, onEntry])
  return null
}

/**
 * The room's placed devices. `onTooDetailed` hears the names of devices
 * whose model draws as a box because it is over the triangle budget.
 */
export function FloorDevicesLayer({
  scene,
  tiles,
  checks,
  selection,
  focusTileId,
  showNames,
  onSelect,
  onFlyTo,
  onTooDetailed,
}: {
  scene: ScenePayload
  /** The device tiles to draw (hidden and isolated-out ones left out). */
  tiles: SceneTile[]
  checks: (tileId: string) => FloorTileCheck | null
  selection: Sel | null
  /** Focus is on: everything but this tile ghosts. */
  focusTileId: string | null
  showNames: boolean
  onSelect: (sel: Sel) => void
  onFlyTo: (target: THREE.Vector3, position: THREE.Vector3) => void
  onTooDetailed?: (names: string[]) => void
}) {
  const placed = useMemo(
    () =>
      tiles
        .map((t) => placedOf(scene, t))
        .filter((p): p is Placed => p !== null),
    [scene, tiles]
  )

  // Loaded models by URL (one probe per distinct URL).
  const [entries, setEntries] = useState<Map<string, ModelEntry>>(new Map())
  const onEntry = useMemo(
    () => (url: string, e: ModelEntry | null) =>
      setEntries((prev) => {
        const cur = prev.get(url)
        if (e === cur || (e && cur && e.status === cur.status)) return prev
        const next = new Map(prev)
        if (e) next.set(url, e)
        else next.delete(url)
        return next
      }),
    []
  )
  const urls = useMemo(
    () =>
      [
        ...new Set(placed.map((p) => p.dev.model?.url).filter(Boolean)),
      ] as string[],
    [placed]
  )

  // The triangle budget, spent in tile order: a model past its own limit,
  // or past what the room has left, draws as its bounding box.
  const overBudget = useMemo(() => {
    const out = new Set<string>()
    let spent = 0
    for (const p of placed) {
      const e = p.dev.model ? entries.get(p.dev.model.url) : undefined
      if (e?.status !== "ready") continue
      if (
        e.triangles > MODEL_TRIANGLE_LIMIT ||
        spent + e.triangles > SCENE_TRIANGLE_BUDGET
      ) {
        out.add(p.tile.id)
        continue
      }
      spent += e.triangles
    }
    return out
  }, [placed, entries])
  const tooDetailedKey = placed
    .filter((p) => overBudget.has(p.tile.id))
    .map((p) => p.tile.label || p.dev.name)
    .join("\u0000")
  useEffect(() => {
    onTooDetailed?.(tooDetailedKey ? tooDetailedKey.split("\u0000") : [])
  }, [tooDetailedKey, onTooDetailed])

  // Near or far, per device - with the racks' hysteresis, re-tiered only
  // once the camera settles.
  const tiers = useRef(new Map<string, Tier>())
  const [near, setNear] = useState<ReadonlySet<string>>(new Set())
  useFrame(({ camera }) => {
    if (isCameraMoving()) return
    let changed = false
    const next = new Set<string>()
    for (const p of placed) {
      const half = p.box ? Math.hypot(p.box.w, p.box.h, p.box.d) / 2 : 0.5
      const dist =
        Math.hypot(
          camera.position.x - p.centre[0],
          camera.position.y - p.floorY,
          camera.position.z - p.centre[1]
        ) - half
      const cur = tiers.current.get(p.tile.id) ?? "far"
      const t = tierFor(dist, cur)
      if (t !== cur) {
        tiers.current.set(p.tile.id, t)
        changed = true
      }
      if (t === "detail") next.add(p.tile.id)
    }
    if (changed) setNear(next)
  })

  const flyTo = (p: Placed, size: { w: number; h: number; d: number }) => {
    const vp = deviceViewpoint(
      scene.plan,
      p.tile,
      floorBoxAsRackBox(size, p.floorY)
    )
    onFlyTo(new THREE.Vector3(...vp.target), new THREE.Vector3(...vp.position))
  }

  const far: Placed[] = []
  const close: Placed[] = []
  const ghosts: Placed[] = []
  for (const p of placed) {
    const e = p.dev.model ? entries.get(p.dev.model.url) : undefined
    const modelReady = e?.status === "ready"
    const isSel = selection?.tileId === p.tile.id
    // A device whose checks are failing keeps its coloured outline at any
    // distance - the instanced far tier draws none.
    const check = checks(p.tile.id)
    const alarmed = check != null && check !== "up"
    if (!p.box && !modelReady) {
      ghosts.push(p) // 0U: the flat tile while its model loads (or fails)
    } else if (
      modelReady ||
      isSel ||
      alarmed ||
      near.has(p.tile.id) ||
      focusTileId
    ) {
      close.push(p)
    } else {
      far.push(p)
    }
  }

  return (
    <>
      {urls.map((u) => (
        <ModelProbe key={u} url={u} onEntry={onEntry} />
      ))}
      <FarBoxes
        items={far}
        onPick={(p) =>
          onSelect({ kind: "device", tileId: p.tile.id, deviceId: p.dev.id })
        }
      />
      {ghosts.map((p) => (
        <TileGhostMesh
          key={`ghost-${p.tile.id}`}
          plan={scene.plan}
          tile={p.tile}
          showName={showNames}
        />
      ))}
      {close.map((p) => {
        const e = p.dev.model ? (entries.get(p.dev.model.url) ?? null) : null
        return (
          <PlacedDevice
            key={p.tile.id}
            p={p}
            entry={e}
            overBudget={overBudget.has(p.tile.id)}
            check={checks(p.tile.id)}
            selected={selection?.tileId === p.tile.id}
            ghosted={!!focusTileId && focusTileId !== p.tile.id}
            showName={showNames}
            onSelect={onSelect}
            onZoom={(size) => flyTo(p, size)}
          />
        )
      })}
    </>
  )
}
