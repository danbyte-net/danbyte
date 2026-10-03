import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import { useFrame, useThree } from "@react-three/fiber"
import { Line } from "@react-three/drei"
import * as THREE from "three"

import type {
  FloorTileCheck,
  ImagePortMarker,
  PortLabelSource,
} from "@/lib/api"
import type { LegendReporter } from "@/components/speed-scale"

import {
  CABINET_DOOR_M,
  doorAngle,
  doorHingeM,
  doorStep,
  seesInside,
  shellWallsM,
} from "./cabinet-geometry"
import { CabinetInterior } from "./cabinet-interior"
import { isCameraMoving } from "./camera-motion"
import { CHECK_COLOR } from "./rack-mesh"
import type { Sel } from "./rack-mesh"
import { FaceLabel } from "./text-sprite"
import {
  TRANSPARENT_ORDER,
  boxEdgesM,
  cabinetBoxM,
  cellToWorld,
  occludesSightLine,
  rackViewpoint,
} from "./world"
import type { ScenePayload, SceneTile } from "./world"
import type { PointerMenuAt } from "@/components/pointer-menu"

/** Light grey enclosure steel - the RAL 7035 most DIN-rail cabinets ship
 * in, and a neutral that sets the box apart from the room's dark racks. */
export const ENCLOSURE_COLOR = "#cbd0cc"
/** The outline with no monitoring to show. */
export const OUTLINE_NEUTRAL = "#52525b"
const SELECTED_TINT = "#0ea5e9"
/** A focus-ghosted cabinet - the racks' own ghost opacity. */
const GHOST_OPACITY = 0.08
/** The door handle's colour. */
const HANDLE_COLOR = "#27272a"
/** The outline runs along the steel's own edges; nudging the steel's depth
 * back a hair lets the line win there, instead of the two taking turns and
 * the edge drawing dashed. */
const OUTLINE_WINS = {
  polygonOffset: true,
  polygonOffsetFactor: 1,
  polygonOffsetUnits: 1,
} as const

/** What the outline says: the worst check of the cabinet's devices, in the
 * racks' beacon colours, else the neutral edge. */
export function cabinetOutline(check: FloorTileCheck | null | undefined): {
  color: string
  width: number
} {
  const color = check ? CHECK_COLOR[check] : undefined
  return color ? { color, width: 2.5 } : { color: OUTLINE_NEUTRAL, width: 1 }
}

/** The viewer asked the system for less motion: the door snaps. */
const reducedMotion = () => {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches
  } catch {
    return false
  }
}

/**
 * A DIN-rail cabinet at its tile: a closed box at the enclosure's outer
 * size, standing on the floor and turned with the tile, front to the tile's
 * facing edge.
 *
 * Its outline carries the monitoring state, in the colours a rack's beacon
 * uses; the name plate sits on the front above the box, as a rack's does;
 * a handle on the door shows which way it faces. Click selects it (the
 * scene shows its card), double-click flies to its front, and hovering
 * reports the tile so the scene can preview the card.
 *
 * `doorOpen` swings the door open on its hinge - the left edge as you face
 * it, the handle on the free edge - and the box opens up to show the plate,
 * its rails and the devices on them (`CabinetInterior`, fetched the first
 * time it opens). Shut and still, it is the plain closed box again. The
 * swing is written straight onto the door each frame and re-renders
 * nothing; under reduced motion it snaps.
 *
 * Focus on another tile ghosts it, and it fades while it stands between the
 * eye and the selected tile - both as racks do; a ghost shows neither its
 * door nor its insides. X-ray takes its tin away as it does a rack's: the
 * outline stays, over walls that are not drawn but still catch the pointer,
 * and an open cabinet's gear stays drawn. A change that only takes children
 * away kicks a frame itself: fiber does not redraw on a removal, and with
 * the demand frameloop the canvas would keep the old picture.
 */
export function CabinetMesh({
  plan,
  tile,
  check,
  selected,
  ghosted = false,
  xray = false,
  attention = null,
  doorOpen = false,
  selectedDeviceId = null,
  selectedPort = null,
  nameplate = true,
  markReserved = false,
  portLabelSource = "",
  portLabelColor = "#ffffff",
  onSelect,
  onFlyTo,
  onHover,
  onSelectDevice,
  onHoverDevice,
  onSelectPort,
  onHoverPort,
  onPortMenu,
  onLegend,
}: {
  plan: ScenePayload["plan"]
  tile: SceneTile
  check?: FloorTileCheck | null
  /** This cabinet is the selection. */
  selected: boolean
  /** Focus mode is on and THIS cabinet is not the focused tile. */
  ghosted?: boolean
  /** The shell's x-ray mode: the outline only. */
  xray?: boolean
  /** World point the operator is looking at; a cabinet blocking the sight
   * line to it fades. */
  attention?: [number, number, number] | null
  /** The door stands open and the insides show. */
  doorOpen?: boolean
  /** The device inside drawn as selected. */
  selectedDeviceId?: string | null
  /** The port picked on a device inside: the device and the marker. */
  selectedPort?: { deviceId: string; marker: string } | null
  /** The name over the front - off where the page already names it. */
  nameplate?: boolean
  /** Draw ports held for a cable amber. */
  markReserved?: boolean
  /** The deployment's port-label choice and colour, for the ports inside. */
  portLabelSource?: PortLabelSource
  portLabelColor?: string
  onSelect: (sel: Sel) => void
  onFlyTo: (target: THREE.Vector3, position: THREE.Vector3) => void
  /** Pointer over (true) or off (false) this cabinet. */
  onHover?: (tileId: string, on: boolean) => void
  /** A device inside was clicked. */
  onSelectDevice?: (tileId: string, deviceId: string) => void
  /** Pointer over (true) or off (false) a device inside. Keep it stable:
   * a device lets go of its hover whenever it changes. */
  onHoverDevice?: (tileId: string, deviceId: string, on: boolean) => void
  /** A port on a device inside was clicked. */
  onSelectPort?: (
    tileId: string,
    deviceId: string,
    marker: ImagePortMarker
  ) => void
  /** Pointer over (true) or off (false) a port on a device inside. */
  onHoverPort?: (
    tileId: string,
    deviceId: string,
    marker: ImagePortMarker,
    on: boolean
  ) => void
  /** A hardware marker on a device inside right-clicked, at the pointer. */
  onPortMenu?: (
    tileId: string,
    deviceId: string,
    marker: ImagePortMarker,
    at: PointerMenuAt
  ) => void
  /** The colours the ports inside put on screen, by device. */
  onLegend?: LegendReporter
}) {
  const cabinet = tile.cabinet!
  const box = useMemo(() => cabinetBoxM(cabinet), [cabinet])
  const { width, depth, height } = box
  const [cx, cz] = cellToWorld(plan, tile.x + tile.w / 2, tile.y + tile.h / 2)
  const rotY = (-tile.orientation * Math.PI) / 180
  const [hovered, setHovered] = useState(false)
  const invalidate = useThree((s) => s.invalidate)

  // Fade while standing in front of the selected tile - the racks' rule,
  // re-checked only once the camera settles, with the same hysteresis.
  const [autoDim, setAutoDim] = useState(false)
  const autoDimRef = useRef(false)
  const centre = useMemo(
    () => new THREE.Vector3(cx, height / 2, cz),
    [cx, cz, height]
  )
  useFrame(({ camera }) => {
    if (isCameraMoving()) return
    const half = Math.max(width, depth) / 2
    const r = autoDimRef.current ? half + 0.35 : half * 0.6
    const blocking =
      attention != null &&
      !selected &&
      occludesSightLine(
        [camera.position.x, camera.position.y, camera.position.z],
        attention,
        [centre.x, centre.y, centre.z],
        r
      )
    if (blocking !== autoDimRef.current) {
      autoDimRef.current = blocking
      setAutoDim(blocking)
    }
  })

  // The door's swing, 0 shut to 1 open, stepped each frame toward
  // `doorOpen`. `shut` is the only state it keeps in React: the plain box
  // while the door is closed and still, the open shell from the first frame
  // of a swing to the last of a close.
  const swing = useRef(doorOpen ? 1 : 0)
  const lastFrame = useRef<number | null>(null)
  const doorRef = useRef<THREE.Group>(null)
  const [shut, setShut] = useState(!doorOpen)
  useEffect(() => {
    if (doorOpen) setShut(false)
    lastFrame.current = null
    invalidate()
  }, [doorOpen, invalidate])
  useLayoutEffect(() => {
    if (doorRef.current) doorRef.current.rotation.y = doorAngle(swing.current)
  }, [shut])
  useFrame(() => {
    const goal = doorOpen ? 1 : 0
    if (swing.current === goal) return
    const now = performance.now()
    // The first frame of a swing has no previous frame to measure from -
    // the demand loop may have idled for minutes.
    const dt =
      lastFrame.current == null
        ? 1 / 60
        : Math.min((now - lastFrame.current) / 1000, 0.1)
    lastFrame.current = now
    swing.current = reducedMotion()
      ? goal
      : doorStep(swing.current, doorOpen, dt)
    if (doorRef.current) doorRef.current.rotation.y = doorAngle(swing.current)
    if (swing.current === 0) setShut(true)
    else if (swing.current !== goal) invalidate()
  })

  // The insides are drawn only where they can be seen - through the
  // opening, or from inside the box (or through x-ray's missing tin).
  // Behind steel they would cost draws for nothing, and the sides of a
  // device box seen edge-on from behind are slivers a rasteriser can push
  // through a wall. Flipped straight on the group: no render, no state.
  const groupRef = useRef<THREE.Group>(null)
  const insideRef = useRef<THREE.Group>(null)
  const eye = useMemo(() => new THREE.Vector3(), [])
  useFrame(({ camera }) => {
    const g = groupRef.current
    const inside = insideRef.current
    if (!g || !inside) return
    g.updateWorldMatrix(true, false)
    g.worldToLocal(eye.copy(camera.position))
    const seen = xray || seesInside([eye.x, eye.y, eye.z], box)
    if (inside.visible !== seen) inside.visible = seen
  })

  const dimmed = ghosted || autoDim
  const outline = cabinetOutline(check)
  const edges = useMemo(
    () => boxEdgesM(width, height, depth),
    [width, height, depth]
  )
  const walls = useMemo(() => shellWallsM(box), [box])
  const [hingeX, hingeZ] = doorHingeM(box)
  const name = tile.label || cabinet.name
  const open = !shut && !dimmed

  // The label, outline, handle and door come and go with these; kick a
  // frame for every change so a removal is never left on screen.
  useEffect(() => {
    invalidate()
  }, [dimmed, xray, hovered, selected, outline.color, open, invalidate])

  // A cabinet unmounted under the pointer (hidden, isolated) never gets its
  // pointer-out - let go of the hover on the way out.
  const tileId = tile.id
  useEffect(() => () => onHover?.(tileId, false), [onHover, tileId])
  const selectDevice = useCallback(
    (deviceId: string) => onSelectDevice?.(tileId, deviceId),
    [onSelectDevice, tileId]
  )
  const hoverDevice = useCallback(
    (deviceId: string, on: boolean) => onHoverDevice?.(tileId, deviceId, on),
    [onHoverDevice, tileId]
  )
  const selectPort = useCallback(
    (deviceId: string, marker: ImagePortMarker) =>
      onSelectPort?.(tileId, deviceId, marker),
    [onSelectPort, tileId]
  )
  const hoverPort = useCallback(
    (deviceId: string, marker: ImagePortMarker, on: boolean) =>
      onHoverPort?.(tileId, deviceId, marker, on),
    [onHoverPort, tileId]
  )

  const flyTo = () => {
    const vp = rackViewpoint(plan, tile, height, "front")
    onFlyTo(
      new THREE.Vector3(vp.target[0], vp.target[1], vp.target[2]),
      new THREE.Vector3(vp.position[0], vp.position[1], vp.position[2])
    )
  }

  // The tin of the open box and its door: drawn like the closed box, or in
  // x-ray not drawn but still catching the pointer.
  const tin = (key: string) =>
    xray ? (
      <meshBasicMaterial
        key={`${key}-xray`}
        colorWrite={false}
        depthWrite={false}
      />
    ) : (
      <meshStandardMaterial
        key={`${key}-solid`}
        color={ENCLOSURE_COLOR}
        roughness={0.55}
        metalness={0.15}
        emissive={selected ? SELECTED_TINT : "#ffffff"}
        emissiveIntensity={selected ? 0.35 : hovered ? 0.08 : 0}
        {...OUTLINE_WINS}
      />
    )
  // The handle, at the right as you face the door: the front is local −Z,
  // seen from the aisle, so its right is local −x.
  const handleInset = Math.min(0.06, width * 0.12)
  const handle = (x: number, z: number) => (
    <mesh position={[x, height * 0.5, z]} raycast={() => null}>
      <boxGeometry args={[0.016, Math.min(0.1, height * 0.2), 0.012]} />
      <meshStandardMaterial color={HANDLE_COLOR} roughness={0.4} />
    </mesh>
  )

  return (
    <group
      ref={groupRef}
      position={[cx, 0, cz]}
      rotation={[0, rotY, 0]}
      onClick={(e) => {
        e.stopPropagation()
        onSelect({ kind: "cabinet", tileId: tile.id })
      }}
      onDoubleClick={(e) => {
        e.stopPropagation()
        flyTo()
      }}
      onPointerOver={(e) => {
        e.stopPropagation()
        setHovered(true)
        onHover?.(tile.id, true)
        document.body.style.cursor = "pointer"
      }}
      onPointerOut={() => {
        setHovered(false)
        onHover?.(tile.id, false)
        document.body.style.cursor = ""
      }}
    >
      {open ? (
        <>
          {walls.map((wl, i) => (
            <mesh
              key={i}
              position={wl.center}
              castShadow={!xray}
              receiveShadow={!xray}
            >
              <boxGeometry args={wl.size} />
              {tin("wall")}
            </mesh>
          ))}
          {/* The door turns about its hinge line; it hangs from there
              toward the free edge, its face on the front plane. */}
          <group ref={doorRef} position={[hingeX, 0, hingeZ]}>
            <mesh
              position={[-width / 2, height / 2, CABINET_DOOR_M / 2]}
              castShadow={!xray}
              receiveShadow={!xray}
            >
              <boxGeometry args={[width, height, CABINET_DOOR_M]} />
              {tin("door")}
            </mesh>
            {!xray && handle(-width + handleInset, -0.006)}
          </group>
          <group ref={insideRef}>
            <CabinetInterior
              cabinetId={cabinet.id}
              box={box}
              selectedDeviceId={selectedDeviceId}
              selectedPort={selectedPort}
              markReserved={markReserved}
              portLabelSource={portLabelSource}
              portLabelColor={portLabelColor}
              onSelectDevice={selectDevice}
              onHoverDevice={hoverDevice}
              onSelectPort={onSelectPort ? selectPort : undefined}
              onHoverPort={onHoverPort ? hoverPort : undefined}
              onPortMenu={
                onPortMenu
                  ? (deviceId, marker, at) =>
                      onPortMenu(tileId, deviceId, marker, at)
                  : undefined
              }
              onLegend={onLegend}
            />
          </group>
        </>
      ) : (
        <mesh
          position={[0, height / 2, 0]}
          castShadow={!dimmed && !xray}
          receiveShadow={!dimmed && !xray}
          renderOrder={dimmed ? TRANSPARENT_ORDER.ghost : 0}
        >
          <boxGeometry args={[width, height, depth]} />
          {/* Keyed: a solid/ghost/x-ray switch is a new material, never props
              reset in place (see the rack's Frame). */}
          {xray && !dimmed ? (
            <meshBasicMaterial
              key="xray"
              colorWrite={false}
              depthWrite={false}
            />
          ) : (
            <meshStandardMaterial
              key={dimmed ? "ghost" : "solid"}
              color={ENCLOSURE_COLOR}
              roughness={0.55}
              metalness={0.15}
              emissive={selected ? SELECTED_TINT : "#ffffff"}
              emissiveIntensity={
                selected ? 0.35 : hovered && !dimmed ? 0.08 : 0
              }
              transparent={dimmed}
              opacity={dimmed ? GHOST_OPACITY : 1}
              depthWrite={!dimmed}
              {...OUTLINE_WINS}
            />
          )}
        </mesh>
      )}
      {!dimmed && (
        <>
          <Line
            points={edges}
            segments
            color={outline.color}
            lineWidth={outline.width}
            raycast={() => null}
          />
          {!open &&
            !xray &&
            handle(-(width / 2 - handleInset), -depth / 2 - 0.006)}
          {nameplate && (
            <FaceLabel
              text={name}
              heightM={0.08}
              maxWidthM={Math.max(width * 1.4, 0.5)}
              align="center"
              position={[0, height + 0.07, -depth / 2 - 0.01]}
            />
          )}
        </>
      )}
    </group>
  )
}
