import { useEffect, useMemo } from "react"
import { Canvas, useThree } from "@react-three/fiber"
import { Html, OrbitControls } from "@react-three/drei"
import * as THREE from "three"

import { Loading } from "@/components/loading"
import type { Model3DEffective } from "@/lib/api"
import { PORT_MARKER_M } from "@/lib/model-ports"
import type { ModelPortsDoc, V3 } from "@/lib/model-ports"

import { PlacedModel, fittedModel, useDeviceModel } from "./device-model"
import type { ModelEntry } from "./device-model"
import {
  ModelPortMarkers,
  TemplatePortMarkers,
} from "./device-model-port-markers"
import type { MappedPortPick } from "./device-model-port-markers"
import { Studio } from "./model-preview"
import { modelTargetM } from "./world"

/**
 * An interactive view of one device or device type model: the Overview's
 * "3D model" card and the floor plan panel's preview. One Canvas, drawn on
 * demand; the model comes from the room's shared cache (one download and
 * parse per URL, freed a while after its last user), stood up and fitted
 * exactly as the room stands it, so mapped ports land where they do there.
 *
 * A device's markers are the room's - coloured by port state from the
 * batched face-ports request; a type's are its mapping in one neutral
 * colour. Loaded lazily (three.js stays in its own chunk).
 */

export type ViewPreset = "front" | "rear" | "top" | "fit"

export interface ModelViewerProps {
  model: Pick<Model3DEffective, "url" | "fit" | "up" | "front">
  /** The type's body size (mm), what the model is fitted to. */
  sizeMm?: {
    width_mm?: number | null
    height_mm?: number | null
    depth_mm?: number | null
  } | null
  /** A device: its markers coloured by port state. */
  deviceId?: string | null
  /** A type: its mapping, drawn neutral. */
  templatePorts?: ModelPortsDoc | null
  markers?: boolean
  /** The camera preset; `n` replays the same one. */
  view?: { preset: ViewPreset; n: number }
  onPort?: (pick: MappedPortPick) => void
  className?: string
}

/** Where the camera stands for a preset, around a model of upright size
 * `size` standing on the origin, front on −Z. */
export function presetCamera(
  preset: ViewPreset,
  size: V3
): { position: V3; target: V3 } {
  const cy = size[1] / 2
  const radius = Math.max(Math.hypot(size[0], size[1], size[2]) / 2, 1e-3)
  const d = radius * 2.6
  const target: V3 = [0, cy, 0]
  switch (preset) {
    case "front":
      return { position: [0, cy, -d], target }
    case "rear":
      return { position: [0, cy, d], target }
    case "top":
      // A hair toward the front, so "up" on screen is the model's back.
      return { position: [0, cy + d, -d * 0.001], target }
    default:
      return { position: [d * 0.45, cy + d * 0.35, -d * 0.85], target }
  }
}

/** A marker's edge (m) for a model of size `size`: the room's 8 mm, more
 * on a large model so they stay findable. */
export function viewerMarkerM(size: V3): number {
  return Math.max(PORT_MARKER_M, Math.max(...size) / 90)
}

function Rig({
  size,
  view,
}: {
  size: V3
  view: { preset: ViewPreset; n: number }
}) {
  const camera = useThree((s) => s.camera)
  const controls = useThree((s) => s.controls) as unknown as {
    target: THREE.Vector3
    update: () => void
  } | null
  const invalidate = useThree((s) => s.invalidate)
  useEffect(() => {
    const { position, target } = presetCamera(view.preset, size)
    const radius = Math.max(Math.hypot(...size) / 2, 1e-3)
    camera.position.set(...position)
    camera.near = radius / 100
    camera.far = radius * 100
    camera.updateProjectionMatrix()
    if (controls) {
      controls.target.set(...target)
      controls.update()
    } else {
      camera.lookAt(...target)
    }
    invalidate()
  }, [camera, controls, invalidate, size, view.preset, view.n])
  return null
}

function Fitted({
  entry,
  props,
}: {
  entry: ModelEntry
  props: ModelViewerProps
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
  const markerM = viewerMarkerM(size)
  const view = props.view ?? { preset: "fit" as const, n: 0 }
  return (
    <>
      <PlacedModel entry={entry} fit={fit} />
      {props.markers !== false &&
        (props.deviceId ? (
          <ModelPortMarkers
            deviceId={props.deviceId}
            size={size}
            selectedPort={null}
            markerM={markerM}
            onSelect={(pk) => props.onPort?.(pk)}
          />
        ) : props.templatePorts?.ports.length ? (
          <TemplatePortMarkers
            ports={props.templatePorts.ports}
            size={size}
            markerM={markerM}
          />
        ) : null)}
      <Rig size={size} view={view} />
    </>
  )
}

function Model(props: ModelViewerProps) {
  const entry = useDeviceModel(props.model.url)
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
  return <Fitted entry={entry} props={props} />
}

export default function ModelViewer(props: ModelViewerProps) {
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
      >
        <Studio />
        <ambientLight intensity={0.4} />
        <directionalLight position={[2, 4, -3]} intensity={1.2} />
        <Model {...props} />
        <OrbitControls makeDefault enableDamping={false} />
      </Canvas>
    </div>
  )
}
