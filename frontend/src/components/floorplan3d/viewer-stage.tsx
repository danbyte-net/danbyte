import { useEffect, useMemo } from "react"
import type { ReactNode } from "react"
import { useThree } from "@react-three/fiber"
import {
  ContactShadows,
  OrthographicCamera,
  PerspectiveCamera,
} from "@react-three/drei"
import * as THREE from "three"

import { faceCamera, faceZoom } from "@/lib/face-camera"
import type { V3 } from "@/lib/model-ports"

import { StudioLights } from "./model-preview"
import { STUDIO_LIGHTS } from "./studio"
import { AO_INTENSITY, ViewerAo, aoRadiusFor, viewerLook } from "./viewer-look"

/**
 * The model viewer's stage (model-viewer): the studio's key and fill with
 * a shadow camera fitted to what it shows, the screen-space AO on a
 * capable GPU, the three-quarter view's contact shadow and the camera for
 * the preset - for one model, or a stack of them (stack-viewer), standing
 * on the origin in a box of upright size `size`, front on −Z.
 */

export type ViewPreset = "front" | "rear" | "top" | "iso"

/** The orthographic presets: a face, straight on. */
export const isFaceView = (p: ViewPreset): p is "front" | "rear" | "top" =>
  p !== "iso"

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

/** `size` held by value: a new array with the same numbers (a payload refresh
 * rebuilding the stack's box every few seconds) keeps the previous one, so
 * the camera only re-frames when the model really changes size - never
 * snapping back while someone is turning it. */
export function useStableSize(size: V3): V3 {
  const key = size.map((v) => v.toFixed(6)).join(",")
  // `key` stands for `size`'s values.
  return useMemo(() => size, [key])
}

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

/** The lights, AO, contact shadow and camera around `children`, fitted to
 * `size`. `baked`: a model brings its own occlusion, so the screen's is
 * lighter. `shadowKey` re-draws the contact shadow (one frame's depth
 * pass per key, not one per frame). */
export function ViewerStage({
  size: givenSize,
  baked,
  view,
  shadowKey,
  children,
}: {
  size: V3
  baked: boolean
  view: { preset: ViewPreset; n: number }
  shadowKey: string
  children: ReactNode
}) {
  const size = useStableSize(givenSize)
  const shadow = useMemo(() => contactShadowFor(size), [size])
  // The key's shadow and the AO, fitted to the upright box.
  const keyShadow = useMemo(
    () => ({
      center: [0, size[1] / 2, 0] as V3,
      radius: Math.max(Math.hypot(...size) / 2, 1e-3),
    }),
    [size]
  )
  const clip = useMemo(
    () =>
      new THREE.Box3(
        new THREE.Vector3(-size[0] / 2, 0, -size[2] / 2),
        new THREE.Vector3(size[0] / 2, size[1], size[2] / 2)
      ),
    [size]
  )
  const gl = useThree((s) => s.gl)
  const look = useMemo(() => viewerLook(gl), [gl])
  return (
    <>
      <StudioLights shadow={keyShadow} />
      {look === "full" && (
        <ViewerAo
          radius={aoRadiusFor(size)}
          intensity={baked ? AO_INTENSITY.withBaked : AO_INTENSITY.screen}
          clip={clip}
        />
      )}
      {children}
      {!isFaceView(view.preset) && (
        <ContactShadows
          key={shadowKey}
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
