import { useCallback, useMemo, useRef, useState } from "react"
import type { ReactNode } from "react"
import { Camera, DoorClosed, DoorOpen } from "lucide-react"
import * as THREE from "three"

import type { Cabinet, ImagePortMarker } from "@/lib/api"
import { legendIsEmpty } from "@/lib/faceplate-colors"
import { usePortLabelsShown } from "@/lib/port-labels-pref"
import { useMe } from "@/lib/use-me"
import { FaceplateLegend } from "@/components/device-faceplate"
import { BarButton } from "@/components/map-toolbar"
import { useLegendCollector } from "@/components/speed-scale"
import { PartMarkerMenu, useCanSetPartStatus } from "@/components/part-status"
import type { PartMarkerAt } from "@/components/part-status"
import {
  CabinetDeviceHoverHud,
  CabinetDeviceHud,
  CabinetPortHoverHud,
  CabinetPortHud,
  createHoverStore,
  deviceHoverKey,
  portHoverKey,
} from "@/components/floorplan3d/cabinet-hud"
import { CabinetMesh } from "@/components/floorplan3d/cabinet-mesh"
import { CARD_PLACE, useCardPlace } from "@/components/floorplan3d/hud-cards"
import type { FlyToRequest } from "@/components/floorplan3d/camera-rig"
import {
  OBJECT_VIEWS,
  SOLO_PLAN,
  fitDistance,
  objectViewpoint,
  sceneCabinetOf,
  soloTile,
} from "@/components/floorplan3d/object-view"
import type { ObjectView } from "@/components/floorplan3d/object-view"
import {
  NoWebGL,
  ShadowFloor,
  Stage,
  downloadStagePng,
  objectLights,
  storedRenderQuality,
} from "@/components/floorplan3d/stage"
import type { StageCapture } from "@/components/floorplan3d/stage"
import { cabinetBoxM, webglSupported } from "@/components/floorplan3d/world"

/** What was clicked inside: a device, or a port on its photo. */
type Picked = {
  deviceId: string
  port?: { marker: string; kind: string }
} | null

/**
 * A cabinet on its own in 3D - the Plate's 3D view on the cabinet page.
 * The room's cabinet, door open to start with: the plate, its rails and the
 * devices on them at their true size, their front photos on their faces and
 * the ports marked on the photos coloured by their state, as in the room.
 * Drag turns it, the wheel zooms; Front and Rear look straight at either
 * side, and a double-click on it is Front. Hover a device or a port for its
 * card, click it to keep the card with the way to its page. The key to the
 * ports' colours sits under the view. PNG saves the view.
 *
 * Lazy: the 3D stack stays in its own chunk, loaded when 3D is picked.
 * `lead` is the 2D | 3D switch, first on the toolbar as on the 2D plate's.
 */
export default function CabinetScene({
  cabinet,
  lead,
}: {
  cabinet: Cabinet
  lead?: ReactNode
}) {
  const supported = useMemo(webglSupported, [])
  const quality = useMemo(storedRenderQuality, [])
  const solo = useMemo(() => sceneCabinetOf(cabinet), [cabinet])
  const tile = useMemo(
    () => soloTile(cabinet.id, { cabinet: solo }),
    [cabinet.id, solo]
  )
  const box = cabinetBoxM(solo)
  const size = Math.max(box.width, box.height, box.depth)
  // Framed for the door standing open: it swings out on the left and
  // toward you, nearer the eye than the box, so stand back about twice
  // the width and look between the box and its door. The panel is never
  // narrower than 4:3, the aspect the distance is fitted to.
  const dist = fitDistance({ ...box, width: box.width * 2.1 })
  const viewpoint = (v: ObjectView, open: boolean) =>
    objectViewpoint(
      box.height,
      dist,
      OBJECT_VIEWS[v].yaw,
      OBJECT_VIEWS[v].pitch,
      open ? [box.width * 0.2, -box.width * 0.2] : [0, 0]
    )
  const start = viewpoint("angle", true)

  const [doorOpen, setDoorOpen] = useState(true)
  const [picked, setPicked] = useState<Picked>(null)
  // A right-click on a part: its statuses at the pointer.
  const canSetStatus = useCanSetPartStatus()
  const [partMenu, setPartMenu] = useState<PartMarkerAt | null>(null)
  const card = useCardPlace()
  const [hover] = useState(createHoverStore)
  const hoverDevice = useCallback(
    (tileId: string, deviceId: string, on: boolean) =>
      hover.set(deviceHoverKey(tileId, deviceId), on),
    [hover]
  )
  const [portHover] = useState(createHoverStore)
  const hoverPort = useCallback(
    (tileId: string, deviceId: string, marker: ImagePortMarker, on: boolean) =>
      portHover.set(
        portHoverKey({
          tileId,
          deviceId,
          marker: marker.name,
          kind: marker.kind,
        }),
        on
      ),
    [portHover]
  )
  // The ports' key, and their labels as the deployment prints them.
  const { content: legend, report: onLegend } = useLegendCollector()
  const { faceplatePortLabels, faceplatePortLabelColor } = useMe()
  const portLabelsShown = usePortLabelsShown()
  const flyToRef = useRef<FlyToRequest | null>(null)
  const invalidateRef = useRef<(() => void) | null>(null)
  const captureRef = useRef<StageCapture | null>(null)

  const look = (v: ObjectView) => {
    const vp = viewpoint(v, doorOpen)
    flyToRef.current = {
      target: new THREE.Vector3(...vp.target),
      position: new THREE.Vector3(...vp.position),
    }
    // A DOM button and a demand frameloop: kick the frame the rig needs.
    invalidateRef.current?.()
  }
  const named = { id: cabinet.id, name: cabinet.name }

  return (
    <div>
      <div
        data-part="plate-toolbar"
        className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2"
      >
        {lead}
        {supported && (
          <>
            <BarButton
              onClick={() => {
                // A shut door hides what was picked inside: let go of it.
                if (doorOpen) setPicked(null)
                setDoorOpen(!doorOpen)
              }}
            >
              {doorOpen ? <DoorClosed /> : <DoorOpen />}
              {doorOpen ? "Close door" : "Open door"}
            </BarButton>
            <div className="flex items-center gap-1">
              <BarButton onClick={() => look("front")}>Front</BarButton>
              <BarButton onClick={() => look("rear")}>Rear</BarButton>
            </div>
            <BarButton
              className="ml-auto"
              onClick={() =>
                downloadStagePng(captureRef.current, `${cabinet.name}-3d.png`)
              }
            >
              <Camera /> PNG
            </BarButton>
          </>
        )}
      </div>
      <div
        data-part="scene"
        className="relative aspect-[4/3] max-h-[28rem] w-full"
        onPointerDown={card.onPointerDown}
      >
        {supported ? (
          <>
            <Stage
              quality={quality}
              camera={{ position: start.position, far: dist * 10 + 10 }}
              lights={objectLights(size)}
              controls={{
                target: start.target,
                maxDistance: dist * 3,
                minDistance: 0.12,
                roomDiag: size,
                requestRef: flyToRef,
                keyboard: false,
                dollyThrough: false,
              }}
              stamp={`${doorOpen}|${picked?.deviceId}|${picked?.port?.marker}`}
              invalidateRef={invalidateRef}
              captureRef={captureRef}
              onPointerMissed={() => setPicked(null)}
            >
              <CabinetMesh
                plan={SOLO_PLAN}
                tile={tile}
                selected={false}
                nameplate={false}
                doorOpen={doorOpen}
                selectedDeviceId={picked?.deviceId ?? null}
                selectedPort={
                  picked?.port
                    ? { deviceId: picked.deviceId, marker: picked.port.marker }
                    : null
                }
                markReserved
                portLabelSource={portLabelsShown ? faceplatePortLabels : ""}
                portLabelColor={faceplatePortLabelColor}
                onSelect={() => setPicked(null)}
                onFlyTo={() => look("front")}
                onSelectDevice={(_, deviceId) => setPicked({ deviceId })}
                onHoverDevice={hoverDevice}
                onSelectPort={(_, deviceId, marker) =>
                  setPicked({
                    deviceId,
                    port: { marker: marker.name, kind: marker.kind },
                  })
                }
                onHoverPort={hoverPort}
                onLegend={onLegend}
                onPortMenu={
                  canSetStatus
                    ? (_, deviceId, marker, at) =>
                        setPartMenu({
                          ...at,
                          deviceId,
                          marker: marker.name,
                          side: "front",
                        })
                    : undefined
                }
              />
              <ShadowFloor size={size * 6} />
            </Stage>
            <CabinetDeviceHoverHud
              store={hover}
              cabinetOf={() => named}
              hidden={!!picked}
            />
            <CabinetPortHoverHud
              store={portHover}
              cabinetOf={() => named}
              hidden={!!picked}
              showReserved
            />
            {picked &&
              (picked.port ? (
                <CabinetPortHud
                  cabinet={named}
                  port={{
                    tileId: cabinet.id,
                    deviceId: picked.deviceId,
                    marker: picked.port.marker,
                    kind: picked.port.kind,
                  }}
                  showReserved
                  className={CARD_PLACE[card.place]}
                />
              ) : (
                <CabinetDeviceHud
                  cabinet={named}
                  deviceId={picked.deviceId}
                  pinned
                  className={CARD_PLACE[card.place]}
                />
              ))}
            <PartMarkerMenu menu={partMenu} onClose={() => setPartMenu(null)} />
          </>
        ) : (
          <NoWebGL />
        )}
      </div>
      {/* The key to what the ports draw - under the view, as the rack's
          3D view and the 2D plate keep theirs. */}
      {supported && doorOpen && !legendIsEmpty(legend) && (
        <FaceplateLegend
          className="mt-3"
          // SNMP's red only where a port it says is down is drawn.
          observed={legend.states.has("down")}
          content={legend}
        />
      )}
    </div>
  )
}
