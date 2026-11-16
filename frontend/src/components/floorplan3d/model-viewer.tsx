import { useEffect, useMemo, useState } from "react"
import { Canvas, useThree } from "@react-three/fiber"
import {
  ContactShadows,
  Html,
  OrbitControls,
  OrthographicCamera,
  PerspectiveCamera,
} from "@react-three/drei"
import * as THREE from "three"

import { Loading } from "@/components/loading"
import { Button } from "@/components/ui/button"
import { PanelRow, PanelShell } from "@/components/map-panel"
import { StatusBadge } from "@/components/status-badge"
import type { PointerMenuAt } from "@/components/pointer-menu"
import {
  ModelViewerMenus,
  bayMenuItems,
  portMenuItems,
  useBayPerms,
  useDeviceBays,
  useOpenPort,
  usePortPerms,
} from "@/components/model-viewer-menus"
import type { BayMenuAt, PortMenuAt } from "@/components/model-viewer-menus"
import type { FacePort, Model3DEffective } from "@/lib/api"
import { faceCamera, faceZoom } from "@/lib/face-camera"
import { plannedParts } from "@/lib/model-assembly"
import { useDeviceLeds } from "@/lib/use-device-leds"
import type { ModelPortsDoc, V3 } from "@/lib/model-ports"

import {
  PlacedModel,
  fittedModel,
  readyParts,
  useDeviceModel,
  useDeviceModels,
} from "./device-model"
import type { ModelEntry, ReadyPart } from "./device-model"
import {
  ModelPortMarkers,
  TemplatePortMarkers,
  portStateText,
} from "./device-model-port-markers"
import type { MappedPortPick } from "./device-model-port-markers"
import { BayHits } from "./bay-hits"
import { Studio, StudioLights } from "./model-preview"
import { STUDIO_LIGHTS } from "./studio"
import { modelTargetM } from "./world"

/**
 * An interactive view of one device or device type model: the Overview's
 * "3D model" card, the device Panel's 3D view and the floor plan panel's
 * preview. One Canvas, drawn on demand; the model comes from the room's
 * shared cache (one download and parse per URL, freed a while after its
 * last user), stood up and fitted exactly as the room stands it, so mapped
 * ports land where they do there.
 *
 * Front, Rear and Top look straight at that face through an orthographic
 * camera fitted to it (lib/face-camera), like a photo or a rack elevation:
 * every port of a row looks the same. Orbiting away keeps that projection -
 * a parallel view turned reads as a drawing, where swapping to perspective
 * mid-drag would jump. "3D" is the perspective three-quarter view.
 *
 * A device's markers are the room's - coloured by port state from the
 * batched face-ports request; a type's are its mapping in one neutral
 * colour. A click on a device's port or module bay selects it and shows
 * it in a panel; a right-click opens its menu (model-viewer-menus). Loaded
 * lazily (three.js stays in its own chunk).
 *
 * A device whose model names bays draws its installed modules in them and
 * its empty bays' covers (model-assembly), as the room does; a type's own
 * model shows as authored.
 *
 * The light is the studio's (STUDIO_LIGHTS), what generated images are
 * rendered with: AgX tone mapping, the procedural studio environment, one
 * key light from the front and a dim fill. The three-quarter view stands
 * the model on a soft contact shadow, drawn once per model and parts set
 * rather than on every frame; the face views have none, like a drawing.
 */

export type ViewPreset = "front" | "rear" | "top" | "iso"

/** The orthographic presets: a face, straight on. */
export const isFaceView = (p: ViewPreset): p is "front" | "rear" | "top" =>
  p !== "iso"

export interface ModelViewerProps {
  model: Pick<Model3DEffective, "url" | "fit" | "up" | "front"> &
    Partial<Pick<Model3DEffective, "bays" | "empty_mode">>
  /** The type's body size (mm), what the model is fitted to. */
  sizeMm?: {
    width_mm?: number | null
    height_mm?: number | null
    depth_mm?: number | null
  } | null
  /** A device: its markers coloured by port state. */
  deviceId?: string | null
  /** For the cable dialog's title. */
  deviceName?: string
  /** The chassis' manufacturer: its module types are offered first. */
  manufacturerId?: string | null
  /** A type: its mapping, drawn neutral. */
  templatePorts?: ModelPortsDoc | null
  markers?: boolean
  /** Rim every port (the Ports toggle: mapping, inspection) instead of the
   * quiet default, where only hovered, selected, cabled and held ports
   * show (lib/port-marker-look). */
  outlineAll?: boolean
  /** The camera preset; `n` replays the same one. */
  view?: { preset: ViewPreset; n: number }
  /** A click on a port goes here instead of selecting it (a small preview
   * with no room for the panel). */
  onPort?: (pick: MappedPortPick) => void
  className?: string
}

/** Where the perspective camera stands for the three-quarter view, around a
 * model of upright size `size` standing on the origin, front on −Z. */
export function presetCamera(size: V3): { position: V3; target: V3 } {
  const cy = size[1] / 2
  const radius = Math.max(Math.hypot(size[0], size[1], size[2]) / 2, 1e-3)
  const d = radius * 2.6
  return {
    position: [d * 0.45, cy + d * 0.35, -d * 0.85],
    target: [0, cy, 0],
  }
}

/** The three-quarter view's contact shadow for a model of upright size
 * `size` standing on the origin: a square reaching past the footprint,
 * catching what stands within `far` of the floor, a hair below it. `blur`
 * is drei's, in 1/256ths of the square: the soft edge stays about 4% of
 * the footprint at any model size. */
export function contactShadowFor(size: V3): {
  scale: number
  far: number
  y: number
  blur: number
} {
  const foot = Math.max(size[0], size[2], 1e-3)
  const scale = foot * 1.6
  return {
    scale,
    far: Math.max(size[1], 0.05) * 0.8,
    y: -foot * 1e-3,
    blur: ((foot * 0.04) / scale) * 256,
  }
}

type OrbitLike = { target: THREE.Vector3; update: () => void }

/** The camera for the preset - orthographic for a face, perspective for
 * 3D - framed on the model. Re-frames on a new preset, a replay, or a
 * resize (fullscreen). */
function Rig({
  size,
  view,
}: {
  size: V3
  view: { preset: ViewPreset; n: number }
}) {
  const camera = useThree((s) => s.camera)
  const controls = useThree((s) => s.controls) as unknown as OrbitLike | null
  const invalidate = useThree((s) => s.invalidate)
  const width = useThree((s) => s.size.width)
  const height = useThree((s) => s.size.height)
  useEffect(() => {
    let position: V3
    let target: V3
    const radius = Math.max(Math.hypot(...size) / 2, 1e-3)
    if (isFaceView(view.preset) && camera instanceof THREE.OrthographicCamera) {
      const fc = faceCamera(size, view.preset, width / Math.max(height, 1))
      position = fc.position
      target = fc.target
      if (view.preset === "top") {
        // A hair toward the front: the orbit keeps +Y up, and this way the
        // model's back is up on screen.
        position = [position[0], position[1], position[2] - radius * 1e-3]
      }
      camera.zoom = faceZoom(fc, width, height)
      camera.near = fc.near
      camera.far = fc.far
    } else {
      ;({ position, target } = presetCamera(size))
      camera.near = radius / 100
      camera.far = radius * 100
    }
    camera.position.set(...position)
    camera.updateProjectionMatrix()
    if (controls) {
      controls.target.set(...target)
      controls.update()
    } else {
      camera.lookAt(...target)
    }
    invalidate()
  }, [camera, controls, invalidate, size, view.preset, view.n, width, height])
  return null
}

/** A selection in the viewer: a mapped port or a module bay. */
type Selection = { kind: "port"; port: FacePort } | { kind: "bay"; bay: string }

interface Pickers {
  selection: Selection | null
  onSelectPort: (pick: MappedPortPick) => void
  onPortMenu?: (pick: MappedPortPick, at: PointerMenuAt) => void
  onSelectBay?: (bay: string) => void
  onBayMenu?: (bay: string, at: PointerMenuAt) => void
}

function Fitted({
  entry,
  parts,
  props,
  pickers,
}: {
  entry: ModelEntry
  parts: readonly ReadyPart[]
  props: ModelViewerProps
  pickers: Pickers
}) {
  const { fit: fitMode, up, front } = props.model
  const w = props.sizeMm?.width_mm ?? null
  const h = props.sizeMm?.height_mm ?? null
  const dp = props.sizeMm?.depth_mm ?? null
  // Keyed on the values, not the objects: a parent re-render must not
  // re-frame the camera.
  const fit = useMemo(
    () =>
      fittedModel(
        entry.box!,
        { fit: fitMode, up, front },
        modelTargetM({ width_mm: w, height_mm: h, depth_mm: dp })
      ),
    [entry.box, fitMode, up, front, w, h, dp]
  )
  const size = useMemo(() => fit.size as V3, [fit])
  const shadow = useMemo(() => contactShadowFor(size), [size])
  // A new parts set re-draws the shadow (its key).
  const partsKey = parts.map((p) => `${p.bay}:${p.position}`).join(",")
  // A device's status LEDs, polled; a type's model shows them dark.
  const leds = useDeviceLeds(props.deviceId ? [props.deviceId] : [])
  const view: { preset: ViewPreset; n: number } = props.view ?? {
    preset: "front",
    n: 0,
  }
  const bays = props.model.bays?.length ? props.model.bays : null
  const { selection } = pickers
  const pickBays = !!props.deviceId && !!bays && !!pickers.onSelectBay
  return (
    <>
      <PlacedModel
        entry={entry}
        fit={fit}
        parts={parts}
        bays={bays}
        emptyMode={props.model.empty_mode}
        leds={props.deviceId ? (leds[props.deviceId] ?? null) : undefined}
        overlay={
          pickBays
            ? (root, drawn) => (
                <BayHits
                  root={root}
                  drawn={drawn}
                  selected={selection?.kind === "bay" ? selection.bay : null}
                  onSelect={pickers.onSelectBay}
                  onMenu={pickers.onBayMenu}
                />
              )
            : undefined
        }
      />
      {props.markers !== false &&
        (props.deviceId ? (
          <ModelPortMarkers
            deviceId={props.deviceId}
            size={size}
            selectedPort={
              selection?.kind === "port" ? selection.port.marker : null
            }
            outlineAll={props.outlineAll}
            onSelect={pickers.onSelectPort}
            onMenu={pickers.onPortMenu}
          />
        ) : props.templatePorts?.ports.length ? (
          <TemplatePortMarkers
            ports={props.templatePorts.ports}
            size={size}
            outlineAll={props.outlineAll}
          />
        ) : null)}
      {!isFaceView(view.preset) && (
        // One frame's depth pass per model and parts set (the key), not
        // one on every frame the demand loop draws.
        <ContactShadows
          key={`${props.model.url}|${partsKey}`}
          position={[0, shadow.y, 0]}
          scale={shadow.scale}
          far={shadow.far}
          opacity={STUDIO_LIGHTS.shadow.opacity}
          blur={shadow.blur}
          resolution={512}
          frames={1}
        />
      )}
      {isFaceView(view.preset) ? (
        <OrthographicCamera makeDefault />
      ) : (
        <PerspectiveCamera makeDefault fov={35} />
      )}
      <Rig size={size} view={view} />
    </>
  )
}

function Model({
  props,
  pickers,
}: {
  props: ModelViewerProps
  pickers: Pickers
}) {
  const entry = useDeviceModel(props.model.url)
  // The installed modules' models, once the chassis names its bays.
  const planned = useMemo(
    () =>
      entry?.status === "ready"
        ? plannedParts(props.model.bays, new Set(entry.anchors.bays))
        : [],
    [entry?.status, entry?.anchors, props.model.bays]
  )
  const partEntries = useDeviceModels(planned.map((p) => p.url))
  const parts = readyParts(planned, partEntries)
  if (!entry || entry.status === "loading")
    return (
      <Html center>
        <Loading />
      </Html>
    )
  if (entry.status === "error" || !entry.box)
    return (
      <Html center>
        <span className="text-xs whitespace-nowrap text-muted-foreground">
          The model could not be loaded.
        </span>
      </Html>
    )
  return <Fitted entry={entry} parts={parts} props={props} pickers={pickers} />
}

/** The selected port or bay, over the canvas's corner. */
function SelectionPanel({
  deviceId,
  selection,
  onClose,
}: {
  deviceId: string
  selection: Selection
  onClose: () => void
}) {
  const openPort = useOpenPort(deviceId)
  const bays = useDeviceBays(selection.kind === "bay" ? deviceId : null)
  if (selection.kind === "port") {
    const p = selection.port
    const far = p.peer
      ? `${p.peer.device} · ${p.peer.port}`
      : p.connected
        ? "Cabled"
        : null
    return (
      <PanelShell
        label="Port"
        title={<span className="font-mono">{p.name}</span>}
        titleText={p.name}
        onClose={onClose}
        footer={
          p.id ? (
            <Button size="sm" variant="outline" onClick={() => openPort(p)}>
              {p.kind === "interface" ? "Open interface" : "Open on device"}
            </Button>
          ) : undefined
        }
      >
        <PanelRow label="State">{portStateText(p)}</PanelRow>
        {p.type && <PanelRow label="Type">{p.type}</PanelRow>}
        {far && (
          <PanelRow label="Far end">
            <span className="font-mono">{far}</span>
          </PanelRow>
        )}
        {p.vlan && (
          <PanelRow label="VLAN">
            <span className="num">{p.vlan.vlan_id}</span>
            {p.vlan.name ? ` · ${p.vlan.name}` : ""}
          </PanelRow>
        )}
      </PanelShell>
    )
  }
  const row = bays.data?.results.find((b) => b.name === selection.bay) ?? null
  return (
    <PanelShell label="Module bay" title={selection.bay} onClose={onClose}>
      <PanelRow label="Module">
        {row?.module ? row.module.module_type.name : "Empty"}
      </PanelRow>
      {row?.module?.status && (
        <PanelRow label="Status">
          <StatusBadge status={row.module.status} />
        </PanelRow>
      )}
      {row?.module?.serial_number && (
        <PanelRow label="Serial">
          <span className="font-mono">{row.module.serial_number}</span>
        </PanelRow>
      )}
      {row?.position && (
        <PanelRow label="Position">
          <span className="num font-mono">{row.position}</span>
        </PanelRow>
      )}
    </PanelShell>
  )
}

export default function ModelViewer(props: ModelViewerProps) {
  const deviceId = props.deviceId ?? null
  const [selection, setSelection] = useState<Selection | null>(null)
  const [portMenu, setPortMenu] = useState<PortMenuAt | null>(null)
  const [bayMenu, setBayMenu] = useState<BayMenuAt | null>(null)
  // What a right-click may offer: a menu with nothing in it never opens.
  const portPermsIface = usePortPerms("interface")
  const bayPerms = useBayPerms()
  const bays = useDeviceBays(props.model.bays?.length ? deviceId : null)
  // A new device or model: nothing of the old one stays selected.
  useEffect(() => setSelection(null), [deviceId, props.model.url])

  const pickers: Pickers = {
    selection,
    onSelectPort: (pk) => {
      if (props.onPort) props.onPort(pk)
      else setSelection({ kind: "port", port: pk.port })
    },
    onPortMenu: deviceId
      ? (pk, at) => {
          // Every port offers Open; the rest is gated in the menu itself.
          if (portMenuItems(pk.port, portPermsIface).length === 0) return
          setBayMenu(null)
          setPortMenu({ ...at, port: pk.port })
        }
      : undefined,
    onSelectBay: props.onPort
      ? undefined
      : (bay) => setSelection({ kind: "bay", bay }),
    onBayMenu: (bay, at) => {
      const row = bays.data?.results.find((b) => b.name === bay) ?? null
      if (bayMenuItems(row, bayPerms).length === 0) return
      setPortMenu(null)
      setBayMenu({ ...at, bay })
    },
  }
  return (
    <div
      className={`relative w-full overflow-hidden ${props.className ?? "h-72"}`}
      data-model-viewer
    >
      <Canvas
        frameloop="demand"
        dpr={[1, 2]}
        camera={{ fov: 35, position: [1, 1, -2] }}
        gl={{ antialias: true }}
        fallback={<Loading />}
        onPointerMissed={(e) => {
          if (e.button === 0) setSelection(null)
        }}
      >
        <Studio />
        <StudioLights />
        <Model props={props} pickers={pickers} />
        <OrbitControls makeDefault enableDamping={false} />
      </Canvas>
      {deviceId && selection && (
        <SelectionPanel
          deviceId={deviceId}
          selection={selection}
          onClose={() => setSelection(null)}
        />
      )}
      {deviceId && (
        <ModelViewerMenus
          deviceId={deviceId}
          deviceName={props.deviceName}
          manufacturerId={props.manufacturerId}
          portMenu={portMenu}
          bayMenu={bayMenu}
          onClose={() => {
            setPortMenu(null)
            setBayMenu(null)
          }}
        />
      )}
    </div>
  )
}
