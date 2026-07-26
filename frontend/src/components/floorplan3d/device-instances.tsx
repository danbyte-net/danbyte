import { useLayoutEffect, useMemo, useRef } from "react"
import { useThree } from "@react-three/fiber"
import * as THREE from "three"

import { DEVICE_FALLBACK } from "./device-mesh"
import { deviceBoxM } from "./world"
import type { SceneRack } from "./world"

/** One unit cube scaled per instance — this layer exists to stop allocating
 * geometry per device, so it must not allocate any of its own either. */
const UNIT_BOX = new THREE.BoxGeometry(1, 1, 1)

// Scratch, reused across every instance write (all synchronous).
const _m = new THREE.Matrix4()
const _c = new THREE.Color()

/**
 * Every racked device in one cabinet as a SINGLE draw call.
 *
 * The detail tier gives each device its own meshes — body, edge outline, photo
 * plane, port quads — which is right nose-on and ruinous across a hall: a
 * hundred full cabinets is ~2400 devices, and at five-ish meshes each that is
 * five figures of draw calls per frame. Sharing the geometry (which the detail
 * tier now does) cut the memory, not the draw calls; only instancing does.
 *
 * So the middle distance keeps the room looking full and gives up exactly what
 * you cannot resolve from across the room anyway: no photo face, no outline,
 * no port markers, and no picking — a click falls through to the cabinet,
 * which is what you meant at that range.
 */
export function DeviceInstances({
  rack,
  devices,
  rackWidthM,
  rackDepthM,
}: {
  rack: SceneRack
  devices: SceneRack["devices"]
  rackWidthM: number
  rackDepthM: number
}) {
  const ref = useRef<THREE.InstancedMesh>(null)
  const invalidate = useThree((s) => s.invalidate)

  const boxes = useMemo(
    () => devices.map((d) => deviceBoxM(rack, d, rackWidthM, rackDepthM)),
    [devices, rack, rackWidthM, rackDepthM]
  )

  useLayoutEffect(() => {
    const im = ref.current
    if (!im) return
    boxes.forEach((b, i) => {
      // makeScale then setPosition: setPosition only writes the translation
      // column, so the scale survives.
      _m.makeScale(b.dw, b.boxH, b.dd).setPosition(b.dx, b.y + b.h / 2, b.dz)
      im.setMatrixAt(i, _m)
      im.setColorAt(i, _c.set(devices[i].role_color || DEVICE_FALLBACK))
    })
    im.instanceMatrix.needsUpdate = true
    if (im.instanceColor) im.instanceColor.needsUpdate = true
    // Demand frameloop: the buffers changed outside a render request.
    invalidate()
  }, [boxes, devices, invalidate])

  if (devices.length === 0) return null

  return (
    <instancedMesh
      ref={ref}
      // r3f keys instancedMesh on args, so a rack gaining a device rebuilds
      // the buffers rather than silently drawing a stale count.
      args={[UNIT_BOX, undefined, devices.length]}
      // No raycasting: picking is the cabinet's job at this distance, and a
      // per-instance hit test over a whole hall costs more than it buys.
      raycast={() => null}
    >
      {/* White base colour so the per-instance role colour comes through
          unmultiplied. Unlit-ish and shadowless on purpose — this tier is the
          cheap one. */}
      <meshStandardMaterial color="#ffffff" roughness={0.6} metalness={0.15} />
    </instancedMesh>
  )
}
