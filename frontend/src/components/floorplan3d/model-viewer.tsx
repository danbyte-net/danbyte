import { useEffect, useMemo, useState } from "react"
import { Canvas } from "@react-three/fiber"
import { Html } from "@react-three/drei"
import { Link } from "@tanstack/react-router"
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
import type { DeviceLeds } from "@/lib/led-state"
import { plannedParts } from "@/lib/model-assembly"
import { memberText } from "@/lib/stacks"
import { useDeviceLeds } from "@/lib/use-device-leds"
import { pluggedNames, portTransceivers } from "@/lib/port-plugs"
import { effectivePluggables, usePluggablesMode } from "@/lib/pluggables-pref"
import type { ModelPortsDoc, V3 } from "@/lib/model-ports"

import {
  PlacedModel,
  fittedModel,
  hasBakedAo,
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
import { CameraRig } from "./camera-rig"
import { PortPickPrecedence } from "./port-pick"
import { PlugOverlayScope } from "./plug-overlay"
import { Studio } from "./model-preview"
import { StackModels } from "./stack-viewer"
import type { StackMemberPick } from "./stack-viewer"
import {
  ViewerStage,
  contactShadowFor,
  isFaceView,
  presetCamera,
} from "./viewer-stage"
import type { ViewPreset } from "./viewer-stage"
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
 * key light from the front and a dim fill. The key casts soft shadows
 * from a shadow camera fitted to the model, so modules shade the chassis
 * and ears the bezel. On a capable GPU, screen-space ambient occlusion
 * (viewer-look) darkens port cages, vents and seams - lighter when the
 * model brings baked occlusion of its own; a software renderer or a weak
 * device gets the plain render. The three-quarter view stands the model on
 * a soft contact shadow, drawn once per model and parts set rather than on
 * every frame; the face views have none, like a drawing.
 */

export { contactShadowFor, isFaceView, presetCamera }
export type { ViewPreset }

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
  /** A stack member: draw every member the reader may view, stacked, with
   * the stack cables (stack-viewer). */
  stackView?: boolean
  /** The camera preset; `n` replays the same one. */
  view?: { preset: ViewPreset; n: number }
  /** A click on a port goes here instead of selecting it (a small preview
   * with no room for the panel). */
  onPort?: (pick: MappedPortPick) => void
  /** Drawn in the model's own frame, beside it (a part's seated cord on the
   * Pluggables page). Gets the drawn root. */
  overlay?: (root: THREE.Object3D) => React.ReactNode
  className?: string
}

/** A selection in the viewer: a mapped port, a module bay, or another
 * member of the device's stack. */
type Selection =
  | { kind: "port"; port: FacePort }
  | { kind: "bay"; bay: string }
  | { kind: "member"; member: StackMemberPick }

export interface Pickers {
  selection: Selection | null
  onSelectPort: (pick: MappedPortPick) => void
  onPortMenu?: (pick: MappedPortPick, at: PointerMenuAt) => void
  onSelectBay?: (bay: string) => void
  onBayMenu?: (bay: string, at: PointerMenuAt) => void
  onSelectMember?: (member: StackMemberPick) => void
  /** Clears the selection, as a click on empty space does. */
  onClearSelection?: () => void
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
  // A new parts set re-draws the shadow (its key).
  const partsKey = parts.map((p) => `${p.bay}:${p.position}`).join(",")
  // A device's status LEDs, polled; a type's model shows them dark.
  const leds = useDeviceLeds(props.deviceId ? [props.deviceId] : [])
  const view: { preset: ViewPreset; n: number } = props.view ?? {
    preset: "front",
    n: 0,
  }
  // A model with its own baked occlusion needs less of the screen's.
  const baked =
    hasBakedAo(entry.scene) || parts.some((p) => hasBakedAo(p.entry.scene))
  return (
    <ViewerStage
      size={size}
      baked={baked}
      view={view}
      shadowKey={`${props.model.url}|${partsKey}`}
    >
      <PlugOverlayScope>
        <FittedContent
          entry={entry}
          fit={fit}
          parts={parts}
          props={props}
          pickers={pickers}
          leds={props.deviceId ? (leds[props.deviceId] ?? null) : undefined}
        />
      </PlugOverlayScope>
    </ViewerStage>
  )
}

/**
 * One fitted model with what rides on it: the device's plugs and bays,
 * its port markers (a type's: its mapping). Mounted in a PlugOverlayScope;
 * the stack view draws the current member with it too.
 */
export function FittedContent({
  entry,
  fit,
  parts,
  props,
  pickers,
  leds,
  deviceId,
  onPortHover,
}: {
  entry: ModelEntry
  fit: ReturnType<typeof fittedModel>
  parts: readonly ReadyPart[]
  props: ModelViewerProps
  pickers: Pickers
  /** The device's lights and plugs (undefined: a type's model). */
  leds: DeviceLeds | null | undefined
  /** Publishes its stack cables' ends under this id (stack-viewer). */
  deviceId?: string
  /** The hovered port (by name), or null, on a change. */
  onPortHover?: (port: string | null) => void
}) {
  const size = fit.size
  const bays = props.model.bays?.length ? props.model.bays : null
  const { selection } = pickers
  // The parts in the ports: the viewer's choice, ghosted while Ports is on.
  const pluggables = effectivePluggables(
    usePluggablesMode(),
    !!props.outlineAll
  )
  const pickBays = !!props.deviceId && !!bays && !!pickers.onSelectBay
  return (
    <>
      <PlacedModel
        entry={entry}
        fit={fit}
        parts={parts}
        bays={bays}
        emptyMode={props.model.empty_mode}
        leds={leds}
        showPlugs
        pluggables={pluggables}
        deviceId={deviceId}
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
            : props.overlay
        }
      />
      {props.markers !== false &&
        (props.deviceId ? (
          <ModelPortMarkers
            deviceId={props.deviceId}
            size={size}
            plugged={pluggables === "hide" ? undefined : pluggedNames(leds)}
            transceivers={portTransceivers(leds)}
            selectedPort={
              selection?.kind === "port" ? selection.port.marker : null
            }
            outlineAll={props.outlineAll}
            onSelect={pickers.onSelectPort}
            onMenu={pickers.onPortMenu}
            onHoverChange={onPortHover}
          />
        ) : props.templatePorts?.ports.length ? (
          <TemplatePortMarkers
            ports={props.templatePorts.ports}
            size={size}
            outlineAll={props.outlineAll}
          />
        ) : null)}
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
  const single = <SingleModel props={props} pickers={pickers} />
  if (props.stackView && props.deviceId)
    return (
      <StackModels
        deviceId={props.deviceId}
        props={props}
        pickers={pickers}
        fallback={single}
      />
    )
  return single
}

function SingleModel({
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
  if (!entry || entry.status === "loading") return <ViewerLoading />
  if (entry.status === "error" || !entry.box) return <ViewerFailed />
  return <Fitted entry={entry} parts={parts} props={props} pickers={pickers} />
}

/** The canvas while the model loads. */
export function ViewerLoading() {
  return (
    <Html center>
      <Loading />
    </Html>
  )
}

/** The canvas when the model could not be loaded. */
export function ViewerFailed() {
  return (
    <Html center>
      <span className="text-xs whitespace-nowrap text-muted-foreground">
        The model could not be loaded.
      </span>
    </Html>
  )
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
  if (selection.kind === "member") {
    const m = selection.member
    return (
      <PanelShell
        label="Stack member"
        title={<span className="font-mono">{m.name}</span>}
        titleText={m.name}
        onClose={onClose}
        footer={
          <Button size="sm" variant="outline" asChild>
            <Link to="/devices/$id" params={{ id: m.device }}>
              Open device
            </Link>
          </Button>
        }
      >
        <PanelRow label="Stack">
          <span className="font-mono">{m.stack.name}</span>
        </PanelRow>
        <PanelRow label="Member">{memberText(m.stack)}</PanelRow>
        {!m.stack.master && m.stack.master_name && (
          <PanelRow label="Master">
            <span className="font-mono">{m.stack.master_name}</span>
          </PanelRow>
        )}
      </PanelShell>
    )
  }
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
  // A new device, model or view: nothing of the old one stays selected.
  useEffect(
    () => setSelection(null),
    [deviceId, props.model.url, props.stackView]
  )

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
    onSelectMember: (member) => setSelection({ kind: "member", member }),
    onClearSelection: () => setSelection(null),
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
        shadows={{ type: THREE.PCFShadowMap }}
        fallback={<Loading />}
        onPointerMissed={(e) => {
          if (e.button === 0) setSelection(null)
        }}
      >
        <PortPickPrecedence />
        <Studio />
        <Model props={props} pickers={pickers} />
        <CameraRig
          target={[0, 0, 0]}
          keyboard={false}
          floor={false}
          minDistance={0.005}
          minNear={0.0005}
        />
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
