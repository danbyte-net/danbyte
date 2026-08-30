import { useEffect, useMemo, useState } from "react"
import * as THREE from "three"

import {
  cellToWorld,
  cellM,
  mm,
  type ScenePayload,
  type SceneTile,
} from "./world"

// One tiny canvas of grate slots shared by every perforated zone (clones only
// re-upload the repeat). Canvas-drawn - CSP/airgap-safe like every texture in
// this room.
let grateBase: THREE.CanvasTexture | null = null
function grateTexture(): THREE.CanvasTexture {
  if (grateBase) return grateBase
  const c = document.createElement("canvas")
  c.width = c.height = 64
  const g = c.getContext("2d")!
  g.fillStyle = "#3f3f46"
  g.fillRect(0, 0, 64, 64)
  g.fillStyle = "#131316"
  // Two columns of vent slots per 600 mm tile - the supply-tile look.
  for (const x of [10, 38]) {
    for (let row = 0; row < 4; row++) {
      g.fillRect(x, 6 + row * 15, 16, 9)
    }
  }
  grateBase = new THREE.CanvasTexture(c)
  grateBase.wrapS = grateBase.wrapT = THREE.RepeatWrapping
  grateBase.colorSpace = THREE.SRGBColorSpace
  return grateBase
}

/** The room shell: floor slab, grid lines, optional blueprint texture, and
 * zone tiles painted flat on the floor. Everything static - one draw each.
 * `xray` ghosts the slab so underfloor runs read through. Zone patches are
 * deliberately inert: a first version made them clickable (isolate), and
 * every empty-floor click inside a zone hid the room instead of
 * deselecting - isolation lives on the rack HUD now. */
export function Room({
  scene,
  xray = false,
  ceiling = false,
}: {
  scene: ScenePayload
  xray?: boolean
  /** Draw the ceiling plane - single-sided facing DOWN, so it encloses the
   * room from inside but never blocks the bird's-eye view (and it neither
   * casts nor receives shadow: the key light sits above it). */
  ceiling?: boolean
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
      {/* Floor slab - ghosted in x-ray so the plenum reads from above. */}
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[w / 2, -0.01, d / 2]}
        receiveShadow
      >
        <planeGeometry args={[w, d]} />
        {/* Keyed single material with explicit mode props - a same-type
            solid/ghost ternary is diffed in place and r3f resets removed
            props to 0 (transparent=0 breaks three's strict checks; see
            WallMesh). */}
        <meshStandardMaterial
          key={xray ? "ghost" : "solid"}
          color="#27272a"
          roughness={0.95}
          transparent={xray}
          opacity={xray ? 0.35 : 1}
          depthWrite={!xray}
        />
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
      {ceiling && !xray && (
        // Faces DOWN, so it encloses the room from inside and never blocks
        // the bird's-eye. It also has to be light enough to SEE from below:
        // the key light sits above it, so the underside gets ambient only -
        // at near-black (#1c1c1f) it was indistinguishable from the empty
        // background and read as "the ceiling toggle does nothing".
        <mesh
          rotation={[Math.PI / 2, 0, 0]}
          position={[w / 2, mm(plan.ceiling_mm), d / 2]}
          raycast={() => null}
        >
          <planeGeometry args={[w, d]} />
          <meshStandardMaterial
            color="#4b4b52"
            roughness={0.95}
            emissive="#4b4b52"
            emissiveIntensity={0.12}
          />
        </mesh>
      )}
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
  // Perforated zones draw the grate pattern at one repeat per 600 mm tile -
  // the cold-aisle supply floor, legible without a heat map.
  const grate = useMemo(() => {
    if (!tile.perforated) return null
    const t = grateTexture().clone()
    t.needsUpdate = true
    t.repeat.set(
      Math.max(1, Math.round(w / 0.6)),
      Math.max(1, Math.round(d / 0.6))
    )
    return t
  }, [tile.perforated, w, d])
  useEffect(() => () => grate?.dispose(), [grate])
  // 0.015 sits ABOVE a raised-floor slab top (0.012): a cold aisle drawn on
  // a raised pad must tint the pad, not vanish inside it.
  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[x, 0.015, z]}>
      <planeGeometry args={[w, d]} />
      {grate ? (
        <meshBasicMaterial
          map={grate}
          color={tile.color || "#a1a1aa"}
          transparent
          opacity={0.85}
        />
      ) : (
        <meshBasicMaterial
          color={tile.color || "#52525b"}
          transparent
          opacity={0.18}
        />
      )}
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
