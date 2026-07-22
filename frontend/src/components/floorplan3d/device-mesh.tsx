import { useEffect, useState } from "react"
import { useThree } from "@react-three/fiber"
import * as THREE from "three"

import { deviceYM, type SceneDevice, type SceneRack } from "./world"

const DEVICE_FALLBACK = "#52525b"
const DEVICE_SELECTED = "#0ea5e9"

// ─── Face-texture cache ──────────────────────────────────────────────────────
// One texture per device-type image URL, shared across every device box that
// wears it (a rack of 20 identical switches loads one image). LRU-capped so a
// huge catalog can't hold the GPU hostage.
const MAX_TEXTURES = 64
const cache = new Map<string, THREE.Texture>()

function getTexture(url: string, onLoad: () => void): THREE.Texture | null {
  const hit = cache.get(url)
  if (hit) {
    // Refresh LRU position.
    cache.delete(url)
    cache.set(url, hit)
    return hit
  }
  new THREE.TextureLoader().load(url, (t) => {
    t.colorSpace = THREE.SRGBColorSpace
    t.anisotropy = 4
    if (cache.size >= MAX_TEXTURES) {
      const oldest = cache.keys().next().value
      if (oldest) {
        cache.get(oldest)?.dispose()
        cache.delete(oldest)
      }
    }
    cache.set(url, t)
    onLoad()
  })
  return null
}

/** Subscribe to a cached texture; re-renders (and re-draws the demand-frameloop
 * canvas) when it lands. */
function useFaceTexture(url: string | null): THREE.Texture | null {
  const invalidate = useThree((s) => s.invalidate)
  const [, bump] = useState(0)
  const tex = url ? (cache.get(url) ?? null) : null
  useEffect(() => {
    if (!url || cache.has(url)) return
    getTexture(url, () => {
      bump((n) => n + 1)
      invalidate()
    })
  }, [url, invalidate])
  return tex
}

/**
 * One racked device: a box at its true U position, clickable, wearing its
 * device-type face image on the exposed side when one exists (the rest of the
 * box keeps the role color). Rendered only in the rack's near-LOD tier, so
 * textures never load for far-away cabinets.
 */
export function DeviceMesh({
  rack,
  dev,
  rackWidthM,
  rackDepthM,
  selected,
  showTexture,
  onSelect,
}: {
  rack: SceneRack
  dev: SceneDevice
  rackWidthM: number
  rackDepthM: number
  selected: boolean
  /** Near tier only — keeps image fetches away from far cabinets. */
  showTexture: boolean
  onSelect: (deviceId: string) => void
}) {
  const [hovered, setHovered] = useState(false)
  const { y, h } = deviceYM(rack, dev)

  const dw = dev.rack_width === "half" ? rackWidthM * 0.44 : rackWidthM * 0.92
  const dx =
    dev.rack_side === "left"
      ? -rackWidthM * 0.23
      : dev.rack_side === "right"
        ? rackWidthM * 0.23
        : 0
  const dd = dev.is_full_depth ? rackDepthM * 0.9 : rackDepthM * 0.45
  const mountedRear = dev.face === "rear"
  const dz = mountedRear ? rackDepthM * 0.45 - dd / 2 : dd / 2 - rackDepthM * 0.45

  const imageUrl = mountedRear
    ? (dev.rear_image ?? dev.front_image)
    : (dev.front_image ?? dev.rear_image)
  const texture = useFaceTexture(showTexture ? imageUrl : null)

  const bodyColor = selected
    ? DEVICE_SELECTED
    : hovered
      ? "#71717a"
      : dev.role_color || DEVICE_FALLBACK
  const boxH = h * 0.94

  return (
    <group
      position={[dx, y + h / 2, dz]}
      onClick={(e) => {
        e.stopPropagation()
        onSelect(dev.id)
      }}
      onPointerOver={(e) => {
        e.stopPropagation()
        setHovered(true)
        document.body.style.cursor = "pointer"
      }}
      onPointerOut={() => {
        setHovered(false)
        document.body.style.cursor = ""
      }}
    >
      <mesh>
        <boxGeometry args={[dw, boxH, dd]} />
        <meshStandardMaterial color={bodyColor} roughness={0.7} />
      </mesh>
      {texture && (
        // The exposed face, textured with the device-type photo. A hair off
        // the box surface to dodge z-fighting; front faces −Z (the rack's
        // front plane), rear faces +Z.
        <mesh
          position={[0, 0, (dd / 2 + 0.002) * (mountedRear ? 1 : -1)]}
          rotation={[0, mountedRear ? 0 : Math.PI, 0]}
        >
          <planeGeometry args={[dw, boxH]} />
          <meshBasicMaterial map={texture} toneMapped={false} />
        </mesh>
      )}
      {selected && (
        <lineSegments>
          <edgesGeometry args={[new THREE.BoxGeometry(dw, boxH, dd)]} />
          <lineBasicMaterial color={DEVICE_SELECTED} />
        </lineSegments>
      )}
    </group>
  )
}
