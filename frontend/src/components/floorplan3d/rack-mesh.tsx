import { useEffect, useMemo, useRef, useState } from "react"
import { useFrame } from "@react-three/fiber"
import * as THREE from "three"

import type { FloorTileCheck } from "@/lib/api"

import type { LegendReporter } from "@/components/speed-scale"

import { AirflowGlyphs } from "./airflow-glyphs"
import { DeviceMesh } from "./device-mesh"
import { RackRuler } from "./rack-ruler"
import { FaceLabel } from "./text-sprite"
import {
  RACK_BASE_M,
  cellToWorld,
  deviceYM,
  rackFootprintM,
  rackViewpoint,
} from "./world"
import type { ScenePayload, SceneTile } from "./world"

/** Monitoring worst-status → beacon color (same semantics as the 2D rings). */
const CHECK_COLOR: Record<string, string> = {
  down: "#ef4444",
  degraded: "#f59e0b",
  stale: "#f59e0b",
  up: "#10b981",
}

const FRAME_COLOR = "#18181b"
const FRAME_SELECTED = "#0ea5e9"

/** X-ray shell opacity — the tin fades, the gear stays the subject. */
const XRAY_SHELL_OPACITY = 0.12
/** A focus-ghosted rack (everything that is NOT the focused one). */
const FOCUS_GHOST_OPACITY = 0.08

/** The operator's shell control: closed cabinet, open frame, or see-through.
 * ORTHOGONAL to the LOD tier — the mode owns opacity/what panels exist, the
 * tier owns geometry detail. */
export type ShellMode = "solid" | "cutaway" | "xray"

export interface Sel {
  kind: "rack" | "device" | "port"
  tileId: string
  deviceId?: string
  /** Set when kind === "port": the clicked photo-port marker. */
  portName?: string
  portKind?: string
  portSide?: "front" | "rear"
}

/**
 * One rack cabinet at its tile position. Two LOD tiers:
 *  - far: a single frame box + name plate (cheap — scales to large rooms)
 *  - near: shell per `shellMode` + one clickable box per racked device at
 *    true U position/size, wearing its device-type face image
 * `shellMode` decides what the shell is (solid = sides + perforated doors,
 * cutaway = open frame, xray = ghosted shell and ghosted devices except the
 * selected one); `ghosted` dims the whole cabinet when the operator focuses
 * a different one. The `check` beacon bar on top wears the rack's worst
 * monitoring status. Double-click flies the camera to frame the front.
 */
export function RackMesh({
  plan,
  tile,
  check,
  selection,
  showUNumbers,
  showNames,
  showAirflow,
  shellMode = "cutaway",
  ghosted = false,
  focusDeviceId = null,
  onSelect,
  onFlyTo,
  onLegend,
}: {
  plan: ScenePayload["plan"]
  tile: SceneTile
  check?: FloorTileCheck | null
  selection: Sel | null
  showUNumbers: boolean
  showNames: boolean
  /** Draw intake/exhaust cones per device (near tier only). */
  showAirflow?: boolean
  shellMode?: ShellMode
  /** Focus mode is on and THIS rack is not the focused one. */
  ghosted?: boolean
  /** Focus is on one device in THIS rack — its siblings ghost. */
  focusDeviceId?: string | null
  onSelect: (sel: Sel) => void
  onFlyTo: (target: THREE.Vector3, position: THREE.Vector3) => void
  /** Forwarded to each device so the room's legend keys what's on screen. */
  onLegend?: LegendReporter
}) {
  const rack = tile.rack!
  const { width, depth, height } = rackFootprintM(rack)
  const [cx, cz] = cellToWorld(plan, tile.x + tile.w / 2, tile.y + tile.h / 2)
  const rotY = (-tile.orientation * Math.PI) / 180
  const [hovered, setHovered] = useState(false)
  const xray = shellMode === "xray"

  // Manual LOD (NOT drei <Detailed>/THREE.LOD): the raycaster ignores
  // `visible`, so an invisible far-tier solid box would sit in front of the
  // devices and eat their clicks. Mount exactly one tier instead — unmounted
  // meshes can't be raycast.
  //
  // Distance is measured to the cabinet's SURFACE (centre minus half its
  // diagonal), not its centre — centre-distance made big/edge-of-room racks
  // flip tiers later than they looked, reading as "devices missing up close".
  // Wide hysteresis (18 in / 24 out) kills popping while orbiting at the
  // threshold; with the demand frameloop this runs only on frames the
  // controls already trigger.
  const [near, setNear] = useState(false)
  const nearRef = useRef(false)
  const centre = useMemo(
    () => new THREE.Vector3(cx, height / 2, cz),
    [cx, cz, height]
  )
  const halfDiag = useMemo(
    () => Math.hypot(width, height, depth) / 2,
    [width, height, depth]
  )
  useFrame(({ camera }) => {
    const dist = camera.position.distanceTo(centre) - halfDiag
    const next = dist < (nearRef.current ? 24 : 18)
    if (next !== nearRef.current) {
      nearRef.current = next
      setNear(next)
    }
  })

  const rackSelected =
    selection?.tileId === tile.id && selection.kind === "rack"
  const frameColor = rackSelected
    ? FRAME_SELECTED
    : hovered && !ghosted
      ? "#3f3f46"
      : FRAME_COLOR
  const beacon = check ? (CHECK_COLOR[check] ?? null) : null

  const flyTo = () => {
    // Same math as the HUD's front↔rear flip (world.rackViewpoint), so
    // double-click and flip can never frame the cabinet differently.
    const vp = rackViewpoint(plan, tile, height, "front")
    onFlyTo(
      new THREE.Vector3(vp.target[0], vp.target[1], vp.target[2]),
      new THREE.Vector3(vp.position[0], vp.position[1], vp.position[2])
    )
  }

  // Focus-ghosted cabinets drop their overlays (labels on a ghost read as
  // noise); x-ray keeps them — it is still the room, just see-through.
  const showOverlays = near && !ghosted

  return (
    <group
      position={[cx, 0, cz]}
      rotation={[0, rotY, 0]}
      onClick={(e) => {
        e.stopPropagation()
        onSelect({ kind: "rack", tileId: tile.id })
      }}
      onDoubleClick={(e) => {
        e.stopPropagation()
        flyTo()
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
      {/* LOD: shell + clickable devices when the camera is close, one solid
          box beyond — only ever ONE tier mounted (see above). */}
      {near ? (
        <group>
          <Shell
            w={width}
            h={height}
            d={depth}
            color={frameColor}
            mode={shellMode}
            ghosted={ghosted}
          />
          {rack.devices.map((d) => {
            const isSel =
              (selection?.kind === "device" || selection?.kind === "port") &&
              selection.deviceId === d.id
            // X-ray ghosts every device except the selected one; focus on a
            // device ghosts its rack siblings; a focus-ghosted rack ghosts
            // everything it holds.
            const devGhost =
              !isSel &&
              (ghosted ||
                xray ||
                (focusDeviceId != null && d.id !== focusDeviceId))
            return (
              <DeviceMesh
                key={d.id}
                rack={rack}
                dev={d}
                rackWidthM={width}
                rackDepthM={depth}
                selected={isSel}
                ghosted={devGhost}
                selectedPort={
                  selection?.kind === "port" && selection.deviceId === d.id
                    ? selection.portName
                    : null
                }
                showTexture={!devGhost}
                onLegend={onLegend}
                onSelect={(deviceId) =>
                  onSelect({ kind: "device", tileId: tile.id, deviceId })
                }
                onSelectPort={(deviceId, marker, side) =>
                  onSelect({
                    kind: "port",
                    tileId: tile.id,
                    deviceId,
                    portName: marker.name,
                    portKind: marker.kind,
                    portSide: side,
                  })
                }
              />
            )
          })}
        </group>
      ) : (
        <Frame
          w={width}
          h={height}
          d={depth}
          color={frameColor}
          ghostOpacity={ghosted ? FOCUS_GHOST_OPACITY : xray ? 0.15 : 0}
        />
      )}
      {/* Airflow cues — near tier only, like every overlay; the glyph layer
          reports its legend content and retracts it on unmount. */}
      {showOverlays && showAirflow && (
        <AirflowGlyphs rack={rack} legendKey={tile.id} onLegend={onLegend} />
      )}
      {/* Overlays — near tier only, and drawn FLAT on the front face so they
          stay anchored (billboards piled up in the aisle). */}
      {showOverlays && showUNumbers && (
        <RackRuler rack={rack} width={width} depth={depth} />
      )}
      {showOverlays &&
        showNames &&
        rack.devices.map((dev) => {
          const { y, h } = deviceYM(rack, dev)
          return (
            <FaceLabel
              key={`name-${dev.id}`}
              text={dev.name}
              // On the face, just right of the U-ruler rail, at the device's
              // slot; a hair in front of the photo. Height ≈ ⅔U so it fits.
              heightM={Math.min(0.03, h * 0.7)}
              align="left"
              position={[
                -width / 2 + (showUNumbers ? 0.09 : 0.03),
                y + h / 2,
                -depth / 2 - 0.01,
              ]}
            />
          )
        })}
      {beacon && !ghosted && (
        // raycast disabled — decoration must never steal the rack's clicks.
        <mesh position={[0, height + 0.03, 0]} raycast={() => null}>
          <boxGeometry args={[width * 0.6, 0.05, 0.06]} />
          <meshStandardMaterial
            color={beacon}
            emissive={beacon}
            emissiveIntensity={0.6}
          />
        </mesh>
      )}
      {/* Rack name plate — flat on the front, above the top U, facing the
          aisle. Flat (not billboard) so neighbours don't overlap. */}
      {!ghosted && (
        <FaceLabel
          text={tile.label || rack.name}
          heightM={0.11}
          align="center"
          position={[0, height + 0.09, -depth / 2 - 0.01]}
        />
      )}
    </group>
  )
}

/** Far-tier cabinet body: one solid box (ghosted in x-ray / focus). */
function Frame({
  w,
  h,
  d,
  color,
  ghostOpacity = 0,
}: {
  w: number
  h: number
  d: number
  color: string
  ghostOpacity?: number
}) {
  return (
    <mesh position={[0, h / 2, 0]}>
      <boxGeometry args={[w, h, d]} />
      {ghostOpacity > 0 ? (
        <meshStandardMaterial
          color={color}
          roughness={0.85}
          transparent
          opacity={ghostOpacity}
          depthWrite={false}
        />
      ) : (
        <meshStandardMaterial color={color} roughness={0.85} />
      )}
    </mesh>
  )
}

/**
 * Near-tier cabinet shell, per mode:
 *  - solid:   corner posts + top/base + side panels + perforated doors
 *  - cutaway: corner posts + top/base (open frame — see through the row)
 *  - xray:    the solid geometry minus doors, every panel ghosted
 * Ghosting is the room's one transparency convention: `transparent` +
 * `depthWrite={false}` (raised-floor peek uses the same).
 */
function Shell({
  w,
  h,
  d,
  color,
  mode,
  ghosted,
}: {
  w: number
  h: number
  d: number
  color: string
  mode: ShellMode
  ghosted: boolean
}) {
  const t = 0.03 // panel thickness
  const post = 0.05
  const ghost = ghosted || mode === "xray"
  const opacity = ghosted ? FOCUS_GHOST_OPACITY : XRAY_SHELL_OPACITY
  const panel = (
    key: string,
    pos: [number, number, number],
    size: [number, number, number]
  ) => (
    <mesh key={key} position={pos}>
      <boxGeometry args={size} />
      {ghost ? (
        <meshStandardMaterial
          color={color}
          roughness={0.85}
          transparent
          opacity={opacity}
          depthWrite={false}
        />
      ) : (
        <meshStandardMaterial color={color} roughness={0.85} />
      )}
    </mesh>
  )
  const sides = mode !== "cutaway"
  return (
    <group>
      {/* Four corner posts — the frame that keeps a cutaway reading as a
          cabinet rather than floating plates. */}
      {panel(
        "p1",
        [-w / 2 + post / 2, h / 2, -d / 2 + post / 2],
        [post, h, post]
      )}
      {panel(
        "p2",
        [w / 2 - post / 2, h / 2, -d / 2 + post / 2],
        [post, h, post]
      )}
      {panel(
        "p3",
        [-w / 2 + post / 2, h / 2, d / 2 - post / 2],
        [post, h, post]
      )}
      {panel(
        "p4",
        [w / 2 - post / 2, h / 2, d / 2 - post / 2],
        [post, h, post]
      )}
      {/* top + base */}
      {panel("top", [0, h - t / 2, 0], [w, t, d])}
      {panel("base", [0, RACK_BASE_M / 2, 0], [w, RACK_BASE_M, d])}
      {/* side panels — solid and x-ray keep the silhouette; cutaway drops
          them so a row reads through from the side. */}
      {sides && panel("left", [-w / 2 + t / 2, h / 2, 0], [t, h, d])}
      {sides && panel("right", [w / 2 - t / 2, h / 2, 0], [t, h, d])}
      {/* Perforated front + rear doors — solid mode only: the closed
          cabinet, with something real to take off in the other modes. */}
      {mode === "solid" && (
        <>
          <Door w={w} h={h} z={-d / 2 - 0.008} ghosted={ghosted} />
          <Door w={w} h={h} z={d / 2 + 0.008} ghosted={ghosted} />
        </>
      )}
    </group>
  )
}

// One tiny canvas of staggered perforation holes, shared by every door (the
// clone per door only re-uploads the repeat, not the image). Module-level —
// racks come and go, the pattern never changes. Canvas-drawn, so it is
// CSP/airgap-safe like every other texture in this room.
let perfBase: THREE.CanvasTexture | null = null
function perforationTexture(): THREE.CanvasTexture {
  if (perfBase) return perfBase
  const c = document.createElement("canvas")
  c.width = c.height = 64
  const g = c.getContext("2d")!
  g.fillStyle = "#1f1f23"
  g.fillRect(0, 0, 64, 64)
  g.fillStyle = "#0b0b0d"
  for (let row = 0; row < 8; row++)
    for (let col = 0; col < 8; col++) {
      g.beginPath()
      g.arc(col * 8 + 4 + (row % 2 ? 2 : 0), row * 8 + 4, 2.4, 0, Math.PI * 2)
      g.fill()
    }
  perfBase = new THREE.CanvasTexture(c)
  perfBase.wrapS = perfBase.wrapT = THREE.RepeatWrapping
  perfBase.colorSpace = THREE.SRGBColorSpace
  return perfBase
}

/** One mesh door: a thin box over the rail opening, wearing the perforation
 * pattern at a fixed ~160 mm repeat so hole size stays physical. */
function Door({
  w,
  h,
  z,
  ghosted,
}: {
  w: number
  h: number
  z: number
  ghosted: boolean
}) {
  const doorH = h - RACK_BASE_M
  const tex = useMemo(() => {
    const map = perforationTexture().clone()
    map.needsUpdate = true
    map.repeat.set(
      Math.max(1, Math.round(w / 0.16)),
      Math.max(1, Math.round(doorH / 0.16))
    )
    return map
  }, [w, doorH])
  useEffect(() => () => tex.dispose(), [tex])
  return (
    <mesh position={[0, RACK_BASE_M + doorH / 2, z]}>
      <boxGeometry args={[w, doorH, 0.015]} />
      {ghosted ? (
        <meshStandardMaterial
          map={tex}
          roughness={0.7}
          transparent
          opacity={FOCUS_GHOST_OPACITY}
          depthWrite={false}
        />
      ) : (
        <meshStandardMaterial map={tex} roughness={0.7} />
      )}
    </mesh>
  )
}
