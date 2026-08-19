import { useEffect, useMemo, useState } from "react"
import { useThree } from "@react-three/fiber"
import { useQuery } from "@tanstack/react-query"
import * as THREE from "three"

import {
  api,
  type FacePort,
  type FacePorts,
  type ImagePortMarker,
} from "@/lib/api"
import {
  bayHex,
  EMPTY_LEGEND,
  legendContent,
  liveHex,
  portCapabilityHex,
  portHex,
} from "@/lib/faceplate-colors"
import {
  normalizePortName,
  useObservedPorts,
} from "@/components/device-faceplate"
import { useReportLegend, type LegendReporter } from "@/components/speed-scale"

import { useMaxAnisotropy } from "./texture-quality"
import {
  TRANSPARENT_ORDER,
  deviceBoxM,
  syntheticPortMarkers,
  type SceneDevice,
  type SceneRack,
} from "./world"

export const DEVICE_FALLBACK = "#52525b"
const DEVICE_SELECTED = "#0ea5e9"
/** Standing edge line - the box's silhouette, dark enough to read against
 * both a pale faceplate photo and a dark role colour. */
const DEVICE_EDGE = "#18181b"

// Photo-port quad tint: the SAME status colours the 2D faceplate uses (speed
// tint via portState / PORT_STATE_HEX, live SNMP via liveHex), so a port lights
// identically in 2D and 3D. A marker with no matching component on THIS device
// is "undefined" (dim grey); a selected/armed port is amber.
const PORT_UNDEFINED = "#3f3f46" // zinc-700 · marker with no real port here
const PORT_SELECTED = "#fbbf24" // amber-400 · picked for cabling
// Observed reality disagrees with the record. Outlined, NOT recoloured: the
// marker keeps showing the source of truth and the drift reads as a separate
// signal - same contract as the 2D faceplate's amber ring.
const PORT_DRIFT = "#f59e0b" // amber-500
/** How far the drift halo sticks out past the marker (metres) - ~2mm each side,
 * visible at rack distance without swallowing a small disk bay. */
const DRIFT_HALO_M = 0.004

// ─── Shared box + edge geometry ──────────────────────────────────────────────
// A hall of full cabinets holds thousands of devices, and nearly all of them
// are one of a handful of sizes (1U and 2U at full width). Allocating a fresh
// BoxGeometry AND EdgesGeometry per device meant ~5000 buffers for ~4 distinct
// shapes - the dominant cost once racks got filled. Keyed to the millimetre
// and shared: three.js keeps transforms per mesh, so one geometry serves any
// number of devices. Never disposed - the set is tiny and lives as long as
// the room does.
const boxCache = new Map<string, THREE.BoxGeometry>()
const edgeCache = new Map<string, THREE.BufferGeometry>()

const sizeKey = (w: number, h: number, d: number) =>
  `${Math.round(w * 1000)}:${Math.round(h * 1000)}:${Math.round(d * 1000)}`

function sharedBox(w: number, h: number, d: number): THREE.BoxGeometry {
  const key = sizeKey(w, h, d)
  let g = boxCache.get(key)
  if (!g) {
    g = new THREE.BoxGeometry(w, h, d)
    boxCache.set(key, g)
  }
  return g
}

function sharedEdges(w: number, h: number, d: number): THREE.BufferGeometry {
  const key = sizeKey(w, h, d)
  let g = edgeCache.get(key)
  if (!g) {
    g = new THREE.EdgesGeometry(sharedBox(w, h, d))
    edgeCache.set(key, g)
  }
  return g
}

/** Shared photo-plane geometry, same reasoning as the box cache. */
const planeCache = new Map<string, THREE.PlaneGeometry>()

function sharedPlane(w: number, h: number): THREE.PlaneGeometry {
  const key = `${Math.round(w * 1000)}:${Math.round(h * 1000)}`
  let g = planeCache.get(key)
  if (!g) {
    g = new THREE.PlaneGeometry(w, h)
    planeCache.set(key, g)
  }
  return g
}

/** ONE material per image, not one per device wearing it. Twenty identical
 * servers used to mint twenty MeshBasicMaterials around the same texture, and
 * the renderer sorts by material - distinct materials mean re-binding the
 * program and uniforms for every box instead of once for the whole batch. */
const faceMaterialCache = new Map<THREE.Texture, THREE.MeshBasicMaterial>()

function sharedFaceMaterial(t: THREE.Texture): THREE.MeshBasicMaterial {
  let m = faceMaterialCache.get(t)
  if (!m) {
    m = new THREE.MeshBasicMaterial({ map: t, toneMapped: false })
    faceMaterialCache.set(t, m)
  }
  return m
}

// ─── Face-texture cache ──────────────────────────────────────────────────────
// One texture per device-type image URL, shared across every device box that
// wears it (a rack of 20 identical switches loads one image). LRU-capped so a
// huge catalog can't hold the GPU hostage - but generously: a tight cap made
// rooms with many distinct device types thrash (evict → reload → planes
// flickering in and out while moving).
const MAX_TEXTURES = 256
const cache = new Map<string, THREE.Texture>()

function getTexture(
  url: string,
  anisotropy: number,
  onLoad: () => void
): THREE.Texture | null {
  const hit = cache.get(url)
  if (hit) {
    // Refresh LRU position.
    cache.delete(url)
    cache.set(url, hit)
    return hit
  }
  new THREE.TextureLoader().load(url, (t) => {
    t.colorSpace = THREE.SRGBColorSpace
    t.anisotropy = anisotropy
    if (cache.size >= MAX_TEXTURES) {
      const oldest = cache.keys().next().value
      if (oldest) {
        cache.get(oldest)?.dispose()
        cache.delete(oldest)
      }
    }
    cache.set(url, t)
    onLoad()
  })
  return null
}

/** Subscribe to a cached texture; re-renders (and re-draws the demand-frameloop
 * canvas) when it lands. */
function useFaceTexture(url: string | null): THREE.Texture | null {
  const invalidate = useThree((s) => s.invalidate)
  const anisotropy = useMaxAnisotropy()
  const [, bump] = useState(0)
  const tex = url ? (cache.get(url) ?? null) : null
  useEffect(() => {
    if (!url || cache.has(url)) return
    getTexture(url, anisotropy, () => {
      bump((n) => n + 1)
      invalidate()
    })
  }, [url, anisotropy, invalidate])
  return tex
}

/**
 * One racked device: a box at its true U position, clickable, wearing its
 * device-type face image on the exposed side when one exists (the rest of the
 * box keeps the role color). Rendered only in the rack's near-LOD tier, so
 * textures never load for far-away cabinets.
 */
export function DeviceMesh({
  rack,
  dev,
  rackWidthM,
  rackDepthM,
  selected,
  ghosted = false,
  selectedPort,
  showTexture,
  viewRear,
  livePorts,
  onSelect,
  onSelectPort,
  onZoomTo,
  onLegend,
}: {
  rack: SceneRack
  dev: SceneDevice
  rackWidthM: number
  rackDepthM: number
  selected: boolean
  /** X-ray / focus dimming: the box fades to a low-opacity ghost (still
   * clickable - clicking a ghost selects it, which un-ghosts it). The
   * caller also drops `showTexture`, so ghosts never fetch images/ports. */
  ghosted?: boolean
  /** Name of the photo port currently selected on THIS device, if any. */
  selectedPort?: string | null
  /** Near tier only - keeps image fetches away from far cabinets. */
  showTexture: boolean
  /** True while the camera is behind the cabinet - picks which of the device's
   * own panels (and which photo) is the one you can see. */
  viewRear: boolean
  /** Resolve markers to real ports and poll live SNMP. Costs two fetches per
   * device, so the caller grants it only for the engaged cabinet. */
  livePorts: boolean
  onSelect: (deviceId: string) => void
  /** A photo port was clicked - anchor for HUD + cable building. `side` is
   * the device PANEL the marker lives on (image_ports front vs rear) - the
   * key face-ports resolves it under. */
  onSelectPort: (
    deviceId: string,
    marker: ImagePortMarker,
    side: "front" | "rear"
  ) => void
  /** Double-click - fly the camera onto this device's face. Same gesture the
   * rack already answers, one level down. */
  onZoomTo?: (dev: SceneDevice) => void
  /** Report the colours this face puts on screen, so the room's legend keys
   * only those. Near tier only - a far cabinet draws no port colours. */
  onLegend?: LegendReporter
}) {
  const [hovered, setHovered] = useState(false)
  const [hoveredPort, setHoveredPort] = useState<number | null>(null)
  // Shared geometry - the cables layer anchors runs to these same numbers.
  const { y, h, dx, dz, dw, dd, boxH, mountedRear } = deviceBoxM(
    rack,
    dev,
    rackWidthM,
    rackDepthM
  )

  // Which of the device's OWN two panels the camera can see. A full-depth box
  // on the front rail shows its front panel to the cold aisle and its REAR
  // panel to whoever is standing behind the cabinet; a rear-mounted box is the
  // other way round. Keying this off the mount face alone meant walking around
  // to the hot aisle still showed you front photos, and rear images never
  // rendered at all.
  const showingFront = viewRear === mountedRear
  const imageUrl = showingFront
    ? (dev.front_image ?? dev.rear_image)
    : (dev.rear_image ?? dev.front_image)
  const texture = useFaceTexture(showTexture ? imageUrl : null)

  // Resolve this device's markers to real ports (id + cabled state) so the
  // quads can be lit by connection status, not just drawn. Lazy: only near
  // (showTexture) devices that actually carry markers on the shown face.
  const side = showingFront ? "front" : "rear"
  // Memoized: the legend derives from these, and a fresh `[]` every render
  // would make it recompute (and re-report) forever.
  //
  // Power components with no photo marker get SYNTHETIC quads on the rear
  // panel - laid out by world.syntheticPortMarkers, the same function the
  // cable layer anchors runs with, then rendered/clicked through the exact
  // same path as photo markers. Without them a PSU inlet that no photo marks
  // simply could not be clicked to start a connection.
  const synthetic = useMemo(
    () => (side === "rear" ? syntheticPortMarkers(dev) : []),
    [dev, side]
  )
  const markers = useMemo(() => {
    const real = dev.image_ports?.[side] ?? []
    return synthetic.length ? [...real, ...synthetic] : real
  }, [dev, side, synthetic])
  // Markers still DRAW without this (they ride in the scene payload); what it
  // gates is resolving them to real ports and polling live SNMP, which is two
  // requests per device. See the caller for why that has to stay bounded.
  const wantPorts = showTexture && livePorts && markers.length > 0
  const facePorts = useQuery({
    queryKey: ["device-face-ports", dev.id],
    queryFn: () => api<FacePorts>(`/api/devices/${dev.id}/face-ports/`),
    enabled: wantPorts,
    staleTime: 30_000,
  })
  const resolved = useMemo(() => {
    const m = new Map<string, FacePort>()
    const d = facePorts.data
    if (d) for (const p of [...d.front, ...d.rear]) m.set(p.marker, p)
    return m
  }, [facePorts.data])
  // Live SNMP facts, same source (and cache) as the 2D faceplate - near
  // devices with markers only, so the room doesn't poll every cabinet.
  const observed = useObservedPorts(wantPorts ? dev.id : undefined)
  // Demand frameloop: nudge a redraw when the resolved/live state (colours) land.
  const invalidate = useThree((s) => s.invalidate)
  useEffect(() => {
    invalidate()
  }, [resolved, observed, invalidate])

  // Which colours this face actually uses - walked exactly like the quads
  // below, so the room's legend can't claim a tier nothing on screen wears.
  const legend = useMemo(() => {
    if (!wantPorts) return EMPTY_LEGEND
    const ports: Parameters<typeof legendContent>[0]["ports"] = []
    const parts: { status?: { id: string } | null }[] = []
    const bays: { occupied: boolean }[] = []
    const obs = new Map<string, { oper_status: string; admin_status: string }>()
    for (const m of markers) {
      const fp = resolved.get(m.name)
      if (!fp?.id) continue
      // A module bay reads occupancy, not health - and it shares `kind: null`
      // with hardware, so the MARKER's kind is what tells them apart.
      if (m.kind === "module-bay") {
        bays.push({ occupied: !!fp.module })
        continue
      }
      // kind === null is a hardware marker: status colour, not a speed tier.
      if (fp.kind === null) {
        parts.push({ status: fp.status })
        continue
      }
      ports.push({
        enabled: fp.enabled,
        cable: fp.connected,
        speed: fp.speed,
        type: fp.type,
      })
      const key = normalizePortName(fp.name)
      const live = observed?.get(key)
      if (live) obs.set(key, live)
    }
    return legendContent({ ports, observed: obs, parts, bays })
  }, [wantPorts, markers, resolved, observed])
  useReportLegend(onLegend, dev.id, legend)

  const bodyColor = selected
    ? DEVICE_SELECTED
    : hovered && !ghosted
      ? "#71717a"
      : dev.role_color || DEVICE_FALLBACK

  // Both SHARED across every device of the same size - see the caches above.
  // The edge line is drawn for every solid device, not just the selected one:
  // with a photo face on the front and the studio key light raking the sides,
  // an un-edged box loses its silhouette and the faceplate reads as a picture
  // floating in the rack.
  const box = sharedBox(dw, boxH, dd)
  const edges = ghosted ? null : sharedEdges(dw, boxH, dd)

  return (
    <group
      position={[dx, y + h / 2, dz]}
      onClick={(e) => {
        e.stopPropagation()
        onSelect(dev.id)
      }}
      onDoubleClick={
        onZoomTo
          ? (e) => {
              e.stopPropagation()
              onZoomTo(dev)
            }
          : undefined
      }
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
      {/* receiveShadow as well as cast: without it a device took no shadow
          from the gear above it and the rack interior rendered flat.
          Ghosts take a fixed transparent order so they can't reshuffle
          against the cabinet glass as the camera moves. */}
      <mesh
        castShadow={!ghosted}
        receiveShadow={!ghosted}
        renderOrder={ghosted ? TRANSPARENT_ORDER.ghost : 0}
        geometry={box}
      >
        {/* Ghosting = the room's one transparency convention. */}
        {ghosted ? (
          <meshStandardMaterial
            color={bodyColor}
            roughness={0.55}
            metalness={0.2}
            transparent
            opacity={0.12}
            depthWrite={false}
          />
        ) : (
          <meshStandardMaterial
            color={bodyColor}
            roughness={0.55}
            metalness={0.2}
          />
        )}
      </mesh>
      {(texture || synthetic.length > 0) && (
        // The exposed face, textured with the device-type photo, plus any
        // photo-anchored port markers on top of it. Both share one frame
        // (a hair off the box to dodge z-fighting). It sits on the side the
        // camera is on, not the side the box is bolted to: the rack's front
        // plane faces −Z, its rear +Z. Synthetic power quads don't need the
        // photo, so the frame mounts for them even with no face image.
        <group
          position={[0, 0, (dd / 2 + 0.002) * (viewRear ? 1 : -1)]}
          rotation={[0, viewRear ? 0 : Math.PI, 0]}
        >
          {texture && (
            <mesh
              geometry={sharedPlane(dw, boxH)}
              material={sharedFaceMaterial(texture)}
            />
          )}
          {markers.map((m, i) => {
            // image (mx,my): x right, y DOWN from top-left → plane-local X
            // right, Y up, so flip y. Each quad owns its pointer events and
            // stops propagation, so a port is hoverable/clickable on its own
            // rather than folding into the whole device's click.
            const isSel = selectedPort != null && m.name === selectedPort
            const isHot = hoveredPort === i
            const fp = resolved.get(m.name)
            const defined = !!fp?.id
            // Same colouring as the 2D faceplate: live SNMP wins when present,
            // else the speed/cable/enabled tint (with the type's max speed as
            // fallback). Free ports show their capability tier, faded.
            const obs = defined
              ? observed?.get(normalizePortName(fp!.name))
              : undefined
            const tint = defined
              ? {
                  enabled: fp!.enabled,
                  cable: fp!.connected,
                  speed: fp!.speed,
                  type: fp!.type,
                }
              : null
            const capability = tint ? portCapabilityHex(tint) : null
            // Module bays share `kind: null` with hardware, so the MARKER's
            // kind separates them: a bay reads occupied/empty, a part reads
            // health. Both from the shared colour module, so 2D and 3D can't
            // teach different colours.
            const bay = defined && m.kind === "module-bay"
            const bayFull = bay && !!fp.module
            // Hardware markers (disk bays…): the PART's status colour
            // (failed = red), same as the 2D photo faceplate.
            const hardware = defined && !bay && fp!.kind === null
            const color = isSel
              ? PORT_SELECTED
              : !defined
                ? PORT_UNDEFINED
                : bay
                  ? bayHex(bayFull)
                  : hardware
                    ? fp!.status?.color || "#64748b"
                    : obs
                      ? liveHex(obs)
                      : (capability ?? portHex(tint!))
            // Undefined markers sit dim in the back; idle ports and empty bays
            // faint (the photo stays the star - mirrors the 2D ~35% outline);
            // lit ports, hardware and filled bays solid.
            const opacity =
              isSel || isHot
                ? 0.9
                : !defined
                  ? 0.2
                  : bay
                    ? bayFull
                      ? 0.66
                      : 0.32
                    : !hardware && capability
                      ? 0.32
                      : 0.66
            return (
              <group key={i}>
                {/* Drift halo: an amber quad a touch larger, sitting just
                    BEHIND the marker so only its border shows - the 3D reading
                    of the 2D ring. Declarative <planeGeometry> so r3f owns
                    (and disposes) it; raycast off so it never eats a click. */}
                {defined && fp!.drift && !isSel && (
                  <mesh
                    raycast={() => null}
                    position={[(m.x - 0.5) * dw, (0.5 - m.y) * boxH, 0.001]}
                  >
                    <planeGeometry
                      args={[
                        m.w * dw + DRIFT_HALO_M,
                        m.h * boxH + DRIFT_HALO_M,
                      ]}
                    />
                    <meshBasicMaterial
                      color={PORT_DRIFT}
                      transparent
                      opacity={0.95}
                      toneMapped={false}
                      depthWrite={false}
                    />
                  </mesh>
                )}
                <mesh
                  name={m.name}
                  position={[(m.x - 0.5) * dw, (0.5 - m.y) * boxH, 0.0015]}
                  onClick={(e) => {
                    e.stopPropagation()
                    // The panel this marker is ON (the shown side), not the
                    // face the box is bolted to: a front-mounted server's PSU
                    // markers live in image_ports.rear, and face-ports
                    // resolves per panel - passing the mount face made every
                    // rear-panel port unresolvable from the HUD.
                    onSelectPort(dev.id, m, side)
                  }}
                  onPointerOver={(e) => {
                    e.stopPropagation()
                    setHoveredPort(i)
                    document.body.style.cursor = "pointer"
                  }}
                  onPointerOut={(e) => {
                    e.stopPropagation()
                    setHoveredPort((cur) => (cur === i ? null : cur))
                    document.body.style.cursor = ""
                  }}
                >
                  <planeGeometry args={[m.w * dw, m.h * boxH]} />
                  <meshBasicMaterial
                    color={color}
                    transparent
                    opacity={opacity}
                    toneMapped={false}
                    depthWrite={false}
                  />
                </mesh>
              </group>
            )
          })}
        </group>
      )}
      {edges && (
        <lineSegments geometry={edges} raycast={() => null}>
          <lineBasicMaterial
            color={selected ? DEVICE_SELECTED : DEVICE_EDGE}
            transparent={!selected}
            opacity={selected ? 1 : 0.5}
          />
        </lineSegments>
      )}
    </group>
  )
}
