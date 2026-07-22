import { useRef } from "react"
import { useFrame, useThree } from "@react-three/fiber"
import { OrbitControls } from "@react-three/drei"
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib"
import * as THREE from "three"

export interface FlyToRequest {
  target: THREE.Vector3
  position: THREE.Vector3
}

/**
 * OrbitControls plus an animated fly-to: push a request into `requestRef` and
 * the rig eases the camera + orbit target there over ~0.7 s. Works with
 * `frameloop="demand"` — the rig invalidates every animation frame itself.
 */
export function CameraRig({
  target,
  maxDistance,
  requestRef,
}: {
  target: [number, number, number]
  maxDistance: number
  requestRef: React.MutableRefObject<FlyToRequest | null>
}) {
  const controls = useRef<OrbitControlsImpl>(null)
  const invalidate = useThree((s) => s.invalidate)
  const anim = useRef<{
    fromPos: THREE.Vector3
    fromTarget: THREE.Vector3
    to: FlyToRequest
    t: number
  } | null>(null)

  useFrame((state, delta) => {
    const c = controls.current
    if (!c) return
    // Pick up a new request.
    if (requestRef.current) {
      anim.current = {
        fromPos: state.camera.position.clone(),
        fromTarget: c.target.clone(),
        to: requestRef.current,
        t: 0,
      }
      requestRef.current = null
    }
    const a = anim.current
    if (!a) return
    a.t = Math.min(1, a.t + delta / 0.7)
    // easeInOutCubic
    const k = a.t < 0.5 ? 4 * a.t ** 3 : 1 - (-2 * a.t + 2) ** 3 / 2
    state.camera.position.lerpVectors(a.fromPos, a.to.position, k)
    c.target.lerpVectors(a.fromTarget, a.to.target, k)
    c.update()
    if (a.t >= 1) anim.current = null
    else invalidate()
  })

  return (
    <OrbitControls
      ref={controls}
      makeDefault
      target={target}
      maxPolarAngle={Math.PI / 2 - 0.02}
      minDistance={0.5}
      maxDistance={maxDistance}
    />
  )
}
