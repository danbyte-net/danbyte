import { createElement, useEffect, useMemo, useRef } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { useFrame } from "@react-three/fiber"
import * as THREE from "three"

import { getLucideIcon } from "@/components/dynamic-icon"
import { sceneTileIcon } from "@/components/object-icon"

import { clipName, nameBox, thinNames } from "@/components/floorplan/readable"
import type { NameCandidate } from "@/components/floorplan/readable"

import { useTheme } from "@/components/theme-provider"

import { roomLook } from "./room-look"
import type { RoomLook } from "./room-look"
import { textTexture } from "./text-sprite"
import { cellToWorld, floorDeviceBoxM } from "./world"
import type { ScenePayload, SceneTile } from "./world"

// Readable (Display > Object size) in the room: every placed object's name
// as a billboard of one size on screen, whatever its distance - the objects
// themselves stay their real size. Names past nameReach, behind the camera
// or off screen are left out, and where two would overlap on screen the
// lower ranked hides (the selected and hovered one always shows, then the
// racks, cabinets and devices, then the nearer). Sprites are made only for
// names that show, and kept for when they show again.

/** A name's height on screen, plate and all (px). */
export const NAME_PX_3D = 18
/** The name text inside it (px): what thinning measures. */
const NAME_FONT_3D = 12
/** Farther than this a name is not drawn (m), on a plan smaller than it. */
export const MAX_NAME_M = 400

/** How far a name still draws: MAX_NAME_M, or twice the plan's longer side
 * on a bigger plan, so zooming out over a campus keeps its names. */
export function nameReach(plan: ScenePayload["plan"]): number {
  const [w, d] = cellToWorld(plan, plan.grid_width, plan.grid_height)
  return Math.max(MAX_NAME_M, 2 * Math.max(w, d))
}
/** Made sprites kept beyond what shows, before the unseen are freed. */
const SPRITE_CACHE = 600

/** A sprite's scale for `px` on screen with sizeAttenuation off: the size
 * it would have at 1 m from a perspective camera of `fovDeg`, on a view
 * `viewH` px tall. */
export function screenScale(px: number, fovDeg: number, viewH: number) {
  if (!(viewH > 0)) return 0
  return (px * 2 * Math.tan((fovDeg * Math.PI) / 360)) / viewH
}

/** A tile's name as the room shows it (the 2D canvas's order). */
export function sceneTileName(t: SceneTile): string {
  return (
    t.label ||
    t.rack?.name ||
    t.cabinet?.name ||
    t.device_name ||
    t.type_name ||
    ""
  )
}

/** Where a tile's name floats: over its middle, above its top (m). */
function nameAnchor(plan: ScenePayload["plan"], t: SceneTile): THREE.Vector3 {
  const [x, z] = cellToWorld(plan, t.x + t.w / 2, t.y + t.h / 2)
  const top = t.rack
    ? t.rack.u_height * 0.04445 + 0.2
    : t.cabinet
      ? t.cabinet.outer_height_mm / 1000
      : t.device
        ? (floorDeviceBoxM(t.device)?.h ?? 2.0)
        : 2.0
  return new THREE.Vector3(x, top + 0.25, z)
}

interface NameEntry {
  id: string
  name: string
  /** The plate's icon (object-icon.ts) and its square's colour. */
  icon: string
  color: string
  at: THREE.Vector3
  rank: number
}

interface MadeSprite {
  /** What it was made from: a new name or icon makes it anew. */
  key: string
  sprite: THREE.Sprite
  aspect: number
}

const entryKey = (e: Pick<NameEntry, "name" | "icon" | "color">) =>
  `${e.name}\u0000${e.icon}\u0000${e.color}`

export function ReadableNames3D({
  plan,
  tiles,
  pinned,
  icons = true,
}: {
  plan: ScenePayload["plan"]
  /** Each plate carries its object's icon (Display > Icons when zoomed
   * out). */
  icons?: boolean
  /** The tiles shown in the room, zones left out. */
  tiles: readonly SceneTile[]
  /** The tile whose name always shows - the selected and the hovered. */
  pinned: () => readonly (string | null | undefined)[]
}) {
  const group = useRef<THREE.Group>(null)
  const made = useRef(new Map<string, MadeSprite>())
  // The plates wear the theme's chip; a theme change makes them anew.
  const look = roomLook(useTheme().theme === "dark")
  useEffect(() => {
    const all = made.current
    for (const m of all.values()) free(m)
    all.clear()
  }, [look])
  const entries = useMemo<NameEntry[]>(
    () =>
      tiles
        .map((t) => ({
          id: t.id,
          name: clipName(sceneTileName(t)),
          icon: icons && !t.hidden ? sceneTileIcon(t) : "",
          color: t.color || "#71717a",
          at: nameAnchor(plan, t),
          rank: t.kind === "other" ? 0 : 1,
        }))
        .filter((e) => e.name),
    [tiles, plan, icons]
  )

  // A name gone or renamed: its sprite goes too.
  useEffect(() => {
    const live = new Map(entries.map((e) => [e.id, entryKey(e)]))
    for (const [id, m] of made.current)
      if (live.get(id) !== m.key) {
        free(m)
        made.current.delete(id)
      }
  }, [entries])
  useEffect(() => {
    const all = made.current
    return () => {
      for (const m of all.values()) free(m)
      all.clear()
    }
  }, [])

  const v = useMemo(() => new THREE.Vector3(), [])
  const reach = nameReach(plan)
  useFrame(({ camera, size }) => {
    const g = group.current
    if (!g) return
    const fov = (camera as THREE.PerspectiveCamera).isPerspectiveCamera
      ? (camera as THREE.PerspectiveCamera).fov
      : 50
    const unit = screenScale(NAME_PX_3D, fov, size.height)
    const always = new Set(pinned().filter(Boolean) as string[])
    const cands: NameCandidate[] = []
    for (const e of entries) {
      const d = camera.position.distanceTo(e.at)
      if (d > reach && !always.has(e.id)) continue
      v.copy(e.at).project(camera)
      if (v.z > 1 || Math.abs(v.x) > 1.1 || Math.abs(v.y) > 1.1) continue
      const sx = ((v.x + 1) / 2) * size.width
      const sy = ((1 - v.y) / 2) * size.height
      cands.push({
        id: e.id,
        ...nameBox(e.name, sx, sy - NAME_PX_3D, NAME_FONT_3D),
        // Nearer first within a rank.
        priority: always.has(e.id) ? Infinity : e.rank * 1e6 - d,
      })
    }
    const shown = thinNames(cands)
    for (const e of entries) {
      let m = made.current.get(e.id)
      if (!shown.has(e.id)) {
        if (m) m.sprite.visible = false
        continue
      }
      if (!m) {
        m = make(e, look)
        made.current.set(e.id, m)
        g.add(m.sprite)
      }
      m.sprite.visible = true
      m.sprite.scale.set(unit * m.aspect, unit, 1)
    }
    // Free the unseen once too many are kept.
    if (made.current.size > SPRITE_CACHE)
      for (const [id, m] of made.current)
        if (!m.sprite.visible) {
          g.remove(m.sprite)
          free(m)
          made.current.delete(id)
        }
  })

  return <group ref={group} />
}

/** The plate's icon square: its side and the gap after it (texture px). */
const ICON_PX = 26
const ICON_GAP = 6

/** An icon as an SVG data URL, white strokes - drawn onto a plate. */
export function iconDataUrl(name: string, px: number): string | null {
  const Icon = name ? getLucideIcon(name) : null
  if (!Icon) return null
  const svg = renderToStaticMarkup(
    createElement(Icon, {
      width: px,
      height: px,
      color: "#ffffff",
      strokeWidth: 2.25,
    })
  ).replace(/\sclass="[^"]*"/g, "")
  // The namespace makes it an image the canvas can draw.
  const withNs = svg.includes("xmlns=")
    ? svg
    : svg.replace("<svg", '<svg xmlns="http://www.w3.org/2000/svg"')
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(withNs)}`
}

function make(e: NameEntry, look: RoomLook): MadeSprite {
  const url = iconDataUrl(e.icon, ICON_PX)
  const { texture, w, h } = textTexture(e.name, {
    fontPx: 24,
    pad: 6,
    scale: 1,
    align: "center",
    color: look.plateText,
    background: look.plate,
    border: look.plateBorder,
    lead: url ? ICON_PX + ICON_GAP : 0,
  })
  // The icon: a square in the object's colour at the plate's left, the
  // icon in white over it - the 2D plan's icon tile, small. Drawn once the
  // image has loaded; the plate shows its name meanwhile.
  const canvas = texture.image as HTMLCanvasElement | undefined
  const ctx = url ? canvas?.getContext("2d") : null
  if (url && ctx) {
    const x = 6
    const y = (h - ICON_PX) / 2
    ctx.fillStyle = e.color
    ctx.beginPath()
    ctx.roundRect(x, y, ICON_PX, ICON_PX, 5)
    ctx.fill()
    const img = new Image()
    img.onload = () => {
      const pad = 4
      ctx.drawImage(img, x + pad, y + pad, ICON_PX - pad * 2, ICON_PX - pad * 2)
      texture.needsUpdate = true
    }
    img.src = url
  }
  const material = new THREE.SpriteMaterial({
    map: texture,
    sizeAttenuation: false,
    depthTest: false,
    depthWrite: false,
    transparent: true,
  })
  const sprite = new THREE.Sprite(material)
  sprite.center.set(0.5, 0)
  sprite.position.copy(e.at)
  sprite.renderOrder = 10
  // Names never take a click from what is under them.
  sprite.raycast = () => {}
  return { key: entryKey(e), sprite, aspect: w / h }
}

function free(m: MadeSprite) {
  m.sprite.removeFromParent()
  m.sprite.material.map?.dispose()
  m.sprite.material.dispose()
}
