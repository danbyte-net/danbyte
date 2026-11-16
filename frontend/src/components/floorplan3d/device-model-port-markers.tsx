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
import { modelPortHex, portLocal } from "@/lib/model-ports"
import {
  MARKER_FILL_OPACITY,
  markerLook,
  markerShape,
  rimWidth,
  roundedRect,
  shapeKey,
} from "@/lib/port-marker-look"
import type {
  MarkerLook,
  MarkerMode,
  MarkerShape,
} from "@/lib/port-marker-look"
import type { PointerMenuAt } from "@/components/pointer-menu"
import type { ModelPort, V3 } from "@/lib/model-ports"
import {
  normalizePortName,
  useObservedPorts,
} from "@/components/device-faceplate"

import { PORT_MARKERS_KEY } from "./port-pick"
import { KeepInView } from "./keep-in-view"

/**
 * The ports mapped onto a floor device's 3D model, each drawn as its own
 * opening (lib/port-marker-look): a rounded rectangle exactly the size the
 * model's `port:` anchor names (export spec size extras) - else the
 * standard box for the port's type - turned with the anchor and standing a
 * hair in front of the opening. Quiet by default: a free port draws
 * nothing until hovered, a cabled one a faint wash, a held one an amber
 * rim; `outlineAll` rims every port. Coloured by port state - live SNMP
 * where the device was polled, else cable and speed - from the room's
 * batched face-ports request, so the colours land with everything else's.
 *
 * Hover names the port, its state, the far end and its VLAN; click selects
 * it (the room's port card); double-click flies to it. The caller mounts
 * this only up close (`markersVisible`), so a hall of devices draws none.
 * The Overview's model viewer and the floor plan panel draw the same
 * markers on the model they frame.
 */

const QUAD = new THREE.PlaneGeometry(1, 1)
const _m = new THREE.Matrix4()
const _r = new THREE.Matrix4()
const _q = new THREE.Quaternion()
const _p = new THREE.Vector3()
const _s = new THREE.Vector3()
const _u = new THREE.Vector3()
const _v = new THREE.Vector3()
const _n = new THREE.Vector3()
const _c = new THREE.Color()
/** How far a marker stands in front of the opening (m): over it, never in
 * the faceplate. The rim sits a little further out than the wash. */
const LIFT_M = 0.001
const RIM_LIFT_M = 0.0013

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
  outlineAll = false,
}: {
  deviceId: string
  /** The fitted model's upright size (m). */
  size: V3
  /** The mapped port selected in the room (its marker name), if any. */
  selectedPort: string | null
  onSelect: (pick: MappedPortPick) => void
  onFly?: (pick: MappedPortPick) => void
  /** Right-click on a port, at the pointer. */
  onMenu?: (pick: MappedPortPick, at: PointerMenuAt) => void
  /** Rim every port (mapping, inspection), not only the ones that carry
   * something. */
  outlineAll?: boolean
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
        shape: markerShape(
          {
            n: fp.n!,
            s: fp.s,
            u: fp.u,
            r: fp.r,
            kind: fp.kind,
            type: fp.type,
          },
          size
        ),
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
    (pk: (typeof placed)[number], mode: MarkerMode) =>
      markerLook(
        pk.port,
        hexes[index.get(pk) ?? -1] ?? MODEL_PORT_TEMPLATE,
        mode,
        outlineAll
      ),
    [hexes, index, outlineAll]
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

export function TemplatePortMarkers({
  ports,
  size,
  outlineAll = false,
}: {
  ports: readonly ModelPort[]
  size: V3
  outlineAll?: boolean
}) {
  const placed = useMemo(
    () =>
      ports.map((mp) => ({
        port: mp,
        at: portLocal(mp.p, size),
        normal: mp.n,
        shape: markerShape(
          { n: mp.n, s: mp.s, u: mp.u, r: mp.r, kind: mp.kind },
          size
        ),
      })),
    [ports, size]
  )
  const lookOf = useCallback(
    (_pk: unknown, mode: MarkerMode) =>
      markerLook({}, MODEL_PORT_TEMPLATE, mode, outlineAll),
    [outlineAll]
  )
  return (
    <MarkerMesh
      placed={placed}
      lookOf={lookOf}
      card={(pk) => (
        <div className="ml-3 -translate-y-1/2 rounded-md border border-border bg-popover/95 px-2 py-1.5 text-[11px] whitespace-nowrap text-popover-foreground shadow-md">
          <span className="font-mono font-semibold">{pk.port.name}</span>
        </div>
      )}
    />
  )
}

function shapeOf(points: [number, number][]): THREE.Shape {
  return new THREE.Shape(points.map(([x, y]) => new THREE.Vector2(x, y)))
}

/** The wash and the rim for one opening size: the opening itself, and a
 * thin ring just outside it, so the port's own edge stays in view. */
function openingGeometries(s: Pick<MarkerShape, "w" | "h" | "r">): {
  fill: THREE.BufferGeometry
  rim: THREE.BufferGeometry
} {
  const rim = rimWidth(s.w, s.h)
  const inner = roundedRect(s.w, s.h, s.r)
  const ring = shapeOf(
    roundedRect(s.w + 2 * rim, s.h + 2 * rim, s.r > 0 ? s.r + rim : 0)
  )
  ring.holes.push(
    new THREE.Path(inner.map(([x, y]) => new THREE.Vector2(x, y)))
  )
  return {
    fill: new THREE.ShapeGeometry(shapeOf(inner)),
    rim: new THREE.ShapeGeometry(ring),
  }
}

/** The right button's travel (px) still read as a click, not a pan. */
const MENU_SLOP_PX = 4

interface Shaped {
  at: V3
  normal: V3
  shape: MarkerShape
}

/** The pose of a marker: at `at`, lifted `lift` along its normal, its X
 * across the opening, Y up it, Z out of the port. */
function pose(pk: Shaped, lift: number, sx: number, sy: number) {
  const { u, v, n } = pk.shape
  _r.makeBasis(_u.set(...u), _v.set(...v), _n.set(...n))
  _q.setFromRotationMatrix(_r)
  _p.set(...pk.at).addScaledVector(_n, lift)
  return _m.compose(_p, _q, _s.set(sx, sy, 1))
}

/**
 * Port markers on a model's surface, each its opening's shape facing out
 * along its normal: a wash where the port carries something and a rim
 * where the look asks for one (markerLook), instanced per opening size,
 * over an invisible rectangle per port that takes the pointer. Hover
 * names the port; click selects; double-click flies to it; a right-click
 * (not a pan) opens the caller's menu.
 */
function MarkerMesh<TPick extends Shaped>({
  placed,
  lookOf,
  selected = null,
  onSelect,
  onFly,
  onMenu,
  card,
}: {
  placed: TPick[]
  lookOf: (pick: TPick, mode: MarkerMode) => MarkerLook
  /** The selected marker's index, if any. */
  selected?: number | null
  onSelect?: (pick: TPick) => void
  onFly?: (pick: TPick) => void
  onMenu?: (pick: TPick, at: PointerMenuAt) => void
  card: (pick: TPick) => React.ReactNode
}) {
  const invalidate = useThree((s) => s.invalidate)
  const hitRef = useRef<THREE.InstancedMesh>(null)
  const [hover, setHover] = useState<number | null>(null)
  const rightDown = useRef<{ x: number; y: number } | null>(null)

  // One geometry pair per opening size; a 48-port row has one or two.
  const groups = useMemo(() => {
    const byKey = new Map<string, number[]>()
    placed.forEach((pk, i) => {
      const k = shapeKey(pk.shape)
      const list = byKey.get(k)
      if (list) list.push(i)
      else byKey.set(k, [i])
    })
    return [...byKey.entries()].map(([key, members]) => ({
      key,
      members,
      geo: openingGeometries(placed[members[0]].shape),
    }))
  }, [placed])
  useEffect(
    () => () => {
      for (const g of groups) {
        g.geo.fill.dispose()
        g.geo.rim.dispose()
      }
    },
    [groups]
  )
  const looks = useMemo(
    () =>
      placed.map((pk, i) =>
        lookOf(pk, i === selected ? "selected" : i === hover ? "hover" : "idle")
      ),
    [placed, lookOf, hover, selected]
  )

  useLayoutEffect(() => {
    const hit = hitRef.current
    if (!hit) return
    placed.forEach((pk, i) => {
      const rim = rimWidth(pk.shape.w, pk.shape.h)
      hit.setMatrixAt(
        i,
        pose(pk, LIFT_M, pk.shape.w + 2 * rim, pk.shape.h + 2 * rim)
      )
    })
    hit.count = placed.length
    hit.instanceMatrix.needsUpdate = true
    hit.computeBoundingSphere()
    invalidate()
  }, [placed, invalidate])

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
        userData={{ [PORT_MARKERS_KEY]: true }}
        onPointerMove={(e) => {
          e.stopPropagation()
          if (e.instanceId == null) return
          // Every move, not only a new port's: crossing a quad's diagonal
          // is a new hit to r3f, which outs the port first.
          setHover(e.instanceId)
          if (onSelect) document.body.style.cursor = "pointer"
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
      {groups.map((g) => (
        <OpeningGroup
          key={g.key}
          placed={placed}
          members={g.members}
          looks={looks}
          fillGeo={g.geo.fill}
          rimGeo={g.geo.rim}
        />
      ))}
      {hot && (
        <Html
          position={hot.at}
          zIndexRange={[20, 0]}
          style={{ pointerEvents: "none" }}
        >
          <KeepInView>{card(hot)}</KeepInView>
        </Html>
      )}
    </>
  )
}

/** The washes and rims of the markers sharing one opening size. A marker
 * the look leaves bare shrinks to nothing. */
function OpeningGroup({
  placed,
  members,
  looks,
  fillGeo,
  rimGeo,
}: {
  placed: readonly Shaped[]
  members: readonly number[]
  looks: readonly MarkerLook[]
  fillGeo: THREE.BufferGeometry
  rimGeo: THREE.BufferGeometry
}) {
  const invalidate = useThree((s) => s.invalidate)
  const fillRef = useRef<THREE.InstancedMesh>(null)
  const rimRef = useRef<THREE.InstancedMesh>(null)
  useLayoutEffect(() => {
    const fill = fillRef.current
    const rim = rimRef.current
    if (!fill || !rim) return
    members.forEach((i, j) => {
      const pk = placed[i]
      const look = looks[i]
      const f = look.fill ? 1 : 0
      fill.setMatrixAt(j, pose(pk, LIFT_M, f, f))
      fill.setColorAt(j, _c.set(look.fill ?? "#000000"))
      const r = look.rim ? 1 : 0
      rim.setMatrixAt(j, pose(pk, RIM_LIFT_M, r, r))
      rim.setColorAt(j, _c.set(look.rim ?? "#000000"))
    })
    for (const im of [fill, rim]) {
      im.count = members.length
      im.instanceMatrix.needsUpdate = true
      if (im.instanceColor) im.instanceColor.needsUpdate = true
      im.computeBoundingSphere()
    }
    invalidate()
  }, [placed, members, looks, invalidate])
  return (
    <>
      <instancedMesh
        key={`fill-${members.length}`}
        ref={fillRef}
        args={[fillGeo, undefined, members.length]}
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
        key={`rim-${members.length}`}
        ref={rimRef}
        args={[rimGeo, undefined, members.length]}
      >
        <meshBasicMaterial toneMapped={false} side={THREE.DoubleSide} />
      </instancedMesh>
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
