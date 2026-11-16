import { useEffect, useMemo, useRef, useState } from "react"
import type { ThreeEvent } from "@react-three/fiber"
import * as THREE from "three"

import type { PointerMenuAt } from "@/components/pointer-menu"
import { MODEL_PORT_SELECTED } from "@/lib/model-ports"
import type { V3 } from "@/lib/model-ports"

import { bayBoxes } from "./model-assembly"

/* Module bays on an assembled model as pick boxes - the 3D viewer's and
 * the room's (a floor device or a racked one drawn as its model). */

const BAY_HOVER = "#e4e4e7"
const BAY_WASH_OPACITY = 0.08
/** The box stands this share proud of the part, so its outline isn't lost
 * in the part's own edges. */
const BAY_INFLATE = 0.01
const UNIT_BOX = new THREE.BoxGeometry(1, 1, 1)
const UNIT_EDGES = new THREE.EdgesGeometry(UNIT_BOX)

/** The bays a device's model draws, as pickable boxes in the assembled
 * model's frame: an installed module or an empty bay's cover. A port on a
 * module stays the port's: the box lets its events through. */
export function BayHits({
  root,
  drawn,
  selected,
  onSelect,
  onMenu,
}: {
  root: THREE.Object3D
  drawn: ReadonlySet<string>
  selected: string | null
  onSelect?: (bay: string) => void
  onMenu?: (bay: string, at: PointerMenuAt) => void
}) {
  const boxes = useMemo(() => bayBoxes(root, drawn), [root, drawn])
  const [hover, setHover] = useState<string | null>(null)
  const rightDown = useRef<{ x: number; y: number } | null>(null)
  useEffect(
    () => () => {
      document.body.style.cursor = ""
    },
    []
  )
  // A port marker under the pointer wins.
  const onPort = (e: ThreeEvent<PointerEvent | MouseEvent>) =>
    e.intersections.some((i) => i.object.userData.portMarkers)
  // The boxes are in the root's own frame; it may carry a transform of its
  // own under the fit's turn.
  return (
    <group matrix={root.matrix} matrixAutoUpdate={false}>
      {boxes.map((b) => {
        const size = b.box.getSize(new THREE.Vector3())
        const center = b.box.getCenter(new THREE.Vector3())
        const grow = 1 + BAY_INFLATE
        const scale: V3 = [size.x * grow, size.y * grow, size.z * grow]
        const lit =
          b.bay === selected
            ? MODEL_PORT_SELECTED
            : b.bay === hover
              ? BAY_HOVER
              : null
        return (
          <group key={b.bay} position={center} scale={scale}>
            <mesh
              geometry={UNIT_BOX}
              onPointerMove={(e) => {
                if (onPort(e)) {
                  if (hover === b.bay) setHover(null)
                  return
                }
                e.stopPropagation()
                if (hover !== b.bay) {
                  setHover(b.bay)
                  document.body.style.cursor = "pointer"
                }
              }}
              onPointerOut={() => {
                setHover((h) => (h === b.bay ? null : h))
                document.body.style.cursor = ""
              }}
              onClick={(e) => {
                if (onPort(e) || !onSelect) return
                e.stopPropagation()
                onSelect(b.bay)
              }}
              onPointerDown={(e) => {
                if (e.nativeEvent.button === 2)
                  rightDown.current = {
                    x: e.nativeEvent.clientX,
                    y: e.nativeEvent.clientY,
                  }
              }}
              onPointerUp={(e) => {
                const from = rightDown.current
                rightDown.current = null
                if (e.nativeEvent.button !== 2 || !from || !onMenu) return
                if (onPort(e)) return
                const { clientX: x, clientY: y } = e.nativeEvent
                if (Math.hypot(x - from.x, y - from.y) > 4) return
                e.stopPropagation()
                onMenu(b.bay, { x, y })
              }}
            >
              {lit ? (
                <meshBasicMaterial
                  color={lit}
                  transparent
                  opacity={BAY_WASH_OPACITY}
                  depthWrite={false}
                  toneMapped={false}
                />
              ) : (
                <meshBasicMaterial visible={false} />
              )}
            </mesh>
            {lit && (
              <lineSegments geometry={UNIT_EDGES}>
                <lineBasicMaterial color={lit} toneMapped={false} />
              </lineSegments>
            )}
          </group>
        )
      })}
    </group>
  )
}
