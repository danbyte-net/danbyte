import { useLayoutEffect, useMemo, useRef } from "react"
import { useFrame, useThree } from "@react-three/fiber"
import * as THREE from "three"

import { PANEL_MM } from "@/lib/faceplate-geometry"

import {
  doorKey,
  reducedMotion,
  toggleDoor,
  useDoorOpen
  
} from "./door-state"
import type {DoorSide} from "./door-state";
import {
  blankingSlots,
  doorInfill,
  doorLeaves,
  isEnclosed,
  postSpots,
  railPlanesM,
  stepDoor
  
  
} from "./rack-kit-math"
import type {RackDoor, SceneLook} from "./rack-kit-math";
import { rackFrameWidthM } from "./rack-models"
import { useDeviceModel } from "./device-model"
import { RACK_BASE_M, RACK_CAP_M, TRANSPARENT_ORDER, mm } from "./world"
import type { SceneDevice, SceneRack } from "./world"

/** Painted rack steel - slight sheen so the studio environment reads on it. */
const STEEL_ROUGHNESS = 0.6
const STEEL_METALNESS = 0.35
/** Corner-post size and how far posts sit in from the outer planes (see
 * rack-mesh: slim, so a post never covers the edge of the gear). */
const POST = 0.018
const POST_INSET = 0.006
/** Top/base overhang past the panel planes, on the depth axis only. */
const CAP_LIP = 0.012
/** Door clearance under the top cap. */
const DOOR_HEADROOM = 0.034
const DOOR_T = 0.008
const DOOR_RIM = 0.022
const DARK = "#0b0b0e"

function Steel({
  pos,
  size,
  color,
  shadows = true,
}: {
  pos: readonly [number, number, number]
  size: readonly [number, number, number]
  color: string
  shadows?: boolean
}) {
  return (
    <mesh
      position={pos}
      castShadow={shadows}
      receiveShadow={shadows}
    >
      <boxGeometry args={size} />
      <meshStandardMaterial
        color={color}
        roughness={STEEL_ROUGHNESS}
        metalness={STEEL_METALNESS}
      />
    </mesh>
  )
}

/** Decoration that must never steal the rack's clicks. */
function Trim({
  pos,
  size,
  color,
}: {
  pos: readonly [number, number, number]
  size: readonly [number, number, number]
  color: string
}) {
  return (
    <mesh position={pos} raycast={() => null}>
      <boxGeometry args={size} />
      <meshStandardMaterial color={color} roughness={0.8} metalness={0.2} />
    </mesh>
  )
}

/**
 * Danbyte's own drawn rack, built from its Look (docs/dcim/racks.md →
 * Look) when no rack kit is installed:
 *  - cabinet / wall cabinet: top and base over four inset corner posts;
 *    in solid mode side panels (when it has them) and its doors;
 *  - 4-post: the four rail posts with frames top and bottom, no tin;
 *  - 2-post: two posts mid-depth on a base plate, a beam across the top.
 * Base and top follow their variants within the space the U maths keeps
 * for them (RACK_BASE_M, RACK_CAP_M), so gear never moves. Doors open on a
 * click (`SwingDoor`). Every piece is inset or outset from its neighbours -
 * coplanar faces z-fight.
 */
export function RackShell({
  rackId,
  look,
  w,
  h,
  d,
  color,
  mode,
}: {
  rackId: string
  look: SceneLook
  w: number
  h: number
  d: number
  color: string
  mode: "solid" | "cutaway"
}) {
  const t = RACK_CAP_M
  const enclosed = isEnclosed(look.frame)
  const rails = railPlanesM(d, look)
  const sideH = h - RACK_BASE_M - t

  if (look.frame === "2-post") {
    const spots = postSpots("2-post", w, rails, POST_INSET)
    const plateD = Math.min(d, 0.6)
    return (
      <group>
        {spots.map((s, i) => (
          <Steel
            key={`p${i}`}
            pos={[
              s.x + (s.mirrorX ? -POST / 2 : POST / 2),
              (h - t) / 2 + RACK_BASE_M / 2,
              s.z,
            ]}
            size={[POST * 2, h - t - RACK_BASE_M, POST * 3]}
            color={color}
          />
        ))}
        <Steel
          pos={[0, h - t / 2, rails.front]}
          size={[w, t, POST * 3]}
          color={color}
        />
        <Steel
          pos={[0, RACK_BASE_M / 4, rails.front]}
          size={[w, RACK_BASE_M / 2, plateD]}
          color={color}
        />
      </group>
    )
  }

  if (look.frame === "4-post") {
    const spots = postSpots("4-post", w, rails, POST_INSET)
    const span = rails.rear - rails.front
    const mid = (rails.front + rails.rear) / 2
    const beam = 0.03
    const frameAt = (y: number, key: string) => (
      <group key={key}>
        <Steel pos={[0, y, rails.front]} size={[w, beam, POST]} color={color} />
        <Steel pos={[0, y, rails.rear]} size={[w, beam, POST]} color={color} />
        <Steel
          pos={[-w / 2 + POST / 2 + POST_INSET, y, mid]}
          size={[POST, beam, span]}
          color={color}
        />
        <Steel
          pos={[w / 2 - POST / 2 - POST_INSET, y, mid]}
          size={[POST, beam, span]}
          color={color}
        />
      </group>
    )
    return (
      <group>
        {spots.map((s, i) => (
          <Steel
            key={`p${i}`}
            pos={[
              s.x + (s.mirrorX ? -POST / 2 : POST / 2),
              h / 2,
              s.z + (s.mirrorZ ? POST / 2 : -POST / 2),
            ]}
            size={[POST, h - t, POST]}
            color={color}
          />
        ))}
        {frameAt(h - t - beam / 2, "top")}
        {frameAt(RACK_BASE_M - beam / 2, "bottom")}
        <Base look={look} w={w} d={span + POST * 2} z={mid} color={color} />
      </group>
    )
  }

  const px = w / 2 - POST / 2 - POST_INSET
  const pz = d / 2 - POST / 2 - POST_INSET
  return (
    <group>
      <Top look={look} w={w} h={h} d={d} color={color} />
      <Base look={look} w={w} d={d + CAP_LIP} z={0} color={color} />
      {mode === "cutaway" || !enclosed ? (
        <>
          <Steel
            pos={[-px, h / 2, -pz]}
            size={[POST, h - t, POST]}
            color={color}
          />
          <Steel
            pos={[px, h / 2, -pz]}
            size={[POST, h - t, POST]}
            color={color}
          />
          <Steel
            pos={[-px, h / 2, pz]}
            size={[POST, h - t, POST]}
            color={color}
          />
          <Steel
            pos={[px, h / 2, pz]}
            size={[POST, h - t, POST]}
            color={color}
          />
        </>
      ) : (
        <>
          {look.side_panels ? (
            <>
              <Steel
                pos={[-w / 2 + t / 2, RACK_BASE_M + sideH / 2, 0]}
                size={[t, sideH, d]}
                color={color}
              />
              <Steel
                pos={[w / 2 - t / 2, RACK_BASE_M + sideH / 2, 0]}
                size={[t, sideH, d]}
                color={color}
              />
            </>
          ) : (
            <>
              <Steel
                pos={[-px, h / 2, -pz]}
                size={[POST, h - t, POST]}
                color={color}
              />
              <Steel
                pos={[px, h / 2, -pz]}
                size={[POST, h - t, POST]}
                color={color}
              />
              <Steel
                pos={[-px, h / 2, pz]}
                size={[POST, h - t, POST]}
                color={color}
              />
              <Steel
                pos={[px, h / 2, pz]}
                size={[POST, h - t, POST]}
                color={color}
              />
            </>
          )}
          <Doors
            rackId={rackId}
            side="front"
            door={look.front_door}
            hinge={look.hinge}
            w={w - 0.02}
            h={h}
            z={-(d / 2 + 0.006)}
            color={color}
          />
          <Doors
            rackId={rackId}
            side="rear"
            door={look.rear_door}
            hinge={look.hinge}
            w={w - 0.02}
            h={h}
            z={d / 2 + 0.006}
            color={color}
          />
        </>
      )}
    </group>
  )
}

/** The top: a cap overhanging front and rear, and what its variant puts
 * on it - vent slots, fan discs or a brush strip. */
function Top({
  look,
  w,
  h,
  d,
  color,
}: {
  look: SceneLook
  w: number
  h: number
  d: number
  color: string
}) {
  const t = RACK_CAP_M
  const y = h + 0.0015
  return (
    <group>
      <Steel pos={[0, h - t / 2, 0]} size={[w, t, d + CAP_LIP]} color={color} />
      {look.top === "vented" &&
        [-0.25, 0, 0.25].map((f) => (
          <Trim
            key={f}
            pos={[0, y, f * d]}
            size={[w * 0.7, 0.002, 0.04]}
            color={DARK}
          />
        ))}
      {look.top === "fans" &&
        [-0.2, 0.2].map((f) => (
          <mesh key={f} position={[0, y, f * d]} raycast={() => null}>
            <cylinderGeometry
              args={[Math.min(w, d) * 0.15, Math.min(w, d) * 0.15, 0.003, 24]}
            />
            <meshStandardMaterial
              color={DARK}
              roughness={0.7}
              metalness={0.2}
            />
          </mesh>
        ))}
      {look.top === "brush" && (
        <Trim
          pos={[0, y, d * 0.3]}
          size={[w * 0.5, 0.004, 0.08]}
          color={DARK}
        />
      )}
    </group>
  )
}

/** The base within RACK_BASE_M: a plinth, or a frame on casters or feet. */
function Base({
  look,
  w,
  d,
  z,
  color,
}: {
  look: SceneLook
  w: number
  d: number
  z: number
  color: string
}) {
  if (look.base === "plinth")
    return (
      <Steel
        pos={[0, RACK_BASE_M / 2, z]}
        size={[w, RACK_BASE_M, d]}
        color={color}
      />
    )
  const slab = 0.03
  const legH = RACK_BASE_M - slab
  const cx = w / 2 - 0.05
  const cz = d / 2 - 0.05
  return (
    <group>
      <Steel
        pos={[0, RACK_BASE_M - slab / 2, z]}
        size={[w, slab, d]}
        color={color}
      />
      {[
        [-cx, -cz],
        [cx, -cz],
        [-cx, cz],
        [cx, cz],
      ].map(([x, zz]) =>
        look.base === "casters" ? (
          <mesh
            key={`${x}:${zz}`}
            position={[x, legH / 2, z + zz]}
            rotation={[0, 0, Math.PI / 2]}
            raycast={() => null}
          >
            <cylinderGeometry args={[legH / 2, legH / 2, 0.025, 16]} />
            <meshStandardMaterial
              color={DARK}
              roughness={0.7}
              metalness={0.1}
            />
          </mesh>
        ) : (
          <mesh
            key={`${x}:${zz}`}
            position={[x, legH / 2, z + zz]}
            raycast={() => null}
          >
            <cylinderGeometry args={[0.018, 0.024, legH, 12]} />
            <meshStandardMaterial
              color={color}
              roughness={STEEL_ROUGHNESS}
              metalness={STEEL_METALNESS}
            />
          </mesh>
        )
      )}
    </group>
  )
}

/** One side's door: one leaf, or two for a split door. */
function Doors({
  rackId,
  side,
  door,
  hinge,
  w,
  h,
  z,
  color,
}: {
  rackId: string
  side: DoorSide
  door: RackDoor
  hinge: "left" | "right"
  w: number
  h: number
  z: number
  color: string
}) {
  const doorH = h - RACK_BASE_M - DOOR_HEADROOM
  const leaves = doorLeaves(door, w, hinge)
  const infill = doorInfill(door)
  return (
    <>
      {leaves.map((leaf, i) => (
        <SwingDoor
          key={i}
          doorId={doorKey(rackId, side, i)}
          side={side}
          // Leaves are laid out as you face the door; the front is seen
          // from −Z, where your left is +x (rack-mesh draws faces mirrored).
          hingeX={side === "front" ? -leaf.hingeX : leaf.hingeX}
          centreX={side === "front" ? -leaf.x : leaf.x}
          y={RACK_BASE_M + doorH / 2}
          z={z}
        >
          <DoorLeaf w={leaf.w} h={doorH} infill={infill} color={color} />
        </SwingDoor>
      ))}
    </>
  )
}

/**
 * A door leaf that swings on its hinge edge when clicked (per viewer,
 * door-state; never saved). The pivot sits on the hinge edge; the leaf
 * hangs from it toward `centreX`. It opens outward, away from the
 * cabinet. The swing is written straight onto the pivot each frame and
 * renders nothing; under reduced motion it snaps. A closed door takes the
 * click (so it opens instead of selecting what is behind it); an open one
 * stands clear of the opening and closes on a click.
 */
export function SwingDoor({
  doorId,
  side,
  hingeX,
  centreX,
  y,
  z,
  childOffset,
  children,
}: {
  doorId: string
  side: DoorSide
  hingeX: number
  centreX: number
  y: number
  z: number
  /** Where the children sit from the hinge; default: the leaf's centre
   * across from it (children drawn about their own centre). */
  childOffset?: [number, number, number]
  children: React.ReactNode
}) {
  const open = useDoorOpen(doorId)
  const invalidate = useThree((s) => s.invalidate)
  const pivot = useRef<THREE.Group>(null)
  const angle = useRef(open ? stepDoor(0, true, 0, true) : 0)
  const last = useRef<number | null>(null)
  const free = Math.sign(centreX - hingeX) || 1
  // Outward: −Z on the front, +Z at the rear.
  const dir = side === "front" ? free : -free
  useLayoutEffect(() => {
    if (pivot.current) pivot.current.rotation.y = dir * angle.current
  }, [dir])
  useLayoutEffect(() => {
    last.current = null
    invalidate()
  }, [open, invalidate])
  useFrame(() => {
    const goal = stepDoor(angle.current, open, 1e9, true)
    if (angle.current === goal) return
    const now = performance.now()
    const dt =
      last.current == null ? 1 / 60 : Math.min((now - last.current) / 1000, 0.1)
    last.current = now
    angle.current = stepDoor(angle.current, open, dt, reducedMotion())
    if (pivot.current) pivot.current.rotation.y = dir * angle.current
    if (angle.current !== goal) invalidate()
  })
  return (
    <group position={[hingeX, y, z]}>
      <group ref={pivot}>
        <group
          position={childOffset ?? [centreX - hingeX, 0, 0]}
          onClick={(e) => {
            e.stopPropagation()
            toggleDoor(doorId)
          }}
        >
          {children}
        </group>
      </group>
    </group>
  )
}

/** A leaf drawn in code: a rim in the rack's colour round an infill -
 * smoked glass, dark perforated steel (see-through, so the gear reads
 * behind it), or solid steel - and a handle on the free edge. */
function DoorLeaf({
  w,
  h,
  infill,
  color,
}: {
  w: number
  h: number
  infill: "perforated" | "glass" | "solid"
  color: string
}) {
  const see = infill !== "solid"
  return (
    <group>
      <mesh
        // Fixed order instead of three's per-frame depth sort (rack-mesh
        // GlassDoor): glass and ghosts share the transparent pass.
        renderOrder={see ? TRANSPARENT_ORDER.glass : 0}
        castShadow={!see}
      >
        <boxGeometry args={[w - DOOR_RIM, h - DOOR_RIM, DOOR_T * 0.6]} />
        {infill === "solid" ? (
          <meshStandardMaterial
            key="solid"
            color={color}
            roughness={STEEL_ROUGHNESS}
            metalness={STEEL_METALNESS}
          />
        ) : (
          <meshStandardMaterial
            key={infill}
            color={infill === "glass" ? DARK : "#1f1f23"}
            roughness={infill === "glass" ? 0.15 : 0.7}
            metalness={infill === "glass" ? 0.1 : 0.3}
            transparent
            opacity={infill === "glass" ? 0.35 : 0.6}
            depthWrite={false}
          />
        )}
      </mesh>
      <mesh position={[0, h / 2 - DOOR_RIM / 4, 0]} raycast={() => null}>
        <boxGeometry args={[w, DOOR_RIM / 2, DOOR_T]} />
        <meshStandardMaterial
          color={color}
          roughness={STEEL_ROUGHNESS}
          metalness={STEEL_METALNESS}
        />
      </mesh>
      <mesh position={[0, -h / 2 + DOOR_RIM / 4, 0]} raycast={() => null}>
        <boxGeometry args={[w, DOOR_RIM / 2, DOOR_T]} />
        <meshStandardMaterial
          color={color}
          roughness={STEEL_ROUGHNESS}
          metalness={STEEL_METALNESS}
        />
      </mesh>
      <mesh position={[-w / 2 + DOOR_RIM / 4, 0, 0]} raycast={() => null}>
        <boxGeometry args={[DOOR_RIM / 2, h, DOOR_T]} />
        <meshStandardMaterial
          color={color}
          roughness={STEEL_ROUGHNESS}
          metalness={STEEL_METALNESS}
        />
      </mesh>
      <mesh position={[w / 2 - DOOR_RIM / 4, 0, 0]} raycast={() => null}>
        <boxGeometry args={[DOOR_RIM / 2, h, DOOR_T]} />
        <meshStandardMaterial
          color={color}
          roughness={STEEL_ROUGHNESS}
          metalness={STEEL_METALNESS}
        />
      </mesh>
    </group>
  )
}

/**
 * Blanking panels in the empty front units, when the rack's Look asks for
 * them (`blanking_fill`): draw-only, never devices, never counted. Each
 * slot takes the tenant's blanking part of its height (`look.blanks`, the
 * pack's BLANK-1U / BLANK-2U) where there is one, else a plain panel - all
 * the plain ones in one draw call. They sit on the front rail plane, where
 * gear faces stand.
 */
export function BlankingFill({
  rack,
  look,
  devices,
  depth,
}: {
  rack: SceneRack
  look: SceneLook
  devices: readonly SceneDevice[]
  depth: number
}) {
  const pitch = mm(PANEL_MM.uPitch)
  const url1 = look.blanks.find((b) => b.u_height === 1)?.model_url ?? null
  const url2 = look.blanks.find((b) => b.u_height === 2)?.model_url ?? null
  const m1 = useDeviceModel(url1)
  const m2 = useDeviceModel(url2)
  const ready = (m: ReturnType<typeof useDeviceModel>) =>
    m?.status === "ready" && m.scene ? m.scene : null
  const models: Record<number, THREE.Object3D | null> = {
    1: ready(m1),
    2: ready(m2),
  }
  const slots = useMemo(
    () => blankingSlots(rack, devices, [2, 1]),
    [rack, devices]
  )
  const front = railPlanesM(depth, look).front
  const panelW = rackFrameWidthM(rack)
  const plain = slots.filter((s) => !models[s.h])
  const modelled = slots.filter((s) => models[s.h])

  const inst = useRef<THREE.InstancedMesh>(null)
  useLayoutEffect(() => {
    const m = inst.current
    if (!m) return
    const mat = new THREE.Matrix4()
    plain.forEach((s, i) => {
      const h = s.h * pitch - 0.0008
      mat.compose(
        new THREE.Vector3(
          0,
          RACK_BASE_M + s.u * pitch + h / 2 + 0.0004,
          front + 0.001
        ),
        new THREE.Quaternion(),
        new THREE.Vector3(panelW, h, 0.002)
      )
      m.setMatrixAt(i, mat)
    })
    m.count = plain.length
    m.instanceMatrix.needsUpdate = true
    m.computeBoundingSphere()
  }, [plain, pitch, front, panelW])

  return (
    <group>
      {plain.length > 0 && (
        <instancedMesh
          ref={inst}
          key={plain.length}
          args={[undefined, undefined, plain.length]}
          raycast={() => null}
          receiveShadow
        >
          <boxGeometry args={[1, 1, 1]} />
          <meshStandardMaterial
            color="#232326"
            roughness={0.75}
            metalness={0.25}
          />
        </instancedMesh>
      )}
      {modelled.map((s) => (
        <BlankModel
          key={`${s.u}:${s.h}`}
          scene={models[s.h]!}
          position={[0, RACK_BASE_M + s.u * pitch, front]}
        />
      ))}
    </group>
  )
}

const noRaycast = () => null

/** A blanking part's model in one slot: a copy sharing its geometry and
 * materials, clicks passing through. A part's front faces +Z as modelled
 * (spec §3); the rack's faces −Z. */
function BlankModel({
  scene,
  position,
}: {
  scene: THREE.Object3D
  position: [number, number, number]
}) {
  const copy = useMemo(() => {
    const c = scene.clone()
    c.traverse((o) => {
      o.raycast = noRaycast
    })
    return c
  }, [scene])
  return (
    <primitive object={copy} position={position} rotation={[0, Math.PI, 0]} />
  )
}
