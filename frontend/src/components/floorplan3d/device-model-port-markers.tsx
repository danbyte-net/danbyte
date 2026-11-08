import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { useThree } from "@react-three/fiber"
import type { ThreeEvent } from "@react-three/fiber"
import { Html } from "@react-three/drei"
import { useQuery } from "@tanstack/react-query"
import * as THREE from "three"

import type { FacePort, FacePorts } from "@/lib/api"
import { fetchFacePortsBatched } from "@/lib/face-ports-batch"
import {
  MODEL_PORT_SELECTED,
  PORT_MARKER_M,
  modelPortHex,
  portLocal,
} from "@/lib/model-ports"
import type { ModelPort, V3 } from "@/lib/model-ports"
import {
  normalizePortName,
  useObservedPorts,
} from "@/components/device-faceplate"

/**
 * The ports mapped onto a floor device's 3D model, as small squares on its
 * surface: one instanced draw for the whole device, each square 8 mm,
 * facing out along the mapping's normal, a hair off the surface. Coloured
 * by port state - live SNMP where the device was polled, else cable and
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
  const colors = useMemo(
    () =>
      placed.map((pk) =>
        pk.port.marker === selectedPort
          ? MODEL_PORT_SELECTED
          : modelPortHex(
              pk.port,
              pk.port.kind === "interface"
                ? observed?.get(normalizePortName(pk.port.name))
                : undefined
            )
      ),
    [placed, observed, selectedPort]
  )
  return (
    <MarkerMesh
      placed={placed}
      colors={colors}
      markerM={markerM}
      onSelect={onSelect}
      onFly={onFly}
      card={(pk) => <ModelPortCard port={pk.port} />}
    />
  )
}

/** A device type's mapped ports: no device, so no state - one neutral
 * colour, the name on hover. */
export const MODEL_PORT_TEMPLATE = "#a1a1aa"

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
  const colors = useMemo(() => placed.map(() => MODEL_PORT_TEMPLATE), [placed])
  return (
    <MarkerMesh
      placed={placed}
      colors={colors}
      markerM={markerM}
      card={(pk) => (
        <div className="ml-3 -translate-y-1/2 rounded-md border border-border bg-popover/95 px-2 py-1.5 text-[11px] whitespace-nowrap text-popover-foreground shadow-md">
          <span className="font-mono font-semibold">{pk.port.name}</span>
        </div>
      )}
    />
  )
}

/** One instanced draw of squares on the model's surface, each facing out
 * along its normal, with a hover card. */
function MarkerMesh<P extends { at: V3; normal: V3 }>({
  placed,
  colors,
  markerM,
  onSelect,
  onFly,
  card,
}: {
  placed: P[]
  colors: string[]
  markerM: number
  onSelect?: (pick: P) => void
  onFly?: (pick: P) => void
  card: (pick: P) => React.ReactNode
}) {
  const invalidate = useThree((s) => s.invalidate)
  const ref = useRef<THREE.InstancedMesh>(null)
  const [hover, setHover] = useState<number | null>(null)

  useLayoutEffect(() => {
    const im = ref.current
    if (!im) return
    // The lift scales with the square, so a bigger one never sinks in.
    const lift = (LIFT_M * markerM) / PORT_MARKER_M
    placed.forEach((pk, i) => {
      _n.set(...pk.normal).normalize()
      _q.setFromUnitVectors(Z_AXIS, _n)
      _p.set(...pk.at).addScaledVector(_n, lift)
      const k = i === hover ? 1.4 : 1
      _s.set(markerM * k, markerM * k, 1)
      im.setMatrixAt(i, _m.compose(_p, _q, _s))
      im.setColorAt(i, _c.set(colors[i] ?? MODEL_PORT_TEMPLATE))
    })
    im.count = placed.length
    im.instanceMatrix.needsUpdate = true
    if (im.instanceColor) im.instanceColor.needsUpdate = true
    im.computeBoundingSphere()
    invalidate()
  }, [placed, colors, hover, markerM, invalidate])

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
        key={placed.length}
        ref={ref}
        args={[QUAD, undefined, placed.length]}
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
