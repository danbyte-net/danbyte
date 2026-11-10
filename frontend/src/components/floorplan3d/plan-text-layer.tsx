import { useEffect, useLayoutEffect, useMemo, useRef } from "react"
import { useFrame, useThree } from "@react-three/fiber"
import * as THREE from "three"

import { useTheme } from "@/components/theme-provider"
import { fontGrow } from "@/components/floorplan/readable"
import type { NameCandidate } from "@/components/floorplan/readable"
import type { Pt } from "@/components/floorplan/shapes"

import {
  FLAT_PAD_EM,
  PLAN_TEXT_MIN_PX,
  PLAN_TEXT_TINY_PX,
  flatQuad,
  layoutPlanTexts,
  planTextMode,
  planTextPriority,
  screenBounds,
} from "./plan-text"
import type { PlanTextItem, PlanTextMode } from "./plan-text"
import {
  MIN_FIT_SCALE,
  fitPlanText,
  segmentsNear,
  standingPlace,
  standingSpan,
  wallSegments,
} from "./plan-text-fit"
import type { FitRegion, PlacedText } from "./plan-text-fit"
import { applyPlanText, collectPlanText } from "./plan-text-bus"
import type { PlanTextBus, PlanTextCollector } from "./plan-text-bus"
import { iconDataUrl, nameReach, screenScale } from "./readable-names"
import { roomLook } from "./room-look"
import type { RoomLook } from "./room-look"
import { textTexture } from "./text-sprite"
import { useMaxAnisotropy } from "./texture-quality"
import { WALL_THICKNESS_M, cellM } from "./world"
import type { SceneWall, ScenePayload } from "./world"

// The plan's own text in the room (plan-text.ts): each piece painted once
// into a canvas texture and kept - a flat quad on the floor, a billboard
// sprite made the first time it is seen from low down, a plate for a
// tray. Every frame each piece hands its screen box to the room's one
// collision pass (plan-text-bus.ts) and shows only if it won.

/** Canvas px per line of flat text (its texture's resolution). */
const FLAT_FONT_PX = 48
/** The widest a text's canvas may get. */
const MAX_CANVAS_PX = 2048
/** The plan's sans, as the 2D plan writes it. */
const SANS = "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif"
/** A tray's plate on screen (px), as the Readable plates but smaller. */
const TRAY_PX = 15
/** Readable never grows a text past this many times its size. */
const MAX_GROW = 60
/** A room's name keeps this far (mm) off a wall's face, and a wall's
 * thickness plus this in from its room's edges. */
const WALL_PAD_MM = 60

/** One floor quad, laid flat: its local +y (the text's up) along −z. */
let floorQuad: THREE.PlaneGeometry | null = null
function floorQuadGeometry(): THREE.PlaneGeometry {
  if (!floorQuad) {
    floorQuad = new THREE.PlaneGeometry(1, 1)
    floorQuad.rotateX(-Math.PI / 2)
  }
  return floorQuad
}

interface Painted {
  texture: THREE.CanvasTexture
  /** The quad (cells) and its slide along its own axes (cells). */
  w: number
  h: number
  shift: Pt
  /** Width over height. */
  aspect: number
}

let measurer: CanvasRenderingContext2D | null | undefined
function measureCtx(): CanvasRenderingContext2D | null {
  if (measurer === undefined) {
    try {
      measurer = document.createElement("canvas").getContext("2d")
    } catch {
      measurer = null
    }
  }
  return measurer
}

const fontOf = (item: PlanTextItem, px: number) =>
  `${item.weight} ${px}px ${SANS}`

/** Paint a flat text: a label at its 2D box and alignment, on its plate;
 * an area's or a zone's name on one line, its icon first. */
export function paintFlat(
  item: PlanTextItem,
  anisotropy: number,
  onIcon: () => void,
  fpx = FLAT_FONT_PX
): Painted {
  const m = measureCtx()
  const lines = item.lines.length ? item.lines : [""]
  if (m) m.font = fontOf(item, fpx)
  const widths = lines.map((l) =>
    m ? m.measureText(l || " ").width : (l || " ").length * fpx * 0.58
  )
  const ppc = fpx / Math.max(1e-6, item.fontCells)
  const label = item.kind === "label"
  const iconPx = !label && item.icon ? fpx * 0.95 : 0
  const iconGap = iconPx ? fpx * 0.3 : 0
  let wPx: number
  let hPx: number
  const shift: Pt = [0, 0]
  if (label) {
    const minW = (item.minBox?.w ?? 0) * ppc
    const minH = (item.minBox?.h ?? 0) * ppc
    wPx = Math.max(minW, Math.max(...widths) + 0.6 * fpx)
    hPx = Math.max(minH, lines.length * 1.25 * fpx + 0.3 * fpx)
    // Wider than its box (sized to an estimate of its text): it grows
    // away from the side it is aligned to, as the 2D text overflows.
    const extraW = (wPx - minW) / ppc
    if (item.align === "left") shift[0] = extraW / 2
    else if (item.align === "right") shift[0] = -extraW / 2
    shift[1] = (hPx - minH) / ppc / 2
  } else {
    const pad = FLAT_PAD_EM * fpx
    wPx = pad * 2 + iconPx + iconGap + widths[0]
    hPx = fpx * 1.2 + pad * 2
  }
  if (wPx > MAX_CANVAS_PX && fpx > 8)
    return paintFlat(item, anisotropy, onIcon, (fpx * MAX_CANVAS_PX) / wPx)
  const W = Math.max(2, Math.ceil(wPx))
  const H = Math.max(2, Math.ceil(hPx))
  const canvas = document.createElement("canvas")
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext("2d")
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.anisotropy = anisotropy
  const out = { texture, w: W / ppc, h: H / ppc, shift, aspect: W / H }
  if (!ctx) return out
  const ink = item.ink
  if (ink.plate) {
    const lw = Math.max(2, fpx * 0.04)
    const r = Math.min(fpx * 0.3, H / 2)
    ctx.fillStyle = ink.plate
    ctx.beginPath()
    ctx.roundRect(lw / 2, lw / 2, W - lw, H - lw, r)
    ctx.fill()
    if (ink.plateBorder) {
      ctx.strokeStyle = ink.plateBorder
      ctx.lineWidth = lw
      ctx.stroke()
    }
  }
  ctx.font = fontOf(item, fpx)
  ctx.lineJoin = "round"
  const write = (text: string, x: number, y: number) => {
    if (ink.halo) {
      ctx.globalAlpha = ink.haloAlpha
      ctx.strokeStyle = ink.halo
      ctx.lineWidth = fpx * 0.22
      ctx.strokeText(text, x, y)
      ctx.globalAlpha = 1
    }
    ctx.fillStyle = ink.color
    ctx.fillText(text, x, y)
  }
  if (label) {
    ctx.textBaseline = "alphabetic"
    ctx.textAlign =
      item.align === "center"
        ? "center"
        : item.align === "right"
          ? "right"
          : "left"
    const x =
      item.align === "center"
        ? W / 2
        : item.align === "right"
          ? W - 0.3 * fpx
          : 0.3 * fpx
    lines.forEach((line, i) =>
      write(line || " ", x, 0.15 * fpx + fpx * (i * 1.25 + 1))
    )
  } else {
    const pad = FLAT_PAD_EM * fpx
    ctx.textBaseline = "middle"
    ctx.textAlign = "left"
    write(lines[0], pad + iconPx + iconGap, H / 2 + fpx * 0.04)
    const url = iconPx ? iconDataUrl(item.icon!, 48, ink.color) : null
    if (url) {
      const img = new Image()
      img.onload = () => {
        ctx.drawImage(img, pad, (H - iconPx) / 2, iconPx, iconPx)
        texture.needsUpdate = true
        onIcon()
      }
      img.src = url
    }
  }
  return out
}

/** A tray's plate: the room's chip, as the Readable plates wear. */
function paintPlate(item: PlanTextItem, look: RoomLook): Painted {
  const { texture, w, h } = textTexture(item.lines[0], {
    fontPx: 24,
    pad: 6,
    scale: 1,
    align: "center",
    color: look.plateText,
    background: look.plate,
    border: look.plateBorder,
  })
  return { texture, w: 0, h: 0, shift: [0, 0], aspect: w / h }
}

interface Made {
  key: string
  item: PlanTextItem
  painted: Painted
  mesh: THREE.Mesh | null
  sprite: THREE.Sprite | null
  mode: PlanTextMode
  /** A room's, an area's or a zone's name: where it fits inside its
   * floor (plan-text-fit.ts) - null, it fits nowhere and is left out.
   * Undefined for the rest. */
  fit?: PlacedText | null
  region?: FitRegion
  /** How far a standing name's line runs inside its room each way
   * (cells), at the turn it was last asked at. */
  stand?: {
    rot: number
    lines: { base: Pt; back: number; ahead: number }[]
  }
  /** The roomiest spot in its room, once a standing name needs it. */
  pole?: Pt | null
  /** This frame: how it shows if it wins, where (level-local metres) and
   * at what size. */
  frame: {
    state: "hidden" | "flat" | "billboard" | "plate"
    /** Its size over its painted one, and its turn (degrees). */
    grow: number
    rot: number
    pos: THREE.Vector3
    scale: number
  }
}

function makeSprite(
  painted: Painted,
  attenuate: boolean,
  group: THREE.Group
): THREE.Sprite {
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: painted.texture,
      transparent: true,
      depthWrite: false,
      sizeAttenuation: attenuate,
      // A tray's plate reads over its basket, as the room's plates do.
      depthTest: attenuate,
    })
  )
  sprite.center.set(0.5, 0)
  sprite.renderOrder = attenuate ? 8 : 10
  sprite.raycast = () => {}
  sprite.visible = false
  group.add(sprite)
  return sprite
}

function free(m: Made) {
  for (const o of [m.mesh, m.sprite]) {
    if (!o) continue
    o.removeFromParent()
    ;(o.material as THREE.Material).dispose()
  }
  m.painted.texture.dispose()
}

/** Where a level sits in the active level's world. */
export interface LevelPlace {
  x: number
  y: number
  z: number
  rotY: number
}

/**
 * One level's plan text. `idPrefix` keeps each level's ids apart in the
 * shared pass; `place` is the level's offset (the active level: none).
 */
export function PlanTextLayer({
  bus,
  items,
  plan,
  place = null,
  readable = false,
  idPrefix = "",
  walls,
}: {
  bus: PlanTextBus
  items: readonly PlanTextItem[]
  plan: ScenePayload["plan"]
  place?: LevelPlace | null
  /** Display > Object size: Readable - no text under a readable size on
   * screen. */
  readable?: boolean
  idPrefix?: string
  /** The level's walls: a room's name keeps clear of them. */
  walls?: readonly SceneWall[]
}) {
  const group = useRef<THREE.Group>(null)
  const made = useRef(new Map<string, Made>())
  const invalidate = useThree((s) => s.invalidate)
  const anisotropy = useMaxAnisotropy()
  const dark = useTheme().theme === "dark"
  const look = roomLook(dark)
  const settings = useRef({ readable, place, plan })
  settings.current = { readable, place, plan }

  // Paint what is new or changed; free what went.
  useLayoutEffect(() => {
    const g = group.current
    if (!g) return
    const all = made.current
    const want = new Map(items.map((i) => [idPrefix + i.id, i]))
    for (const [id, m] of all) {
      const i = want.get(id)
      if (!i || m.key !== keyOf(i, dark)) {
        free(m)
        all.delete(id)
      }
    }
    for (const [id, item] of want) {
      if (all.has(id)) continue
      const plate = item.kind === "tray"
      const painted = plate
        ? paintPlate(item, look)
        : paintFlat(item, anisotropy, invalidate)
      let mesh: THREE.Mesh | null = null
      if (!plate) {
        mesh = new THREE.Mesh(
          floorQuadGeometry(),
          new THREE.MeshBasicMaterial({
            map: painted.texture,
            transparent: true,
            depthWrite: false,
            toneMapped: false,
          })
        )
        mesh.renderOrder = 3
        mesh.raycast = () => {}
        mesh.visible = false
        g.add(mesh)
      }
      all.set(id, {
        key: keyOf(item, dark),
        item,
        painted,
        mesh,
        sprite: plate ? makeSprite(painted, false, g) : null,
        mode: "flat",
        frame: {
          state: "hidden",
          grow: 1,
          rot: 0,
          pos: new THREE.Vector3(),
          scale: 1,
        },
      })
    }
    invalidate()
  }, [items, idPrefix, dark, look, anisotropy, invalidate])

  // Where each room's name fits inside its floor, clear of the walls.
  const cellMm = plan.cell_mm
  useLayoutEffect(() => {
    const ws = walls ?? []
    const segs = wallSegments(ws, cellMm, WALL_THICKNESS_M * 1000, WALL_PAD_MM)
    const thickest = ws.reduce(
      (t, wl) => Math.max(t, wl.thickness_mm || 0),
      WALL_THICKNESS_M * 1000
    )
    for (const m of made.current.values()) {
      const room = m.item.room
      m.stand = undefined
      m.pole = undefined
      if (!room) {
        m.fit = undefined
        m.region = undefined
        continue
      }
      // An area's edges are where its walls stand; a zone lies inside a
      // room, and only the walls themselves bound it.
      const marginMm =
        m.item.kind === "area" ? thickest + WALL_PAD_MM : WALL_PAD_MM
      const region: FitRegion = {
        outline: room.outline,
        margin: marginMm / cellMm,
        obstacles: segmentsNear(segs, room.outline),
        angles: room.angles,
      }
      m.region = region
      m.fit = fitPlanText(region, m.item, m.painted.w, m.painted.h, {
        maxGrow: MAX_GROW,
      })
    }
    invalidate()
  }, [items, idPrefix, dark, anisotropy, walls, cellMm, invalidate])

  useEffect(() => {
    const all = made.current
    return () => {
      for (const m of all.values()) free(m)
      all.clear()
    }
  }, [])

  const collector = useMemo<PlanTextCollector>(() => {
    const world = new THREE.Matrix4()
    const quat = new THREE.Quaternion()
    const up = new THREE.Vector3(0, 1, 0)
    const one = new THREE.Vector3(1, 1, 1)
    const offset = new THREE.Vector3()
    const w = new THREE.Vector3()
    const v = new THREE.Vector3()
    const v2 = new THREE.Vector3()
    const pA = new THREE.Vector3()
    const pB = new THREE.Vector3()
    const right = new THREE.Vector3()
    const inv = new THREE.Matrix4()
    return {
      collect(camera, size) {
        const cfg = settings.current
        const c = cellM(cfg.plan)
        const reach = nameReach(cfg.plan)
        // The layer's group as it stands this frame - its level's
        // explode lift (level-explode-3d.tsx) included.
        const g = group.current
        if (g) {
          g.updateWorldMatrix(true, false)
          world.copy(g.matrixWorld)
        } else
          world.compose(
            offset.set(cfg.place?.x ?? 0, cfg.place?.y ?? 0, cfg.place?.z ?? 0),
            quat.setFromAxisAngle(up, cfg.place?.rotY ?? 0),
            one
          )
        const fov = (camera as THREE.PerspectiveCamera).isPerspectiveCamera
          ? (camera as THREE.PerspectiveCamera).fov
          : 50
        const tanHalf = Math.tan((fov * Math.PI) / 360)
        // The camera's right on the level's plan: the line a standing
        // text spans (degrees, as the plan turns).
        inv.copy(world).invert()
        right.setFromMatrixColumn(camera.matrixWorld, 0).transformDirection(inv)
        const standRot = (Math.atan2(right.z, right.x) * 180) / Math.PI
        const out: NameCandidate[] = []
        // A level-local point (metres) on screen; null behind the camera.
        const toScreen = (p: THREE.Vector3): Pt | null => {
          v.copy(p).applyMatrix4(world).project(camera)
          if (v.z > 1 || v.z < -1) return null
          return [((v.x + 1) / 2) * size.width, ((1 - v.y) / 2) * size.height]
        }
        const onScreen = (b: { x: number; y: number; w: number; h: number }) =>
          b.x < size.width &&
          b.x + b.w > 0 &&
          b.y < size.height &&
          b.y + b.h > 0
        for (const [id, m] of made.current) {
          const { item, painted, frame } = m
          frame.state = "hidden"
          if (item.kind === "tray") {
            frame.pos.set(item.at[0] * c, item.elevation, item.at[1] * c)
            w.copy(frame.pos).applyMatrix4(world)
            const d = camera.position.distanceTo(w)
            if (d > reach) continue
            const s = toScreen(frame.pos)
            if (!s) continue
            const h = TRAY_PX
            const box = {
              x: s[0] - (h * painted.aspect) / 2,
              y: s[1] - h,
              w: h * painted.aspect,
              h,
            }
            if (!onScreen(box)) continue
            frame.state = "plate"
            frame.scale = screenScale(TRAY_PX, fov, size.height)
            out.push({ id, ...box, priority: planTextPriority("tray", d) })
            continue
          }
          // A room's name where it fits in its room, at the size it fits.
          const fit = m.fit
          if (fit === null) continue
          const spot = fit ?? item
          const scale = fit?.scale ?? 1
          const pw = painted.w * scale
          const ph = painted.h * scale
          const shift: Pt = [painted.shift[0] * scale, painted.shift[1] * scale]
          // Its middle at its own size: how far, and how high the camera.
          const q1 = flatQuad(spot, pw, ph, 1, shift)
          w.set(q1.centre[0] * c, item.elevation, q1.centre[1] * c)
          w.applyMatrix4(world)
          const d = Math.max(1e-3, camera.position.distanceTo(w))
          if (d > reach) continue
          const sinE = (camera.position.y - w.y) / d
          m.mode = planTextMode(sinE, m.mode)
          const pxPerM = size.height / (2 * tanHalf * d)
          const fontM = item.fontCells * c * scale
          // The glyphs' height on screen: flat, the text's up axis as it
          // projects; standing, its height at that distance.
          let textPx = fontM * pxPerM
          if (m.mode === "flat") {
            // The text's up on the plan, (0, −1) turned with it, as x, z.
            const r = (spot.rotation * Math.PI) / 180
            pA.set(q1.centre[0] * c, item.elevation, q1.centre[1] * c)
            pB.set(Math.sin(r), 0, -Math.cos(r)).multiplyScalar(fontM).add(pA)
            const a = toScreen(pA)
            const b = toScreen(pB)
            textPx = a && b ? Math.hypot(a[0] - b[0], a[1] - b[1]) : 0
          }
          if (!cfg.readable && textPx < PLAN_TEXT_TINY_PX) continue
          // Readable grows it, never past its room.
          let grow = cfg.readable
            ? Math.min(
                MAX_GROW,
                fit?.maxGrow ?? MAX_GROW,
                fontGrow(textPx, 1, PLAN_TEXT_MIN_PX)
              )
            : 1
          let box: { x: number; y: number; w: number; h: number }
          // Standing, it spans the camera's right: slid along that line
          // to lie inside its room, no wider than the room there, else
          // left out.
          let standAt: Pt = q1.centre
          if (m.mode !== "flat" && fit && m.region) {
            const region = m.region
            if (!m.stand || Math.abs(m.stand.rot - standRot) > 1) {
              // Its line through its flat middle, and through the
              // roomiest spot in the room (for a name in a corner).
              if (m.pole === undefined)
                m.pole =
                  fitPlanText(region, fit, painted.w, painted.h, {
                    anywhere: true,
                    minScale: 0,
                  })?.at ?? null
              m.stand = {
                rot: standRot,
                lines: [
                  {
                    base: q1.centre,
                    ...standingSpan(region, q1.centre, standRot),
                  },
                  ...(m.pole
                    ? [
                        {
                          base: m.pole,
                          ...standingSpan(region, m.pole, standRot),
                        },
                      ]
                    : []),
                ],
              }
            }
            // Its own place when that holds it, else the roomier line.
            const want = (pw * grow) / 2
            let line = m.stand.lines[0]
            let placed = standingPlace(line, want)
            const other = m.stand.lines.at(1)
            if (other && placed.half < want) {
              const there = standingPlace(other, want)
              if (there.half > placed.half) {
                line = other
                placed = there
              }
            }
            const most = (2 * placed.half) / Math.max(1e-6, painted.w)
            if (most < MIN_FIT_SCALE) continue
            grow = Math.min(grow, most / scale)
            const r = (standRot * Math.PI) / 180
            const b = line.base
            standAt = [
              b[0] + Math.cos(r) * placed.offset,
              b[1] + Math.sin(r) * placed.offset,
            ]
          }
          if (m.mode === "flat") {
            const q = flatQuad(spot, pw, ph, grow, shift)
            const pts: Pt[] = []
            for (const [x, y] of q.corners) {
              const s = toScreen(v2.set(x * c, item.elevation, y * c))
              if (s) pts.push(s)
            }
            if (pts.length < 4) continue
            box = screenBounds(pts)
            frame.pos.set(q.centre[0] * c, item.elevation, q.centre[1] * c)
          } else {
            frame.pos.set(standAt[0] * c, item.elevation, standAt[1] * c)
            const s = toScreen(frame.pos)
            if (!s) continue
            const bw = pw * c * grow * pxPerM
            const bh = ph * c * grow * pxPerM
            box = { x: s[0] - bw / 2, y: s[1] - bh, w: bw, h: bh }
          }
          if (!onScreen(box)) continue
          frame.state = m.mode
          frame.grow = grow * scale
          frame.rot = spot.rotation
          out.push({ id, ...box, priority: planTextPriority(item.kind, d) })
        }
        return out
      },
      apply(kept) {
        const g = group.current
        const c = cellM(settings.current.plan)
        for (const [id, m] of made.current) {
          const { frame, painted } = m
          const show = frame.state !== "hidden" && kept.has(id)
          if (m.mesh) m.mesh.visible = show && frame.state === "flat"
          if (show && frame.state === "flat" && m.mesh) {
            m.mesh.position.copy(frame.pos)
            m.mesh.rotation.set(0, (-frame.rot * Math.PI) / 180, 0)
            m.mesh.scale.set(
              painted.w * c * frame.grow,
              1,
              painted.h * c * frame.grow
            )
          }
          if (show && frame.state === "billboard" && !m.sprite && g)
            m.sprite = makeSprite(painted, true, g)
          if (m.sprite) {
            m.sprite.visible =
              show && (frame.state === "billboard" || frame.state === "plate")
            if (!m.sprite.visible) continue
            m.sprite.position.copy(frame.pos)
            if (frame.state === "plate")
              m.sprite.scale.set(frame.scale * painted.aspect, frame.scale, 1)
            else
              m.sprite.scale.set(
                painted.w * c * frame.grow,
                painted.h * c * frame.grow,
                1
              )
          }
        }
      },
    }
  }, [])

  useEffect(() => {
    bus.collectors.add(collector)
    invalidate()
    return () => {
      bus.collectors.delete(collector)
    }
  }, [bus, collector, invalidate])

  return (
    <group
      ref={group}
      position={place ? [place.x, place.y, place.z] : undefined}
      rotation={place ? [0, place.rotY, 0] : undefined}
    />
  )
}

/** What a text was painted from: a change paints it anew. */
function keyOf(item: PlanTextItem, dark: boolean): string {
  return `${dark ? 1 : 0}${JSON.stringify(item)}`
}

/** The plan text's pass when no Readable plates run it. */
export function PlanTextDriver({ bus }: { bus: PlanTextBus }) {
  useFrame(({ camera, size }) => {
    if (bus.driven) return
    applyPlanText(bus, layoutPlanTexts(collectPlanText(bus, camera, size)))
  })
  return null
}
