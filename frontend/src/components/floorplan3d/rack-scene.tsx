import { useEffect, useMemo, useRef, useState } from "react"
import type { ReactNode } from "react"
import { Camera } from "lucide-react"
import { useQuery } from "@tanstack/react-query"
import * as THREE from "three"

import { api } from "@/lib/api"
import { legendIsEmpty } from "@/lib/faceplate-colors"
import {
  PLUGGABLES_LABEL,
  PLUGGABLES_MODES,
  readPluggablesMode,
  setPluggablesMode,
  usePluggablesMode,
} from "@/lib/pluggables-pref"
import {
  STACKS_LABEL,
  STACKS_MODES,
  readStacksMode,
  setStacksMode,
  useStacksMode,
} from "@/lib/stacks-pref"
import { stackOf } from "@/lib/stacks"
import { setBlanksShown, useBlanksShown } from "@/lib/blanks-pref"
import { useDeviceLedsPayload } from "@/lib/use-device-leds"
import { cn } from "@/lib/utils"
import { usePortLabelsShown } from "@/lib/port-labels-pref"
import { useMe } from "@/lib/use-me"
import { FaceplateLegend } from "@/components/device-faceplate"
import { Loading } from "@/components/loading"
import { CameraModeToggle } from "@/components/camera-mode-toggle"
import {
  BarButton,
  BarMenuTrigger,
  BarToggle,
} from "@/components/map-toolbar"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { QueryError } from "@/components/query-error"
import { StackCableCard, StackCablesMenu } from "@/components/stack-cable-tools"
import { useLegendCollector } from "@/components/speed-scale"
import { PartMarkerMenu, useCanSetPartStatus } from "@/components/part-status"
import { useDeviceMenus } from "@/components/model-viewer-menus"
import type { PartMarkerAt } from "@/components/part-status"

import type { FlyToRequest } from "./camera-rig"
import {
  CARD_PLACE,
  DeviceHud,
  PortHud,
  rackPortPosition,
  useCardPlace,
} from "./hud-cards"
import {
  OBJECT_VIEWS,
  SOLO_PLAN,
  fitDistance,
  objectViewpoint,
  soloTile,
} from "./object-view"
import type { ObjectView } from "./object-view"
import { RackMesh } from "./rack-mesh"
import { newModelBudget, useDrawnModelDevices } from "./rack-model-draw"
import {
  StackCables,
  StackSceneContext,
  newStackScene,
  useStackScene,
} from "./stack-scene"
import type { Sel } from "./rack-mesh"
import {
  NoWebGL,
  ShadowFloor,
  Stage,
  downloadStagePng,
  objectLights,
  storedRenderQuality,
} from "./stage"
import type { StageCapture } from "./stage"
import { rackFootprintM, webglSupported } from "./world"
import type { SceneRack } from "./world"

/** One rack's 3D geometry - `GET /api/racks/{id}/scene/`, the same object a
 * rack tile carries in a floor plan's scene. */
export function useRackScene(rackId: string) {
  return useQuery({
    queryKey: ["rack-scene", rackId],
    queryFn: () => api<SceneRack>(`/api/racks/${rackId}/scene/`),
    staleTime: 30_000,
  })
}

/**
 * One rack on its own in 3D, for its page: the room's rack - open frame,
 * its devices at their true U positions wearing their type's front and
 * rear photos - and nothing else. Drag turns it, the wheel zooms; Front and
 * Rear look straight at either face, a double-click on a device frames it.
 * The ports on the photos are coloured as the room colours them - cabled by
 * speed, free faint, disabled grey, live SNMP where it is polled - and a
 * port held for a cable amber; this rack is the one the page is about, so
 * its ports resolve without a click. Click a device or a port for its card.
 * PNG saves the view.
 *
 * Lazy-load it: three.js stays in its own chunk. `lead` goes first on the
 * toolbar - the page's 2D | 3D switch.
 */
export function RackScene({
  rackId,
  lead,
}: {
  rackId: string
  lead?: ReactNode
}) {
  const supported = useMemo(webglSupported, [])
  const scene = useRackScene(rackId)
  const toolbar = (controls?: ReactNode) => (
    <div
      data-part="rack-toolbar"
      className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2"
    >
      {lead}
      {controls}
    </div>
  )
  if (!supported)
    return (
      <div>
        {toolbar()}
        <NoWebGL className="h-[40rem] max-h-[80vh]" />
      </div>
    )
  if (scene.isError)
    return (
      <div>
        {toolbar()}
        <QueryError error={scene.error} />
      </div>
    )
  if (!scene.data)
    return (
      <div>
        {toolbar()}
        <Loading className="h-[40rem] max-h-[80vh]" />
      </div>
    )
  return (
    <StackRoot>
      <RackView rack={scene.data} toolbar={toolbar} />
    </StackRoot>
  )
}

/** The view's switch stacks (stack-scene), for the canvas and the cards;
 * the canvas bridges the context in. */
function StackRoot({ children }: { children: ReactNode }) {
  const [stackScene] = useState(newStackScene)
  return (
    <StackSceneContext.Provider value={stackScene}>
      {children}
    </StackSceneContext.Provider>
  )
}

export default RackScene

function RackView({
  rack,
  toolbar,
}: {
  rack: SceneRack
  toolbar: (controls?: ReactNode) => ReactNode
}) {
  const quality = useMemo(storedRenderQuality, [])
  // Read once here and handed down, as the room does: a device must not
  // subscribe to /api/me on its own.
  const { faceplatePortLabels, faceplatePortLabelColor } = useMe()
  const portLabelsShown = usePortLabelsShown()
  const tile = useMemo(() => soloTile(rack.id, { rack }), [rack])
  // The rack's model budget and LED request, held here so the stacks in
  // the same answer reach the stack cables and the device card.
  const [budget] = useState(newModelBudget)
  const { devices: leds, stacks } = useDeviceLedsPayload(
    useDrawnModelDevices(budget)
  )
  const stacksMode = useStacksMode()
  const pluggables = usePluggablesMode()
  const blanks = useBlanksShown()
  const { width, depth, height } = rackFootprintM(rack)
  const size = Math.max(width, depth, height)
  const dist = fitDistance({ width, height, depth })
  const viewpoint = (v: ObjectView) =>
    objectViewpoint(height, dist, OBJECT_VIEWS[v].yaw, OBJECT_VIEWS[v].pitch)
  const start = viewpoint("angle")

  const [selection, setSelection] = useState<Sel | null>(null)
  // The stack cables' picked one (stack-cable-tools); a click on a port
  // with a stack cable picks that cable.
  const stackLinks = useStackScene()!.links
  const portSel = selection?.kind === "port" ? selection : null
  useEffect(() => {
    if (portSel?.deviceId && portSel.portName)
      stackLinks.selectPort(portSel.deviceId, portSel.portName)
  }, [stackLinks, portSel?.deviceId, portSel?.portName])
  // A right-click on a disk or a PSU: its part's statuses at the pointer.
  const canSetStatus = useCanSetPartStatus()
  const [partMenu, setPartMenu] = useState<PartMarkerAt | null>(null)
  // A right-click on a port or a module bay: the device menus.
  const deviceMenus = useDeviceMenus()
  const card = useCardPlace()
  const { content: legend, report: onLegend } = useLegendCollector()
  const flyToRef = useRef<FlyToRequest | null>(null)
  const invalidateRef = useRef<(() => void) | null>(null)
  const captureRef = useRef<StageCapture | null>(null)

  const look = (v: ObjectView) => {
    const vp = viewpoint(v)
    flyToRef.current = {
      target: new THREE.Vector3(...vp.target),
      position: new THREE.Vector3(...vp.position),
    }
    // A DOM button and a demand frameloop: kick the frame the rig needs.
    invalidateRef.current?.()
  }
  const picked =
    selection?.kind === "device" || selection?.kind === "port"
      ? (rack.devices.find((d) => d.id === selection.deviceId) ?? null)
      : null

  return (
    <div>
      {toolbar(
        <>
          <div className="flex items-center gap-1">
            <BarButton onClick={() => look("front")}>Front</BarButton>
            <BarButton onClick={() => look("rear")}>Rear</BarButton>
          </div>
          <CameraModeToggle />
          <ModeMenu
            label="Pluggables"
            value={pluggables}
            modes={PLUGGABLES_MODES}
            labels={PLUGGABLES_LABEL}
            onChange={(v) => setPluggablesMode(readPluggablesMode(v))}
          />
          <ModeMenu
            label="Stacks"
            value={stacksMode}
            modes={STACKS_MODES}
            labels={STACKS_LABEL}
            onChange={(v) => setStacksMode(readStacksMode(v))}
          />
          {stacksMode !== "hide" && <StackCablesMenu store={stackLinks} />}
          <BarToggle pressed={blanks} onClick={() => setBlanksShown(!blanks)}>
            Blanks
          </BarToggle>
          <BarButton
            className="ml-auto"
            onClick={() =>
              downloadStagePng(captureRef.current, `${rack.name}-3d.png`)
            }
          >
            <Camera /> PNG
          </BarButton>
        </>
      )}
      <div
        data-part="scene"
        className="relative h-[40rem] max-h-[80vh] w-full"
        onPointerDown={card.onPointerDown}
      >
        <Stage
          quality={quality}
          camera={{ position: start.position, far: dist * 10 + 20 }}
          lights={objectLights(size)}
          controls={{
            target: start.target,
            maxDistance: dist * 2,
            requestRef: flyToRef,
            keyboard: false,
          }}
          stamp={`${selection?.deviceId ?? ""}|${selection?.portName ?? ""}`}
          invalidateRef={invalidateRef}
          captureRef={captureRef}
          onPointerMissed={() => setSelection(null)}
        >
          <RackMesh
            plan={SOLO_PLAN}
            leds={leds}
            budget={budget}
            tile={tile}
            selection={selection}
            showUNumbers
            showNames={false}
            shellMode="cutaway"
            engaged
            markReserved
            portLabelSource={portLabelsShown ? faceplatePortLabels : ""}
            portLabelColor={faceplatePortLabelColor}
            // The rack itself is the page: a click on its frame picks
            // nothing, and lets go of what was picked.
            onSelect={(sel) => setSelection(sel.kind === "rack" ? null : sel)}
            onFlyTo={(target, position) => {
              flyToRef.current = { target, position }
              // Only a ref changed: kick the frame the rig reads it in.
              invalidateRef.current?.()
            }}
            onLegend={onLegend}
            onDeviceMenu={(dev, target, at) => {
              setPartMenu(null)
              void deviceMenus.open(dev, target, at)
            }}
            onPortMenu={
              canSetStatus
                ? (sel, at) =>
                    sel.deviceId &&
                    sel.portName &&
                    setPartMenu({
                      ...at,
                      deviceId: sel.deviceId,
                      marker: sel.portName,
                      side: sel.portSide === "model" ? undefined : sel.portSide,
                    })
                : undefined
            }
          />
          <StackCables stacks={stacks} mode={stacksMode} />
          <ShadowFloor size={size * 3} />
        </Stage>
        {picked && selection?.kind === "device" && (
          <DeviceHud
            tile={tile}
            dev={picked}
            stack={stackOf(leds, picked.id)}
            className={CARD_PLACE[card.place]}
          />
        )}
        {picked && selection?.kind === "port" && (
          <PortHud
            device={picked}
            position={rackPortPosition(tile, picked)}
            selection={selection}
            showReserved
            className={CARD_PLACE[card.place]}
          />
        )}
        <StackCableCard store={stackLinks} />
        <PartMarkerMenu menu={partMenu} onClose={() => setPartMenu(null)} />
        {deviceMenus.menus}
      </div>
      {/* The room's key, to what the faces actually draw - under the view,
          as the 2D plate keeps its own, so it never sits under a card. */}
      {!legendIsEmpty(legend) && (
        <FaceplateLegend className="mt-3" observed content={legend} />
      )}
    </div>
  )
}

/** A Show / Ghost / Hide choice on the toolbar, muted at its default. */
function ModeMenu<TMode extends string>({
  label,
  value,
  modes,
  labels,
  onChange,
}: {
  label: string
  value: TMode
  modes: readonly TMode[]
  labels: Record<TMode, string>
  onChange: (v: string) => void
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <BarMenuTrigger
          className={cn(value === modes[0] && "text-muted-foreground")}
        >
          {label}
        </BarMenuTrigger>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-32">
        <DropdownMenuRadioGroup value={value} onValueChange={onChange}>
          {modes.map((m) => (
            <DropdownMenuRadioItem key={m} value={m}>
              {labels[m]}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
