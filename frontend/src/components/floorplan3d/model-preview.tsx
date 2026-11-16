import { useEffect, useLayoutEffect, useMemo } from "react"
import { Canvas, useThree } from "@react-three/fiber"
import { OrbitControls } from "@react-three/drei"
import * as THREE from "three"

import { Loading } from "@/components/loading"
import type { Model3DFront, Model3DUp } from "@/lib/api"
import type { V3 } from "@/lib/model-ports"

import { useDeviceModel } from "./device-model"
import {
  STUDIO_LIGHTS,
  makeTopLight,
  placeTopLight,
  studioEnvironment,
} from "./studio"
import { modelRotation } from "./world"

/**
 * A small turntable of one model: a stored one by URL (the 3D model card)
 * or one being converted (the upload dialog). Turned as the room turns it,
 * so its front faces the camera - what the room's tile front will see.
 */

/** The studio's light for a viewer canvas (STUDIO_LIGHTS): the procedural
 * studio environment at `intensity`, and the studio's tone mapping and
 * exposure, put back on unmount. No files, airgap- and CSP-safe. */
export function Studio({
  intensity = STUDIO_LIGHTS.environment,
}: {
  intensity?: number
}) {
  const gl = useThree((s) => s.gl)
  const scene = useThree((s) => s.scene)
  const invalidate = useThree((s) => s.invalidate)
  useEffect(() => {
    const env = studioEnvironment(gl)
    const tone = gl.toneMapping
    const exposure = gl.toneMappingExposure
    gl.toneMapping = STUDIO_LIGHTS.toneMapping
    gl.toneMappingExposure = STUDIO_LIGHTS.exposure
    scene.environment = env.texture
    scene.environmentIntensity = intensity
    invalidate()
    return () => {
      gl.toneMapping = tone
      gl.toneMappingExposure = exposure
      scene.environment = null
      scene.environmentIntensity = 1
      env.dispose()
    }
  }, [gl, scene, intensity, invalidate])
  return null
}

/** Where the key's shadow camera stands for a model whose bounding sphere
 * is `radius` around `center`: along the key's direction, its frustum
 * fitted tight to the sphere so the map's texels all land on the model.
 * The biases scale with it - enough that a 1U lid doesn't shadow itself
 * (acne), little enough that an ear still shades the bezel behind it. */
export function keyShadowFor(
  center: V3,
  radius: number
): {
  position: V3
  half: number
  near: number
  far: number
  bias: number
  normalBias: number
} {
  const r = Math.max(radius, 1e-3)
  const dir = new THREE.Vector3(...STUDIO_LIGHTS.key.position).normalize()
  const p = new THREE.Vector3(...center).addScaledVector(dir, r * 4)
  return {
    position: [p.x, p.y, p.z],
    half: r * 1.05,
    near: r * 2.5,
    far: r * 5.5,
    bias: -0.0004,
    normalBias: r * 0.0025,
  }
}

/** The studio's lights (STUDIO_LIGHTS): a low ambient, the key from the
 * front right and a dim fill. With `shadow` (the model's bounding sphere)
 * the key casts soft shadows - the model onto itself, modules onto the
 * chassis, ears onto the bezel - and the top softbox stands over the
 * model's back. */
export function StudioLights({
  shadow,
}: {
  shadow?: { center: V3; radius: number } | null
}) {
  const invalidate = useThree((s) => s.invalidate)
  const key = useMemo(() => {
    const l = new THREE.DirectionalLight(0xffffff, STUDIO_LIGHTS.key.intensity)
    l.shadow.mapSize.set(2048, 2048)
    // PCF's soft taps, in shadow-map texels.
    l.shadow.radius = 3
    return l
  }, [])
  useEffect(() => () => key.dispose(), [key])
  const cx = shadow?.center[0] ?? 0
  const cy = shadow?.center[1] ?? 0
  const cz = shadow?.center[2] ?? 0
  const radius = shadow?.radius ?? null
  useLayoutEffect(() => {
    if (radius === null) {
      key.castShadow = false
      key.position.set(...STUDIO_LIGHTS.key.position)
      key.target.position.set(0, 0, 0)
    } else {
      const fit = keyShadowFor([cx, cy, cz], radius)
      key.castShadow = true
      key.position.set(...fit.position)
      key.target.position.set(cx, cy, cz)
      Object.assign(key.shadow.camera, {
        left: -fit.half,
        right: fit.half,
        top: fit.half,
        bottom: -fit.half,
        near: fit.near,
        far: fit.far,
      })
      key.shadow.camera.updateProjectionMatrix()
      key.shadow.bias = fit.bias
      key.shadow.normalBias = fit.normalBias
    }
    invalidate()
  }, [key, cx, cy, cz, radius, invalidate])
  const top = useMemo(() => makeTopLight(), [])
  useEffect(() => () => top.dispose(), [top])
  useLayoutEffect(() => {
    if (radius !== null) placeTopLight(top, [cx, cy, cz], radius)
    invalidate()
  }, [top, cx, cy, cz, radius, invalidate])
  return (
    <>
      <ambientLight intensity={STUDIO_LIGHTS.ambient} />
      <primitive object={key} />
      <primitive object={key.target} />
      {radius !== null && (
        <>
          <primitive object={top} />
          <primitive object={top.target} />
        </>
      )}
      <directionalLight
        position={STUDIO_LIGHTS.fill.position}
        intensity={STUDIO_LIGHTS.fill.intensity}
      />
    </>
  )
}

/** The object, turned upright, centred, and the camera backed off to frame
 * it from the front and a little above. */
function Framed({
  object,
  up,
  front,
}: {
  object: THREE.Object3D
  up: Model3DUp
  front: Model3DFront
}) {
  const camera = useThree((s) => s.camera)
  const invalidate = useThree((s) => s.invalidate)
  const { rotation, offset, radius } = useMemo(() => {
    const [rx, ry, rz] = modelRotation(up, front)
    const turn = new THREE.Euler(rx, ry, rz, "YXZ")
    object.updateMatrixWorld(true)
    const box = new THREE.Box3()
      .setFromObject(object)
      .applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(turn))
    const c = box.getCenter(new THREE.Vector3())
    const size = box.getSize(new THREE.Vector3())
    return {
      rotation: turn,
      offset: [-c.x, -c.y, -c.z] as [number, number, number],
      radius: Math.max(size.length() / 2, 1e-3),
    }
  }, [object, up, front])
  useEffect(() => {
    // The room's front is −Z: look at it from there.
    const d = radius * 2.6
    camera.position.set(d * 0.45, d * 0.35, -d * 0.85)
    camera.near = radius / 100
    camera.far = radius * 100
    camera.lookAt(0, 0, 0)
    camera.updateProjectionMatrix()
    invalidate()
  }, [camera, radius, invalidate])
  return (
    <group position={offset}>
      <group rotation={rotation}>
        <primitive object={object} />
      </group>
    </group>
  )
}

function FromUrl({
  url,
  up,
  front,
}: {
  url: string
  up: Model3DUp
  front: Model3DFront
}) {
  const entry = useDeviceModel(url)
  const object = useMemo(
    () => (entry?.scene ? entry.scene.clone(true) : null),
    [entry?.scene]
  )
  if (!object) return null
  return <Framed object={object} up={up} front={front} />
}

export default function ModelPreview({
  url,
  object,
  up = "y",
  front = "+z",
  className = "h-48",
}: {
  url?: string
  object?: THREE.Object3D
  up?: Model3DUp
  front?: Model3DFront
  className?: string
}) {
  return (
    <div
      className={`relative w-full overflow-hidden rounded-md border border-border bg-muted/30 ${className}`}
    >
      <Canvas
        frameloop="demand"
        dpr={[1, 2]}
        camera={{ fov: 35, position: [1, 1, -2] }}
        gl={{ antialias: true }}
        fallback={<Loading />}
      >
        <Studio />
        <StudioLights />
        {object ? (
          <Framed object={object} up={up} front={front} />
        ) : url ? (
          <FromUrl url={url} up={up} front={front} />
        ) : null}
        <OrbitControls makeDefault enableDamping={false} />
      </Canvas>
    </div>
  )
}
