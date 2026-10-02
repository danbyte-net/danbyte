import { useEffect, useMemo, useRef, useState } from "react"
import { useFrame, useThree } from "@react-three/fiber"
import { Line } from "@react-three/drei"
import * as THREE from "three"

import type { FloorTileCheck } from "@/lib/api"

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

/** Light grey enclosure steel - the RAL 7035 most DIN-rail cabinets ship
 * in, and a neutral that sets the box apart from the room's dark racks. */
export const ENCLOSURE_COLOR = "#cbd0cc"
/** The outline with no monitoring to show. */
export const OUTLINE_NEUTRAL = "#52525b"
const SELECTED_TINT = "#0ea5e9"
/** A focus-ghosted cabinet - the racks' own ghost opacity. */
const GHOST_OPACITY = 0.08

/** What the outline says: the worst check of the cabinet's devices, in the
 * racks' beacon colours, else the neutral edge. */
export function cabinetOutline(check: FloorTileCheck | null | undefined): {
  color: string
  width: number
} {
  const color = check ? CHECK_COLOR[check] : undefined
  return color ? { color, width: 2.5 } : { color: OUTLINE_NEUTRAL, width: 1 }
}

/**
 * A DIN-rail cabinet at its tile: a closed box at the enclosure's outer
 * size, standing on the floor and turned with the tile, front to the tile's
 * facing edge. The room shows the enclosure, not its plate - the plate and
 * its devices live in the 2D panel and on the cabinet's page.
 *
 * Its outline carries the monitoring state, in the colours a rack's beacon
 * uses; the name plate sits on the front above the box, as a rack's does;
 * a handle on the door shows which way it faces. Click selects it (the
 * scene shows its card), double-click flies to its front, and hovering
 * reports the tile so the scene can preview the card.
 *
 * Focus on another tile ghosts it, and it fades while it stands between the
 * eye and the selected tile - both as racks do. X-ray takes its tin away as
 * it does a rack's: the outline stays, over a box that is not drawn but
 * still catches the pointer. A change that only takes
 * children away kicks a frame itself: fiber does not redraw on a removal,
 * and with the demand frameloop the canvas would keep the old picture.
 */
export function CabinetMesh({
  plan,
  tile,
  check,
  selected,
  ghosted = false,
  xray = false,
  attention = null,
  onSelect,
  onFlyTo,
  onHover,
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
  onSelect: (sel: Sel) => void
  onFlyTo: (target: THREE.Vector3, position: THREE.Vector3) => void
  /** Pointer over (true) or off (false) this cabinet. */
  onHover?: (tileId: string, on: boolean) => void
}) {
  const cabinet = tile.cabinet!
  const { width, depth, height } = cabinetBoxM(cabinet)
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

  const dimmed = ghosted || autoDim
  const outline = cabinetOutline(check)
  const edges = useMemo(
    () => boxEdgesM(width, height, depth),
    [width, height, depth]
  )
  const name = tile.label || cabinet.name

  // The label, outline and handle come and go with `dimmed`; kick a frame
  // for every change so a removal is never left on screen.
  useEffect(() => {
    invalidate()
  }, [dimmed, xray, hovered, selected, outline.color, invalidate])

  // A cabinet unmounted under the pointer (hidden, isolated) never gets its
  // pointer-out - let go of the hover on the way out.
  const tileId = tile.id
  useEffect(() => () => onHover?.(tileId, false), [onHover, tileId])

  const flyTo = () => {
    const vp = rackViewpoint(plan, tile, height, "front")
    onFlyTo(
      new THREE.Vector3(vp.target[0], vp.target[1], vp.target[2]),
      new THREE.Vector3(vp.position[0], vp.position[1], vp.position[2])
    )
  }

  return (
    <group
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
          <meshBasicMaterial key="xray" colorWrite={false} depthWrite={false} />
        ) : (
          <meshStandardMaterial
            key={dimmed ? "ghost" : "solid"}
            color={ENCLOSURE_COLOR}
            roughness={0.55}
            metalness={0.15}
            emissive={selected ? SELECTED_TINT : "#ffffff"}
            emissiveIntensity={selected ? 0.35 : hovered && !dimmed ? 0.08 : 0}
            transparent={dimmed}
            opacity={dimmed ? GHOST_OPACITY : 1}
            depthWrite={!dimmed}
          />
        )}
      </mesh>
      {!dimmed && (
        <>
          <Line
            points={edges}
            segments
            color={outline.color}
            lineWidth={outline.width}
            raycast={() => null}
          />
          {/* The door handle, at the right as you face the door: the front
              is local −Z, seen from the aisle, so its right is local −x. */}
          {!xray && (
            <mesh
              position={[
                -(width / 2 - Math.min(0.06, width * 0.12)),
                height * 0.5,
                -depth / 2 - 0.006,
              ]}
              raycast={() => null}
            >
              <boxGeometry args={[0.016, Math.min(0.1, height * 0.2), 0.012]} />
              <meshStandardMaterial color="#27272a" roughness={0.4} />
            </mesh>
          )}
          <FaceLabel
            text={name}
            heightM={0.08}
            maxWidthM={Math.max(width * 1.4, 0.5)}
            align="center"
            position={[0, height + 0.07, -depth / 2 - 0.01]}
          />
        </>
      )}
    </group>
  )
}
