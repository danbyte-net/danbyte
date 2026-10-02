import { useCallback, useMemo, useRef, useState } from "react"
import type { ReactNode } from "react"
import { Camera, DoorClosed, DoorOpen } from "lucide-react"
import * as THREE from "three"

import type { Cabinet } from "@/lib/api"
import { BarButton } from "@/components/map-toolbar"
import {
  CabinetDeviceHoverHud,
  CabinetDeviceHud,
  createHoverStore,
  deviceHoverKey,
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

/**
 * A cabinet on its own in 3D - the Plate's 3D view on the cabinet page.
 * The room's cabinet, door open to start with: the plate, its rails and the
 * devices on them at their true size, their front photos on their faces.
 * Drag turns it, the wheel zooms; Front and Rear look straight at either
 * side, and a double-click on it is Front. Hover a device for its card,
 * click it to keep the card with the way to its page. PNG saves the view.
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
  const [picked, setPicked] = useState<string | null>(null)
  const card = useCardPlace()
  const [hover] = useState(createHoverStore)
  const hoverDevice = useCallback(
    (tileId: string, deviceId: string, on: boolean) =>
      hover.set(deviceHoverKey(tileId, deviceId), on),
    [hover]
  )
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
              stamp={`${doorOpen}|${picked}`}
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
                selectedDeviceId={picked}
                onSelect={() => setPicked(null)}
                onFlyTo={() => look("front")}
                onSelectDevice={(_, deviceId) => setPicked(deviceId)}
                onHoverDevice={hoverDevice}
              />
              <ShadowFloor size={size * 6} />
            </Stage>
            <CabinetDeviceHoverHud
              store={hover}
              cabinetOf={() => named}
              hidden={!!picked}
            />
            {picked && (
              <CabinetDeviceHud
                cabinet={named}
                deviceId={picked}
                pinned
                className={CARD_PLACE[card.place]}
              />
            )}
          </>
        ) : (
          <NoWebGL />
        )}
      </div>
    </div>
  )
}
