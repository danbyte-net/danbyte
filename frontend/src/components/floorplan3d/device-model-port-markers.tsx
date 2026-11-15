import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import { useThree } from "@react-three/fiber"
import type { ThreeEvent } from "@react-three/fiber"
import { Html } from "@react-three/drei"
import { useQuery } from "@tanstack/react-query"
import * as THREE from "three"

import type { FacePort, FacePorts } from "@/lib/api"
import { fetchFacePortsBatched } from "@/lib/face-ports-batch"
import { PORT_MARKER_M, modelPortHex, portLocal } from "@/lib/model-ports"
import {
  MARKER_FILL_OPACITY,
  MARKER_RIM,
  markerLook,
} from "@/lib/port-marker-look"
import type { MarkerLook, MarkerMode } from "@/lib/port-marker-look"
import type { PointerMenuAt } from "@/components/pointer-menu"
import type { ModelPort, V3 } from "@/lib/model-ports"
import {
  normalizePortName,
  useObservedPorts,
} from "@/components/device-faceplate"

/**
 * The ports mapped onto a floor device's 3D model, as small outlined
 * squares on its surface: a rim round the port and a faint wash where it
 * carries something (lib/port-marker-look), instanced for the whole device,
 * each square 8 mm, facing out along the mapping's normal, a hair off the
 * surface. Coloured by port state - live SNMP where the device was polled, else cable and
 * speed - from the room's batched face-ports request, so the colours land
 * with everything else's.
 *
 * Hover names the port, its state, the far end and its VLAN; click selects
 * it (the room's port card); double-click flies to it. The caller mounts
 * this only up close (`markersVisible`), so a hall of devices draws none.
 * The Overview's model viewer and the floor plan panel draw the same
 * markers, scaled to the model they frame.
 */

const QUAD = new THREE.PlaneGeometry(1, 1)
const Z_AXIS = new THREE.Vector3(0, 0, 1)
const _m = new THREE.Matrix4()
const _q = new THREE.Quaternion()
const _p = new THREE.Vector3()
const _s = new THREE.Vector3()
const _n = new THREE.Vector3()
const _c = new THREE.Color()
/** How far a square stands off the surface (m): over it, never in it. */
const LIFT_M = 0.0015

export interface MappedPortPick {
  port: FacePort
  /** Device-local position (m) and outward normal. */
  at: V3
  normal: V3
}

/** A port's state in words, for its hover card. */
export function portStateText(fp: FacePort): string {
  if (!fp.id) return "no port"
  if (!fp.enabled) return "disabled"
  if (fp.connected) return "cabled"
  if (fp.cable_state === "reserved") return "reserved"
  return "free"
}

export function ModelPortMarkers({
  deviceId,
  size,
  selectedPort,
  onSelect,
  onFly,
  onMenu,
  markerM = PORT_MARKER_M,
}: {
  deviceId: string
  /** The fitted model's upright size (m). */
  size: V3
  /** The mapped port selected in the room (its marker name), if any. */
  selectedPort: string | null
  onSelect: (pick: MappedPortPick) => void
  onFly?: (pick: MappedPortPick) => void
  /** A square's edge (m); the room's 8 mm unless a viewer scales it. */
  markerM?: number
  /** Right-click on a port, at the pointer. */
  onMenu?: (pick: MappedPortPick, at: PointerMenuAt) => void
}) {
  const facePorts = useQuery({
    queryKey: ["device-face-ports", deviceId],
    queryFn: (): Promise<FacePorts> => fetchFacePortsBatched(deviceId),
    staleTime: 30_000,
  })
  const observed = useObservedPorts(deviceId)
  const ports = useMemo(
    () => (facePorts.data?.model ?? []).filter((p) => p.p && p.n),
    [facePorts.data]
  )
  const placed = useMemo(
    () =>
      ports.map((fp) => ({
        port: fp,
        at: portLocal(fp.p!, size),
        normal: fp.n!,
      })),
    [ports, size]
  )
  const hexes = useMemo(
    () =>
      placed.map((pk) =>
        modelPortHex(
          pk.port,
          pk.port.kind === "interface"
            ? observed?.get(normalizePortName(pk.port.name))
            : undefined
        )
      ),
    [placed, observed]
  )
  const index = useMemo(() => new Map(placed.map((pk, i) => [pk, i])), [placed])
  const lookOf = useCallback(
    (pk: MappedPortPick, mode: MarkerMode) =>
      markerLook(
        pk.port,
        hexes[index.get(pk) ?? -1] ?? MODEL_PORT_TEMPLATE,
        mode
      ),
    [hexes, index]
  )
  const selected =
    selectedPort == null
      ? -1
      : placed.findIndex((pk) => pk.port.marker === selectedPort)
  return (
    <MarkerMesh
      placed={placed}
      lookOf={lookOf}
      selected={selected >= 0 ? selected : null}
      markerM={markerM}
      onSelect={onSelect}
      onFly={onFly}
      onMenu={onMenu}
      card={(pk) => <ModelPortCard port={pk.port} />}
    />
  )
}

/** A device type's mapped ports: no device, so no state - one neutral
 * colour, the name on hover. */
export const MODEL_PORT_TEMPLATE = "#a1a1aa"

const templateLook = (_pk: unknown, mode: MarkerMode) =>
  markerLook({}, MODEL_PORT_TEMPLATE, mode)

export function TemplatePortMarkers({
  ports,
  size,
  markerM = PORT_MARKER_M,
}: {
  ports: readonly ModelPort[]
  size: V3
  markerM?: number
}) {
  const placed = useMemo(
    () =>
      ports.map((mp) => ({
        port: mp,
        at: portLocal(mp.p, size),
        normal: mp.n,
      })),
    [ports, size]
  )
  return (
    <MarkerMesh
      placed={placed}
      lookOf={templateLook}
      markerM={markerM}
      card={(pk) => (
        <div className="ml-3 -translate-y-1/2 rounded-md border border-border bg-popover/95 px-2 py-1.5 text-[11px] whitespace-nowrap text-popover-foreground shadow-md">
          <span className="font-mono font-semibold">{pk.port.name}</span>
        </div>
      )}
    />
  )
}

/** A square ring, edge 1, rim `MARKER_RIM` wide: the outline round a port. */
function squareRing(): THREE.BufferGeometry {
  const o = 0.5
  const i = 0.5 - MARKER_RIM
  const shape = new THREE.Shape()
  shape.moveTo(-o, -o).lineTo(o, -o).lineTo(o, o).lineTo(-o, o).lineTo(-o, -o)
  const hole = new THREE.Path()
  hole.moveTo(-i, -i).lineTo(-i, i).lineTo(i, i).lineTo(i, -i).lineTo(-i, -i)
  shape.holes.push(hole)
  return new THREE.ShapeGeometry(shape)
}
const RING = squareRing()
/** How much larger a hovered / selected rim draws: just outside the port. */
const HOVER_GROW = 1.12
const SELECTED_GROW = 1.2

/** The right button's travel (px) still read as a click, not a pan. */
const MENU_SLOP_PX = 4

/**
 * Port markers on a model's surface, each facing out along its normal: a
 * rim round the port and a faint wash where the port carries something
 * (markerLook), one instanced draw each, over an invisible square that
 * takes the pointer. Hover lightens the rim and names the port; click
 * selects; double-click flies to it; a right-click (not a pan) opens the
 * caller's menu.
 */
function MarkerMesh<P extends { at: V3; normal: V3 }>({
  placed,
  lookOf,
  selected = null,
  markerM,
  onSelect,
  onFly,
  onMenu,
  card,
}: {
  placed: P[]
  lookOf: (pick: P, mode: MarkerMode) => MarkerLook
  /** The selected marker's index, if any. */
  selected?: number | null
  markerM: number
  onSelect?: (pick: P) => void
  onFly?: (pick: P) => void
  onMenu?: (pick: P, at: PointerMenuAt) => void
  card: (pick: P) => React.ReactNode
}) {
  const invalidate = useThree((s) => s.invalidate)
  const hitRef = useRef<THREE.InstancedMesh>(null)
  const fillRef = useRef<THREE.InstancedMesh>(null)
  const rimRef = useRef<THREE.InstancedMesh>(null)
  const [hover, setHover] = useState<number | null>(null)
  const rightDown = useRef<{ x: number; y: number } | null>(null)

  useLayoutEffect(() => {
    const hit = hitRef.current
    const fill = fillRef.current
    const rim = rimRef.current
    if (!hit || !fill || !rim) return
    // The lift scales with the square, so a bigger one never sinks in; the
    // rim sits a hair over the wash.
    const lift = (LIFT_M * markerM) / PORT_MARKER_M
    placed.forEach((pk, i) => {
      const mode: MarkerMode =
        i === selected ? "selected" : i === hover ? "hover" : "idle"
      const look = lookOf(pk, mode)
      _n.set(...pk.normal).normalize()
      _q.setFromUnitVectors(Z_AXIS, _n)
      _p.set(...pk.at).addScaledVector(_n, lift)
      _s.set(markerM, markerM, 1)
      hit.setMatrixAt(i, _m.compose(_p, _q, _s))
      // No wash: the instance shrinks to nothing.
      _s.setScalar(look.fill ? markerM : 0)
      fill.setMatrixAt(i, _m.compose(_p, _q, _s))
      fill.setColorAt(i, _c.set(look.fill ?? look.rim))
      const grow =
        mode === "selected" ? SELECTED_GROW : mode === "hover" ? HOVER_GROW : 1
      _p.addScaledVector(_n, lift * 0.25)
      _s.set(markerM * grow, markerM * grow, 1)
      rim.setMatrixAt(i, _m.compose(_p, _q, _s))
      rim.setColorAt(i, _c.set(look.rim))
    })
    for (const im of [hit, fill, rim]) {
      im.count = placed.length
      im.instanceMatrix.needsUpdate = true
      if (im.instanceColor) im.instanceColor.needsUpdate = true
      im.computeBoundingSphere()
    }
    invalidate()
  }, [placed, lookOf, hover, selected, markerM, invalidate])

  // The cursor is the page's: never leave it a pointer after unmount.
  useEffect(
    () => () => {
      document.body.style.cursor = ""
    },
    []
  )

  if (placed.length === 0) return null
  const hot = hover != null ? placed[hover] : null
  const pick = (e: ThreeEvent<MouseEvent>) =>
    e.instanceId != null ? placed[e.instanceId] : null
  return (
    <>
      <instancedMesh
        // A new count needs a new buffer.
        key={`hit-${placed.length}`}
        ref={hitRef}
        args={[QUAD, undefined, placed.length]}
        userData={{ portMarkers: true }}
        onPointerMove={(e) => {
          e.stopPropagation()
          if (e.instanceId != null && e.instanceId !== hover) {
            setHover(e.instanceId)
            if (onSelect) document.body.style.cursor = "pointer"
          }
        }}
        onPointerOut={() => {
          setHover(null)
          document.body.style.cursor = ""
        }}
        onClick={(e) => {
          const pk = pick(e)
          if (!pk || !onSelect) return
          e.stopPropagation()
          onSelect(pk)
        }}
        onDoubleClick={(e) => {
          const pk = pick(e)
          if (!pk || !onFly) return
          e.stopPropagation()
          onFly(pk)
        }}
        onPointerDown={
          onMenu
            ? (e) => {
                if (e.nativeEvent.button !== 2) return
                rightDown.current = {
                  x: e.nativeEvent.clientX,
                  y: e.nativeEvent.clientY,
                }
              }
            : undefined
        }
        onPointerUp={
          onMenu
            ? (e) => {
                const from = rightDown.current
                rightDown.current = null
                if (e.nativeEvent.button !== 2 || !from) return
                const { clientX: x, clientY: y } = e.nativeEvent
                if (Math.hypot(x - from.x, y - from.y) > MENU_SLOP_PX) return
                const pk = pick(e)
                if (!pk) return
                e.stopPropagation()
                onMenu(pk, { x, y })
              }
            : undefined
        }
      >
        {/* Takes the pointer, draws nothing. */}
        <meshBasicMaterial visible={false} side={THREE.DoubleSide} />
      </instancedMesh>
      <instancedMesh
        key={`fill-${placed.length}`}
        ref={fillRef}
        args={[QUAD, undefined, placed.length]}
      >
        <meshBasicMaterial
          toneMapped={false}
          transparent
          opacity={MARKER_FILL_OPACITY}
          depthWrite={false}
          side={THREE.DoubleSide}
        />
      </instancedMesh>
      <instancedMesh
        key={`rim-${placed.length}`}
        ref={rimRef}
        args={[RING, undefined, placed.length]}
      >
        <meshBasicMaterial toneMapped={false} side={THREE.DoubleSide} />
      </instancedMesh>
      {hot && (
        <Html
          position={hot.at}
          zIndexRange={[20, 0]}
          style={{ pointerEvents: "none" }}
        >
          {card(hot)}
        </Html>
      )}
    </>
  )
}

/** The hover card: name, state, far end, VLAN. */
function ModelPortCard({ port }: { port: FacePort }) {
  const far = port.peer
    ? `${port.peer.device} · ${port.peer.port}`
    : port.connected
      ? "Cabled"
      : null
  return (
    <div className="ml-3 -translate-y-1/2 rounded-md border border-border bg-popover/95 px-2 py-1.5 text-[11px] whitespace-nowrap text-popover-foreground shadow-md">
      <div className="flex items-center gap-2">
        <span className="font-mono font-semibold">{port.name}</span>
        <span className="text-muted-foreground">{portStateText(port)}</span>
      </div>
      {far && <div className="font-mono text-muted-foreground">{far}</div>}
      {port.vlan && (
        <div className="text-muted-foreground">
          VLAN <span className="num">{port.vlan.vlan_id}</span>
          {port.vlan.name ? ` · ${port.vlan.name}` : ""}
        </div>
      )}
    </div>
  )
}
