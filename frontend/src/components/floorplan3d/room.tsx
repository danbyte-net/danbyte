import { useEffect, useMemo, useState } from "react"
import * as THREE from "three"

import { cellToWorld, cellM, type ScenePayload, type SceneTile } from "./world"

/** The room shell: floor slab, grid lines, optional blueprint texture, and
 * zone tiles painted flat on the floor. Everything static — one draw each. */
export function Room({ scene }: { scene: ScenePayload }) {
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
      {/* Floor slab */}
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[w / 2, -0.01, d / 2]}
        receiveShadow
      >
        <planeGeometry args={[w, d]} />
        <meshStandardMaterial color="#27272a" roughness={0.95} />
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
          <ZonePatch key={t.id} plan={plan} tile={t} />
        ))}
    </group>
  )
}

function ZonePatch({
  plan,
  tile,
}: {
  plan: ScenePayload["plan"]
  tile: SceneTile
}) {
  const [x, z] = cellToWorld(plan, tile.x + tile.w / 2, tile.y + tile.h / 2)
  const [w, d] = cellToWorld(plan, tile.w, tile.h)
  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[x, 0.004, z]}>
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
