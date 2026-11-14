import { createElement, useEffect, useMemo, useRef } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { useFrame } from "@react-three/fiber"
import type { ThreeEvent } from "@react-three/fiber"
import * as THREE from "three"

import { getLucideIcon } from "@/components/dynamic-icon"
import { sceneTileIcon } from "@/components/object-icon"

import { clipName } from "@/components/floorplan/readable"

import { useTheme } from "@/components/theme-provider"

import { layoutNames3D } from "./name-layout"
import type { Name3D, Summary3D } from "./name-layout"
import { roomLook } from "./room-look"
import type { RoomLook } from "./room-look"
import { ROOM_FONT, textTexture } from "./text-sprite"
import type { SummaryStore } from "./summary-picker"
import { applyPlanText, collectPlanText } from "./plan-text-bus"
import type { PlanTextBus } from "./plan-text-bus"
import { cellToWorld, floorDeviceBoxM, sceneTileName } from "./world"
import type { ScenePayload, SceneTile } from "./world"

// Readable (Display > Object size) in the room: every placed object's name
// as a billboard of one size on screen, whatever its distance - the objects
// themselves stay their real size. Names past nameReach, behind the camera
// or off screen are left out. Where plates would overlap on screen the
// lower ranked gives way (the selected and hovered one always shows, then
// the racks, cabinets and devices, then the nearer), and with Callouts on
// the crowd it gave way in is called out or summarised (name-layout.ts).
// Sprites are made only for names that show, and kept for when they show
// again.

/** A name's height on screen, plate and all (px). */
export const NAME_PX_3D = 18
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
/** Leaders drawn at most (one per callout). */
const MAX_LEADERS = 128

/** A sprite's scale for `px` on screen with sizeAttenuation off: the size
 * it would have at 1 m from a perspective camera of `fovDeg`, on a view
 * `viewH` px tall. */
export function screenScale(px: number, fovDeg: number, viewH: number) {
  if (!(viewH > 0)) return 0
  return (px * 2 * Math.tan((fovDeg * Math.PI) / 360)) / viewH
}

/** A tile's name as the room shows it (the 2D canvas's order). */
export { sceneTileName }

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

/** The plate's texture: its font and padding (texture px), and its icon
 * square's side and the gap after it. */
const PLATE_FONT = 24
const PLATE_PAD = 6
const ICON_PX = 26
const ICON_GAP = 6

let measurer: CanvasRenderingContext2D | null | undefined
/** A name's width in the plate's font (texture px). */
function textWidth(text: string): number {
  if (measurer === undefined) {
    try {
      measurer = document.createElement("canvas").getContext("2d")
    } catch {
      measurer = null
    }
  }
  if (!measurer) return text.length * PLATE_FONT * 0.6
  measurer.font = `600 ${PLATE_FONT}px ${ROOM_FONT}`
  return measurer.measureText(text).width
}

/** A plate's size on screen (px), as `make` draws it: what the layout
 * keeps apart. */
export function platePx(name: string, icon: string): { w: number; h: number } {
  const lead = icon && getLucideIcon(icon) ? ICON_PX + ICON_GAP : 0
  const w = Math.ceil(textWidth(name)) + PLATE_PAD * 2 + lead
  const h = PLATE_FONT + PLATE_PAD * 2
  return { w: (NAME_PX_3D * w) / h, h: NAME_PX_3D }
}

interface NameEntry {
  id: string
  name: string
  kind: string
  /** The plate's icon (object-icon.ts) and its square's colour. */
  icon: string
  color: string
  at: THREE.Vector3
  rank: number
  /** The plate on screen (px). */
  w: number
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
  callouts = true,
  summaries,
  textBus,
}: {
  /** The plan's own text (plan-text-layer.tsx): laid out in the same pass,
   * so a plate never covers a label nor a label a plate. */
  textBus?: PlanTextBus
  /** Where a summary plate's hover and click go (summary-picker.tsx);
   * without it the plates take no pointer. */
  summaries?: SummaryStore
  plan: ScenePayload["plan"]
  /** Each plate carries its object's icon (Display > Icons when zoomed
   * out). */
  icons?: boolean
  /** Display > Callouts (Auto): a crowd of plates is called out or
   * summarised, not just thinned. */
  callouts?: boolean
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
        .map((t) => {
          const name = clipName(sceneTileName(t))
          const icon = icons && !t.hidden ? sceneTileIcon(t) : ""
          return {
            id: t.id,
            name,
            kind: t.kind,
            icon,
            color: t.color || "#71717a",
            at: nameAnchor(plan, t),
            rank: t.kind === "other" ? 0 : 1,
            w: name ? platePx(name, icon).w : 0,
          }
        })
        .filter((e) => e.name),
    [tiles, plan, icons]
  )

  // A name gone or renamed: its sprite goes too.
  useEffect(() => {
    const live = new Map(entries.map((e) => [e.id, entryKey(e)]))
    for (const [id, m] of made.current)
      if (!id.startsWith("crowd:") && live.get(id) !== m.key) {
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

  // The callouts' leaders: thin lines, a dot at the object's end.
  const leaders = useMemo(() => {
    const lineGeo = new THREE.BufferGeometry()
    lineGeo.setAttribute(
      "position",
      new THREE.BufferAttribute(new Float32Array(MAX_LEADERS * 6), 3)
    )
    const dotGeo = new THREE.BufferGeometry()
    dotGeo.setAttribute(
      "position",
      new THREE.BufferAttribute(new Float32Array(MAX_LEADERS * 3), 3)
    )
    const lines = new THREE.LineSegments(
      lineGeo,
      new THREE.LineBasicMaterial({
        depthTest: false,
        depthWrite: false,
        transparent: true,
        opacity: 0.7,
      })
    )
    const dots = new THREE.Points(
      dotGeo,
      new THREE.PointsMaterial({
        size: 4,
        sizeAttenuation: false,
        depthTest: false,
        depthWrite: false,
      })
    )
    for (const o of [lines, dots]) {
      o.renderOrder = 9
      o.frustumCulled = false
      o.raycast = () => {}
    }
    return { lines, dots }
  }, [])
  useEffect(() => {
    leaders.lines.material.color.set(look.plateText)
    leaders.dots.material.color.set(look.plateText)
  }, [leaders, look])
  useEffect(
    () => () => {
      leaders.lines.geometry.dispose()
      leaders.lines.material.dispose()
      leaders.dots.geometry.dispose()
      leaders.dots.material.dispose()
    },
    [leaders]
  )

  // While mounted the plates run the plan text's pass.
  useEffect(() => {
    if (!textBus) return
    textBus.driven++
    return () => {
      textBus.driven--
    }
  }, [textBus])

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
    const names: Name3D[] = []
    // Each name's depth on screen: a box moved off its object is drawn at
    // its object's depth.
    const depth = new Map<string, number>()
    for (const e of entries) {
      const d = camera.position.distanceTo(e.at)
      if (d > reach && !always.has(e.id)) continue
      v.copy(e.at).project(camera)
      if (v.z > 1 || Math.abs(v.x) > 1.1 || Math.abs(v.y) > 1.1) continue
      depth.set(e.id, v.z)
      names.push({
        id: e.id,
        name: e.name,
        kind: e.kind,
        icon: e.icon,
        color: e.color,
        x: ((v.x + 1) / 2) * size.width,
        y: ((1 - v.y) / 2) * size.height,
        w: e.w,
        h: NAME_PX_3D,
        // Nearer first within a rank.
        priority: e.rank * 1e6 - d,
        pinned: always.has(e.id),
      })
    }
    const layout = layoutNames3D(names, {
      view: { x: 0, y: 0, w: size.width, h: size.height },
      callouts,
      plateSize: platePx,
      extras: textBus ? collectPlanText(textBus, camera, size) : undefined,
    })
    if (textBus) applyPlanText(textBus, layout.extras)
    // The hovered plate gone (the camera moved on): its card goes too.
    const hovered = summaries?.get().hover
    if (hovered && !layout.summaries.some((s) => s.id === hovered.id))
      summaries.hover(null)
    // A screen point (px) at a depth, in the room.
    const toWorld = (x: number, y: number, z: number, out: THREE.Vector3) =>
      out
        .set((x / size.width) * 2 - 1, 1 - (y / size.height) * 2, z)
        .unproject(camera)
    const show = (e: Pick<NameEntry, "id" | "name" | "icon" | "color">) => {
      let m = made.current.get(e.id)
      if (m && m.key !== entryKey(e)) {
        free(m)
        made.current.delete(e.id)
        m = undefined
      }
      if (!m) {
        m = make(e, look)
        made.current.set(e.id, m)
        g.add(m.sprite)
      }
      m.sprite.visible = true
      m.sprite.scale.set(unit * m.aspect, unit, 1)
      return m.sprite
    }
    const seen = new Set<string>()
    for (const e of entries) {
      const c = layout.callouts.get(e.id)
      if (layout.plain.has(e.id)) show(e).position.copy(e.at)
      else if (c)
        toWorld(
          c.box.x + c.box.w / 2,
          c.box.y + c.box.h,
          depth.get(e.id)!,
          show(e).position
        )
      else continue
      seen.add(e.id)
    }
    for (const s of layout.summaries) {
      const sprite = show(s)
      sprite.userData.summary = s
      if (summaries) sprite.raycast = plateRaycast
      const z =
        s.members.reduce((t, id) => t + (depth.get(id) ?? 0), 0) /
        s.members.length
      toWorld(s.box.x + s.box.w / 2, s.box.y + s.box.h, z, sprite.position)
      seen.add(s.id)
    }
    for (const [id, m] of made.current)
      if (!seen.has(id)) m.sprite.visible = false

    // Leaders: from the box's edge to the object, at its depth.
    const lp = leaders.lines.geometry.getAttribute(
      "position"
    ) as THREE.BufferAttribute
    const dp = leaders.dots.geometry.getAttribute(
      "position"
    ) as THREE.BufferAttribute
    let n = 0
    for (const [id, c] of layout.callouts) {
      if (n >= MAX_LEADERS) break
      const z = depth.get(id)!
      toWorld(c.leader[0][0], c.leader[0][1], z, v)
      lp.setXYZ(n * 2, v.x, v.y, v.z)
      toWorld(c.leader[1][0], c.leader[1][1], z, v)
      lp.setXYZ(n * 2 + 1, v.x, v.y, v.z)
      dp.setXYZ(n, v.x, v.y, v.z)
      n++
    }
    lp.needsUpdate = true
    dp.needsUpdate = true
    leaders.lines.geometry.setDrawRange(0, n * 2)
    leaders.dots.geometry.setDrawRange(0, n)
    leaders.lines.visible = n > 0
    leaders.dots.visible = n > 0

    // Free the unseen once too many are kept.
    if (made.current.size > SPRITE_CACHE)
      for (const [id, m] of made.current)
        if (!m.sprite.visible) {
          g.remove(m.sprite)
          free(m)
          made.current.delete(id)
        }
  })

  // A summary plate under the pointer: its members on hover, its panel on
  // a click. It takes the event ahead of whatever stands behind it.
  const hit = (e: ThreeEvent<PointerEvent | MouseEvent>) => {
    const s = e.object.userData.summary as Summary3D | undefined
    if (!s || !e.object.visible) return null
    e.stopPropagation()
    return {
      id: s.id,
      name: s.name,
      members: s.members,
      x: e.nativeEvent.clientX,
      y: e.nativeEvent.clientY,
    }
  }
  const off = () => {
    summaries?.hover(null)
    document.body.style.cursor = ""
  }
  // The cursor is the page's: never leave it a pointer after unmount.
  const offRef = useRef(off)
  offRef.current = off
  useEffect(() => () => offRef.current(), [])

  return (
    <group
      ref={group}
      onPointerMove={
        summaries
          ? (e) => {
              const h = hit(e)
              if (!h) return
              summaries.hover(h)
              document.body.style.cursor = "pointer"
            }
          : undefined
      }
      onPointerOut={summaries ? off : undefined}
      onClick={
        summaries
          ? (e) => {
              const h = hit(e)
              if (!h) return
              off()
              summaries.open(h)
            }
          : undefined
      }
    >
      <primitive object={leaders.lines} />
      <primitive object={leaders.dots} />
    </group>
  )
}

/** An icon as an SVG data URL, white strokes (or `color`'s) - drawn onto
 * a plate. */
export function iconDataUrl(
  name: string,
  px: number,
  color = "#ffffff"
): string | null {
  const Icon = name ? getLucideIcon(name) : null
  if (!Icon) return null
  const svg = renderToStaticMarkup(
    createElement(Icon, {
      width: px,
      height: px,
      color,
      strokeWidth: 2.25,
    })
  ).replace(/\sclass="[^"]*"/g, "")
  // The namespace makes it an image the canvas can draw.
  const withNs = svg.includes("xmlns=")
    ? svg
    : svg.replace("<svg", '<svg xmlns="http://www.w3.org/2000/svg"')
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(withNs)}`
}

function make(
  e: Pick<NameEntry, "name" | "icon" | "color">,
  look: RoomLook
): MadeSprite {
  const url = iconDataUrl(e.icon, ICON_PX)
  const { texture, w, h } = textTexture(e.name, {
    fontPx: PLATE_FONT,
    pad: PLATE_PAD,
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
    const x = PLATE_PAD
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
  sprite.renderOrder = 10
  // Names never take a click from what is under them.
  sprite.raycast = () => {}
  return { key: entryKey(e), sprite, aspect: w / h }
}

/** A summary plate's pick: the sprite's own, at no distance, so the plate
 * - drawn over everything - takes the pointer ahead of what is behind. */
function plateRaycast(
  this: THREE.Sprite,
  raycaster: THREE.Raycaster,
  intersects: THREE.Intersection[]
) {
  if (!this.visible) return
  const hits: THREE.Intersection[] = []
  THREE.Sprite.prototype.raycast.call(this, raycaster, hits)
  for (const h of hits) intersects.push({ ...h, distance: 0 })
}

function free(m: MadeSprite) {
  m.sprite.removeFromParent()
  m.sprite.material.map?.dispose()
  m.sprite.material.dispose()
}
