import { useMemo, useState } from "react"
import type * as THREE from "three"

import type { ImagePortMarker } from "@/lib/api"
import { feedTint } from "@/lib/faceplate-colors"

import {
  STRIP_D_M,
  STRIP_PORT_QUAD_M,
  STRIP_W_M,
  sideStripBoxM,
  stripPortLocalM,
} from "./world"
import type { KitChannelSeat, SceneDevice, SceneRack } from "./world"
import { useDeviceModel } from "./device-model"

/** Real rack PDUs are near-black extruded aluminium - dark so the outlet
 * cells and the feed spine read against it. */
const STRIP_BODY = "#17171b"
const STRIP_SELECTED = "#0ea5e9"
/** Same selection amber as the photo-port quads on device faces. */
const PORT_SELECTED = "#fbbf24"

/**
 * A side-mounted 0U strip (vertical PDU) standing in the cabinet's zero-U
 * space - the render the shelf-appliance box could never be for a 42U power
 * strip. Clickable like any device (HUD + Open device); rendered in BOTH LOD
 * tiers (one box is cheap and a PDU that pops in and out reads as a glitch).
 *
 * It looks like a PDU: a dark extruded body, a coloured spine down its face
 * showing which redundant feed powers it (blue = primary/A, red =
 * redundant/B - see `feedTint`), and a column of outlet cells each tinted by
 * its own phase leg. `showPorts` (detail tier) makes those cells clickable -
 * laid out by `world.stripPortLocalM`, the SAME function the cable layer
 * anchors runs with, so a cord and its outlet can't disagree.
 *
 * In a rack built from a kit with 0U channels it is seated on its channel
 * (world `kitChannelSeat`) and, up close (`showModel`), draws its own 3D
 * model there - its back on the channel, facing the way the channel does
 * (the export spec §14: the PDU's origin is the centre of its back at its
 * bottom end) - the box staying on as its invisible hit box.
 */
export function SideStripMesh({
  rack,
  dev,
  rackWidthM,
  rackDepthM,
  selected,
  selectedPort,
  showPorts = false,
  showModel = false,
  onSelect,
  onSelectPort,
}: {
  rack: SceneRack
  dev: SceneDevice
  rackWidthM: number
  rackDepthM: number
  selected: boolean
  /** Name of the port currently selected on THIS strip, if any. */
  selectedPort?: string | null
  /** Detail tier only - a far hall must not carry thousands of quads. */
  showPorts?: boolean
  /** Draw a seated strip's 3D model (near range only). */
  showModel?: boolean
  onSelect: () => void
  /** An outlet/port quad was clicked - same contract as DeviceMesh's. */
  onSelectPort?: (marker: ImagePortMarker, side: "front" | "rear") => void
}) {
  const [hovered, setHovered] = useState(false)
  const [hoveredPort, setHoveredPort] = useState<string | null>(null)
  const box = sideStripBoxM(rack, dev, rackWidthM, rackDepthM)
  const { x, y, h, z } = box
  const modelUrl = box.seat && showModel ? (dev.model?.url ?? null) : null
  const entry = useDeviceModel(modelUrl)
  const modelScene = entry?.status === "ready" ? entry.scene : null
  const drawsModel = !!(modelScene && box.seat)
  const feedType = dev.power_feed_type ?? ""
  const legs = dev.power_legs ?? {}
  // Which face the outlets look out of, so the spine sits on the same side.
  const out = dev.face === "front" ? -1 : 1

  const bodyColor = selected ? STRIP_SELECTED : hovered ? "#3f3f46" : STRIP_BODY
  // The strip's feed at a glance: a thin coloured spine down the outlet face.
  // Only drawn when a feed is actually known, so an unwired PDU stays neutral.
  const spine = feedTint("", feedType)
  const showSpine = feedType === "primary" || feedType === "redundant"

  const ports: { name: string; kind: string }[] = showPorts
    ? [
        ...(dev.power_ports ?? []).map((name) => ({
          name,
          kind: "power-port",
        })),
        ...(dev.power_outlets ?? []).map((name) => ({
          name,
          kind: "power-outlet",
        })),
      ]
    : []

  return (
    <group>
      <mesh
        position={[x, y + h / 2, z]}
        castShadow
        onClick={(e) => {
          e.stopPropagation()
          onSelect()
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
        <boxGeometry args={[STRIP_W_M, h, STRIP_D_M]} />
        {drawsModel && !selected && !hovered ? (
          // The model is the strip: the box is only what takes the click.
          <meshBasicMaterial key="hit" colorWrite={false} depthWrite={false} />
        ) : (
          <meshStandardMaterial
            key="body"
            color={bodyColor}
            roughness={0.4}
            metalness={0.5}
            transparent={drawsModel}
            opacity={drawsModel ? 0.35 : 1}
            depthWrite={!drawsModel}
          />
        )}
      </mesh>
      {modelScene && box.seat && (
        <SeatedModel scene={modelScene} seat={box.seat} y={y} />
      )}
      {/* Feed spine - a slim bar down the outlet face in the feed's colour. */}
      {showSpine && (
        <mesh
          position={[x, y + h / 2, z + out * (STRIP_D_M / 2 + 0.001)]}
          raycast={() => null}
        >
          <boxGeometry args={[STRIP_W_M * 0.28, h * 0.98, 0.004]} />
          <meshStandardMaterial
            color={spine}
            emissive={spine}
            emissiveIntensity={0.35}
            toneMapped={false}
          />
        </mesh>
      )}
      {ports.map((p) => {
        const at = stripPortLocalM(box, dev, p.name)
        const isSel = selectedPort != null && p.name === selectedPort
        const isHot = hoveredPort === p.name
        // Outlet colour is its own phase leg, else the PDU's feed side.
        const cell = isSel
          ? PORT_SELECTED
          : feedTint(legs[p.name] ?? "", feedType)
        return (
          <mesh
            key={p.name}
            name={p.name}
            position={[at.x, at.y, at.z]}
            rotation={[0, at.out === 1 ? 0 : Math.PI, 0]}
            onClick={(e) => {
              e.stopPropagation()
              // Unmarked power components resolve under face-ports' REAR
              // list (power lives on the back) - pass the matching side.
              onSelectPort?.({ ...p, x: 0.5, y: 0.5, w: 1, h: 1 }, "rear")
            }}
            onPointerOver={(e) => {
              e.stopPropagation()
              setHoveredPort(p.name)
              document.body.style.cursor = "pointer"
            }}
            onPointerOut={(e) => {
              e.stopPropagation()
              setHoveredPort((cur) => (cur === p.name ? null : cur))
              document.body.style.cursor = ""
            }}
          >
            <planeGeometry args={[STRIP_PORT_QUAD_M, STRIP_PORT_QUAD_M]} />
            <meshStandardMaterial
              color={cell}
              emissive={cell}
              emissiveIntensity={isSel || isHot ? 0.6 : 0.25}
              roughness={0.5}
              toneMapped={false}
            />
          </mesh>
        )
      })}
    </group>
  )
}

const noRaycast = () => null

/** A 0U device's model on its kit channel: a copy sharing its geometry and
 * materials, clicks passing through to the hit box. Its front (+Z as
 * modelled, spec §3) turned to the channel's `out`. */
function SeatedModel({
  scene,
  seat,
  y,
}: {
  scene: THREE.Object3D
  seat: KitChannelSeat
  y: number
}) {
  const copy = useMemo(() => {
    const c = scene.clone()
    c.traverse((o) => {
      o.raycast = noRaycast
    })
    return c
  }, [scene])
  return (
    <primitive
      object={copy}
      position={[seat.x, y, seat.z]}
      rotation={[0, Math.atan2(seat.out[0], seat.out[1]), 0]}
    />
  )
}
