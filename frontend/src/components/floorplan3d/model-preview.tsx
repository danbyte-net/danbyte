import { useEffect, useMemo } from "react"
import { Canvas, useThree } from "@react-three/fiber"
import { OrbitControls } from "@react-three/drei"
import * as THREE from "three"

import { Loading } from "@/components/loading"
import type { Model3DFront, Model3DUp } from "@/lib/api"

import { useDeviceModel } from "./device-model"
import { STUDIO_LIGHTS, studioEnvironment } from "./studio"
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

/** The studio's lights (STUDIO_LIGHTS): a low ambient, the key from the
 * front right and a dim fill. */
export function StudioLights() {
  return (
    <>
      <ambientLight intensity={STUDIO_LIGHTS.ambient} />
      <directionalLight
        position={STUDIO_LIGHTS.key.position}
        intensity={STUDIO_LIGHTS.key.intensity}
      />
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
