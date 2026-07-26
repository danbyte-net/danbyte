import { useEffect, useMemo, useState } from "react"
import * as THREE from "three"

import { cellToWorld, cellM, type ScenePayload, type SceneTile } from "./world"

/** The room shell: floor slab, grid lines, optional blueprint texture, and
 * zone tiles painted flat on the floor. Everything static — one draw each.
 * `xray` ghosts the slab so underfloor runs read through; `onZoneClick`
 * makes zone patches clickable (the isolate-a-zone entry point). */
export function Room({
  scene,
  xray = false,
  onZoneClick,
}: {
  scene: ScenePayload
  xray?: boolean
  onZoneClick?: (tile: SceneTile) => void
}) {
  const { plan } = scene
  const [w, d] = cellToWorld(plan, plan.grid_width, plan.grid_height)

  const grid = useMemo(() => {
    const pts: number[] = []
    const c = cellM(plan)
    for (let x = 0; x <= plan.grid_width; x++)
      pts.push(x * c, 0, 0, x * c, 0, d)
    for (let y = 0; y <= plan.grid_height; y++)
      pts.push(0, 0, y * c, w, 0, y * c)
    const g = new THREE.BufferGeometry()
    g.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3))
    return g
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plan.grid_width, plan.grid_height, plan.cell_mm])

  return (
    <group>
      {/* Floor slab — ghosted in x-ray so the plenum reads from above. */}
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[w / 2, -0.01, d / 2]}
        receiveShadow
      >
        <planeGeometry args={[w, d]} />
        {xray ? (
          <meshStandardMaterial
            color="#27272a"
            roughness={0.95}
            transparent
            opacity={0.35}
            depthWrite={false}
          />
        ) : (
          <meshStandardMaterial color="#27272a" roughness={0.95} />
        )}
      </mesh>
      {plan.background_image && (
        <Blueprint
          url={plan.background_image}
          w={w}
          d={d}
          opacity={plan.background_opacity / 100}
        />
      )}
      {/* Grid lines a hair above the slab */}
      <lineSegments geometry={grid} position={[0, 0.002, 0]}>
        <lineBasicMaterial color="#3f3f46" transparent opacity={0.5} />
      </lineSegments>
      {/* Zone tiles → translucent floor patches */}
      {scene.tiles
        .filter((t) => t.is_zone)
        .map((t) => (
          <ZonePatch key={t.id} plan={plan} tile={t} onClick={onZoneClick} />
        ))}
    </group>
  )
}

function ZonePatch({
  plan,
  tile,
  onClick,
}: {
  plan: ScenePayload["plan"]
  tile: SceneTile
  onClick?: (tile: SceneTile) => void
}) {
  const [x, z] = cellToWorld(plan, tile.x + tile.w / 2, tile.y + tile.h / 2)
  const [w, d] = cellToWorld(plan, tile.w, tile.h)
  // 0.015 sits ABOVE a raised-floor slab top (0.012): a cold aisle drawn on
  // a raised pad must tint the pad, not vanish inside it.
  return (
    <mesh
      rotation={[-Math.PI / 2, 0, 0]}
      position={[x, 0.015, z]}
      // Zone click = isolate that zone. Racks sit above and stop
      // propagation, so only genuine aisle-floor clicks land here.
      onClick={
        onClick
          ? (e) => {
              e.stopPropagation()
              onClick(tile)
            }
          : undefined
      }
      onPointerOver={
        onClick
          ? (e) => {
              e.stopPropagation()
              document.body.style.cursor = "pointer"
            }
          : undefined
      }
      onPointerOut={
        onClick
          ? () => {
              document.body.style.cursor = ""
            }
          : undefined
      }
    >
      <planeGeometry args={[w, d]} />
      <meshBasicMaterial
        color={tile.color || "#52525b"}
        transparent
        opacity={0.18}
      />
    </mesh>
  )
}

/** The uploaded blueprint, textured onto the floor. Loaded manually (not
 * useLoader) so a missing/broken image degrades to the plain slab instead of
 * suspending forever. */
function Blueprint({
  url,
  w,
  d,
  opacity,
}: {
  url: string
  w: number
  d: number
  opacity: number
}) {
  const [texture, setTexture] = useState<THREE.Texture | null>(null)
  useEffect(() => {
    let disposed = false
    const loader = new THREE.TextureLoader()
    loader.load(url, (t) => {
      if (disposed) {
        t.dispose()
        return
      }
      t.colorSpace = THREE.SRGBColorSpace
      setTexture(t)
    })
    return () => {
      disposed = true
    }
  }, [url])
  useEffect(() => () => texture?.dispose(), [texture])
  if (!texture) return null
  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[w / 2, 0.001, d / 2]}>
      <planeGeometry args={[w, d]} />
      <meshBasicMaterial map={texture} transparent opacity={opacity} />
    </mesh>
  )
}
