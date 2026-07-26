import { useEffect, useMemo, useRef, useState } from "react"
import { useFrame } from "@react-three/fiber"
import * as THREE from "three"

import type { FloorTileCheck } from "@/lib/api"

import type { LegendReporter } from "@/components/speed-scale"

import { AirflowGlyphs } from "./airflow-glyphs"
import { isCameraMoving } from "./camera-motion"
import { DeviceInstances } from "./device-instances"
import { DeviceMesh } from "./device-mesh"
import { SideStripMesh } from "./side-strip-mesh"
import { RackRuler } from "./rack-ruler"
import { FaceLabel } from "./text-sprite"
import {
  RACK_BASE_M,
  RACK_CAP_M,
  TRANSPARENT_ORDER,
  cellToWorld,
  deviceBoxM,
  deviceViewpoint,
  deviceYM,
  rackFootprintM,
  rackViewpoint,
  tierFor,
} from "./world"
import type { ScenePayload, SceneTile, Tier } from "./world"

/** Monitoring worst-status → beacon color (same semantics as the 2D rings). */
const CHECK_COLOR: Record<string, string> = {
  down: "#ef4444",
  degraded: "#f59e0b",
  stale: "#f59e0b",
  up: "#10b981",
}

const FRAME_COLOR = "#18181b"
const FRAME_SELECTED = "#0ea5e9"

/** A focus-ghosted rack (everything that is NOT the focused one). */
const FOCUS_GHOST_OPACITY = 0.08

/** Painted rack steel — slight sheen so the studio environment reads on it. */
const STEEL_ROUGHNESS = 0.6
const STEEL_METALNESS = 0.35

/** The operator's shell control: closed cabinet, open frame, or see-through.
 * ORTHOGONAL to the LOD tier — the mode owns what panels exist, the tier
 * owns geometry detail. */
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
 * One rack cabinet at its tile position. Three LOD tiers (see `tierFor`):
 *  - far: a single frame box + name plate (cheap — scales to large rooms)
 *  - mid: that frame plus every device in ONE instanced draw call
 *  - detail: shell per `shellMode` + one clickable box per racked device at
 *    true U position/size, wearing its device-type face image
 *
 * Shell modes: solid = side panels + smoked-glass doors; cutaway = open
 * post frame; x-ray = the open frame up close and a bare cabinet OUTLINE at
 * distance, with devices ghosted except the selected one. Lines and solid
 * frames on purpose — the first x-ray ghosted every shell box and the
 * per-frame transparency sort flickered like a broken sign.
 *
 * `ghosted` (focus on another cabinet) collapses the WHOLE rack to one
 * low-opacity box: full ghost geometry across a hall churned the same sort
 * and fetched textures nobody could see. Still clickable to move the focus.
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
  // U-positioned gear renders per tier; side-mounted 0U strips render in
  // BOTH tiers (one box each — a PDU that pops in/out reads as a glitch).
  const positioned = rack.devices.filter((d) => d.position != null)
  const mounted = rack.devices.filter((d) => d.mount && d.position == null)
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
  // `tierFor` carries the hysteresis that keeps orbiting on a boundary from
  // strobing; with the demand frameloop this runs only on frames the controls
  // already trigger.
  const [tier, setTier] = useState<Tier>("far")
  const tierRef = useRef<Tier>("far")
  const [viewRear, setViewRear] = useState(false)
  const viewRearRef = useRef(false)
  const centre = useMemo(
    () => new THREE.Vector3(cx, height / 2, cz),
    [cx, cz, height]
  )
  const halfDiag = useMemo(
    () => Math.hypot(width, height, depth) / 2,
    [width, height, depth]
  )
  useFrame(({ camera }) => {
    // Both swaps below go through useState, so each one re-renders this rack —
    // and a detail-tier rack re-renders two dozen DeviceMesh subtrees with
    // their queries and memos. While the camera is moving, dozens of racks
    // cross a threshold every frame, and the resulting React cascade is what
    // made every nav keypress cost 130–800 ms. Motion draws; settling
    // re-tiers. See camera-motion.ts.
    if (isCameraMoving()) return
    const dist = camera.position.distanceTo(centre) - halfDiag
    const next = tierFor(dist, tierRef.current)
    if (next !== tierRef.current) {
      tierRef.current = next
      setTier(next)
    }
    // Which side of the cabinet the eye is on. The rack group is turned by
    // rotY and its front plane faces local −Z, so the world-space front
    // normal is (−sin, 0, −cos). Normalised dot with a dead band, or the
    // panels would thrash while the camera slides along the row.
    const vx = camera.position.x - centre.x
    const vz = camera.position.z - centre.z
    const len = Math.hypot(vx, vz)
    if (len > 1e-6) {
      const d = (vx * -Math.sin(rotY) + vz * -Math.cos(rotY)) / len
      const rear = viewRearRef.current ? d < 0.05 : d < -0.05
      if (rear !== viewRearRef.current) {
        viewRearRef.current = rear
        setViewRear(rear)
      }
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
  // noise); x-ray keeps them — it is still the room, just opened up.
  const showOverlays = tier === "detail" && !ghosted

  // Live port + SNMP resolution is TWO fetches per device, and it used to fire
  // for every device in the detail tier. In a full hall that is ~1000 XHRs at
  // once: Chrome runs out of resource slots (ERR_INSUFFICIENT_RESOURCES) and
  // the main thread spends the frame budget on fetch/JSON/query churn instead
  // of drawing. Only the cabinet the operator has actually engaged with —
  // selected, or holding the focused device — resolves it. That caps the
  // traffic at one rack's worth (~24 devices) no matter how big the room is.
  const engaged = selection?.tileId === tile.id || focusDeviceId != null
  const liveData = tier === "detail" && !ghosted && engaged

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
      {ghosted ? (
        // Focus context: one ghost box, no devices, no overlays.
        <Frame
          w={width}
          h={height}
          d={depth}
          color={frameColor}
          ghostOpacity={FOCUS_GHOST_OPACITY}
        />
      ) : tier === "detail" ? (
        <group>
          {/* X-ray up close = the open cutaway frame; the see-through story
              is told by the ghosted DEVICES, not by transparent tin. */}
          <Shell
            w={width}
            h={height}
            d={depth}
            color={frameColor}
            mode={xray ? "cutaway" : shellMode}
          />
          {positioned.map((d) => {
            const isSel =
              (selection?.kind === "device" || selection?.kind === "port") &&
              selection.deviceId === d.id
            // Only FOCUS ghosts devices (spotlighting one, dimming its rack
            // siblings). X-ray deliberately does not: x-ray removes the TIN,
            // not the equipment — faceplates and ports stay rendered and
            // clickable (owner override of the original ghost-except-
            // selected spec).
            const devGhost =
              !isSel && focusDeviceId != null && d.id !== focusDeviceId
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
                viewRear={viewRear}
                livePorts={liveData}
                onLegend={onLegend}
                onZoomTo={(target) => {
                  // Same fly-to channel the rack's own double-click uses,
                  // one level down: frame THIS device's face.
                  const vp = deviceViewpoint(
                    plan,
                    tile,
                    deviceBoxM(rack, target, width, depth)
                  )
                  onFlyTo(
                    new THREE.Vector3(...vp.target),
                    new THREE.Vector3(...vp.position)
                  )
                }}
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
        <group>
          {xray ? (
            <OutlineShell w={width} h={height} d={depth} />
          ) : (
            <Frame w={width} h={height} d={depth} color={frameColor} />
          )}
          {/* Mid range: the gear is there, in one draw call, unreadable. */}
          {tier === "mid" && (
            <DeviceInstances
              rack={rack}
              devices={positioned}
              rackWidthM={width}
              rackDepthM={depth}
            />
          )}
        </group>
      )}
      {!ghosted &&
        mounted.map((d) => (
          <SideStripMesh
            key={d.id}
            rack={rack}
            dev={d}
            rackWidthM={width}
            rackDepthM={depth}
            selected={
              (selection?.kind === "device" || selection?.kind === "port") &&
              selection.deviceId === d.id
            }
            selectedPort={
              selection?.kind === "port" && selection.deviceId === d.id
                ? selection.portName
                : null
            }
            // Outlet quads are a near-range affordance, like every overlay.
            showPorts={tier === "detail"}
            onSelect={() =>
              onSelect({ kind: "device", tileId: tile.id, deviceId: d.id })
            }
            onSelectPort={(marker, side) =>
              onSelect({
                kind: "port",
                tileId: tile.id,
                deviceId: d.id,
                portName: marker.name,
                portKind: marker.kind,
                portSide: side,
              })
            }
          />
        ))}
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
        positioned.map((dev) => {
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

/** Far-tier cabinet body: one solid box (ghosted while focus is elsewhere). */
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
  // Ghosts neither cast nor catch shadows — a see-through box with a solid
  // shadow reads as a bug.
  const ghost = ghostOpacity > 0
  return (
    <mesh
      position={[0, h / 2, 0]}
      castShadow={!ghost}
      receiveShadow={!ghost}
      renderOrder={ghost ? TRANSPARENT_ORDER.ghost : 0}
    >
      <boxGeometry args={[w, h, d]} />
      {ghost ? (
        <meshStandardMaterial
          color={color}
          roughness={STEEL_ROUGHNESS}
          metalness={STEEL_METALNESS}
          transparent
          opacity={ghostOpacity}
          depthWrite={false}
        />
      ) : (
        <meshStandardMaterial
          color={color}
          roughness={STEEL_ROUGHNESS}
          metalness={STEEL_METALNESS}
        />
      )}
    </mesh>
  )
}

/**
 * Far-tier x-ray: the cabinet as a bare edge outline. Lines have no
 * transparency-sort order to lose, which is the whole reason this replaced
 * ghost boxes. The invisible box underneath keeps the cabinet clickable
 * (colorWrite/depthWrite off — raycastable, never drawn).
 */
function OutlineShell({ w, h, d }: { w: number; h: number; d: number }) {
  const edges = useMemo(
    () => new THREE.EdgesGeometry(new THREE.BoxGeometry(w, h, d)),
    [w, h, d]
  )
  useEffect(() => () => edges.dispose(), [edges])
  return (
    <group>
      <mesh position={[0, h / 2, 0]}>
        <boxGeometry args={[w, h, d]} />
        <meshBasicMaterial colorWrite={false} depthWrite={false} />
      </mesh>
      <lineSegments
        geometry={edges}
        position={[0, h / 2, 0]}
        raycast={() => null}
      >
        <lineBasicMaterial color="#71717a" transparent opacity={0.9} />
      </lineSegments>
    </group>
  )
}

/** Corner-post size and how far posts sit in from the outer planes. */
const POST = 0.05
const POST_INSET = 0.006
/**
 * Top/base overhang past the panel planes — on the DEPTH axis only.
 *
 * The lip used to run all four sides, which meant two cabinets bayed side by
 * side overlapped each other's caps by 12 mm: intersecting geometry that
 * z-fights and flickers as the camera moves. Real cabinets in a row butt
 * flush, so the width axis gets no lip and the front/rear lip (where it
 * actually reads) stays.
 */
const CAP_LIP = 0.012

/**
 * Near-tier cabinet shell:
 *  - cutaway: overhung top + plinth on four inset corner posts
 *  - solid:   overhung top + plinth, side panels, smoked-glass doors
 * Every piece is strictly inset or outset from its neighbours — the first
 * version ended posts, panels and caps on the SAME planes, which was
 * invisible under flat light and shimmered the moment shadows, AO and the
 * dynamic near-plane landed (classic coplanar z-fighting).
 */
function Shell({
  w,
  h,
  d,
  color,
  mode,
}: {
  w: number
  h: number
  d: number
  color: string
  mode: "solid" | "cutaway"
}) {
  const t = RACK_CAP_M // panel thickness — also the cap headroom in rackFootprintM
  const steel = (
    key: string,
    pos: [number, number, number],
    size: [number, number, number]
  ) => (
    <mesh key={key} position={pos} castShadow receiveShadow>
      <boxGeometry args={size} />
      <meshStandardMaterial
        color={color}
        roughness={STEEL_ROUGHNESS}
        metalness={STEEL_METALNESS}
      />
    </mesh>
  )
  const px = w / 2 - POST / 2 - POST_INSET
  const pz = d / 2 - POST / 2 - POST_INSET
  const sideH = h - RACK_BASE_M - t
  return (
    <group>
      {/* Top cap + plinth overhang everything below them. */}
      {steel("top", [0, h - t / 2, 0], [w, t, d + CAP_LIP])}
      {steel("base", [0, RACK_BASE_M / 2, 0], [w, RACK_BASE_M, d + CAP_LIP])}
      {mode === "cutaway" ? (
        <>
          {steel("p1", [-px, h / 2, -pz], [POST, h - t, POST])}
          {steel("p2", [px, h / 2, -pz], [POST, h - t, POST])}
          {steel("p3", [-px, h / 2, pz], [POST, h - t, POST])}
          {steel("p4", [px, h / 2, pz], [POST, h - t, POST])}
        </>
      ) : (
        <>
          {steel(
            "left",
            [-w / 2 + t / 2, RACK_BASE_M + sideH / 2, 0],
            [t, sideH, d]
          )}
          {steel(
            "right",
            [w / 2 - t / 2, RACK_BASE_M + sideH / 2, 0],
            [t, sideH, d]
          )}
          <GlassDoor w={w} h={h} z={-(d / 2 + 0.006)} />
          <GlassDoor w={w} h={h} z={d / 2 + 0.006} />
        </>
      )}
    </group>
  )
}

/** Door clearance under the top cap (panel thickness plus a hair). */
const DOOR_HEADROOM = 0.034

/**
 * Solid mode's door: one smoked-glass pane — gear silhouettes read through,
 * and no busy texture. Casts no shadow (a solid shadow from glass lies) and
 * is raycast-INERT: glass that ate clicks made every photo port behind it
 * unclickable in solid mode. Clicks pass through to devices and ports; the
 * cabinet itself still catches via panels, caps and gear.
 */
function GlassDoor({ w, h, z }: { w: number; h: number; z: number }) {
  const doorH = h - RACK_BASE_M - DOOR_HEADROOM
  return (
    <mesh
      position={[0, RACK_BASE_M + doorH / 2, z]}
      raycast={() => null}
      // Fixed order instead of three.js's per-frame depth sort. Glass, ghosts
      // and the lifted floor all compete in the same transparent pass; letting
      // distance decide made them swap order as the camera moved, which is
      // what "buggy when switching solid/cutaway/x-ray" looked like.
      renderOrder={TRANSPARENT_ORDER.glass}
    >
      <boxGeometry args={[w - 0.02, doorH, 0.008]} />
      <meshStandardMaterial
        color="#0b0b0e"
        roughness={0.15}
        metalness={0.1}
        transparent
        opacity={0.35}
        depthWrite={false}
      />
    </mesh>
  )
}
