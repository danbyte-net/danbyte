import { useEffect, useMemo } from "react"
import { Canvas, useThree } from "@react-three/fiber"
import { OrbitControls } from "@react-three/drei"
import * as THREE from "three"
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js"

import { Loading } from "@/components/loading"
import type { Model3DFront, Model3DUp } from "@/lib/api"

import { useDeviceModel } from "./device-model"
import { modelRotation } from "./world"

/**
 * A small turntable of one model: a stored one by URL (the 3D model card)
 * or one being converted (the upload dialog). Turned as the room turns it,
 * so its front faces the camera - what the room's tile front will see.
 */

/** Studio light from three's procedural room: no files, airgap-safe. */
export function Studio() {
  const gl = useThree((s) => s.gl)
  const scene = useThree((s) => s.scene)
  useEffect(() => {
    const pmrem = new THREE.PMREMGenerator(gl)
    const rt = pmrem.fromScene(new RoomEnvironment(), 0.04)
    scene.environment = rt.texture
    return () => {
      scene.environment = null
      rt.dispose()
      pmrem.dispose()
    }
  }, [gl, scene])
  return null
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
        <ambientLight intensity={0.4} />
        <directionalLight position={[2, 4, -3]} intensity={1.2} />
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
