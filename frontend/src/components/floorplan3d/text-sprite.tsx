import { useEffect, useMemo } from "react"
import * as THREE from "three"

import { useMaxAnisotropy } from "./texture-quality"

/** Render text to a canvas texture (system font — no network fetch, so it's
 * airgap/CSP-safe, unlike drei's troika `<Text>`). Returns the texture plus
 * its pixel width/height so callers can size a plane to the text aspect. */
function textTexture(
  text: string,
  {
    color = "#e4e4e7",
    background = "rgba(24,24,27,0.9)",
    fontPx = 44,
    align = "left" as CanvasTextAlign,
    pad = 12,
    anisotropy = 4,
    /** Canvas pixels per texture pixel. Labels are small on screen but read at
     * a steep angle, where an undersampled canvas is exactly what makes a rack
     * name plate mushy — draw it at 2x and let mipmaps take it down. */
    scale = 2,
  } = {}
): { texture: THREE.CanvasTexture; w: number; h: number } {
  const font = `600 ${fontPx * scale}px ui-monospace, ui-sans-serif, system-ui, sans-serif`
  const canvas = document.createElement("canvas")
  const ctx = canvas.getContext("2d")!
  ctx.font = font
  const w = Math.ceil(ctx.measureText(text).width) + pad * scale * 2
  const h = (fontPx + pad * 2) * scale
  canvas.width = w
  canvas.height = h
  ctx.font = font // reset (canvas resize clears state)
  ctx.fillStyle = background
  ctx.beginPath()
  ctx.roundRect(0, 0, w, h, 8 * scale)
  ctx.fill()
  ctx.fillStyle = color
  ctx.textBaseline = "middle"
  ctx.textAlign = align
  ctx.fillText(
    text,
    align === "center" ? w / 2 : pad * scale,
    h / 2 + 2 * scale
  )
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.anisotropy = anisotropy
  return { texture, w, h }
}

/**
 * A FLAT text label lying in the scene (not billboarded), rendered as a
 * canvas-texture plane. Used for rack name plates, device names and U numbers
 * on the cabinet's front face: anchored to the hardware, they read cleanly
 * when you face the rack and — unlike sprites — never rotate to camera and
 * pile up in the aisle. The caller positions/rotates it (front face = rotate
 * π about Y so the text reads from the −Z aisle side).
 */
export function FaceLabel({
  text,
  position,
  rotation = [0, Math.PI, 0],
  heightM = 0.05,
  align = "left",
  color,
  background,
}: {
  text: string
  position: [number, number, number]
  rotation?: [number, number, number]
  /** World height of the text band, in metres. */
  heightM?: number
  align?: CanvasTextAlign
  color?: string
  background?: string
}) {
  const anisotropy = useMaxAnisotropy()
  const { texture, aspect } = useMemo(() => {
    const t = textTexture(text, { align, color, background, anisotropy })
    return { texture: t.texture, aspect: t.w / t.h }
  }, [text, align, color, background, anisotropy])
  useEffect(() => () => texture.dispose(), [texture])
  return (
    <mesh position={position} rotation={rotation} raycast={() => null}>
      <planeGeometry args={[heightM * aspect, heightM]} />
      <meshBasicMaterial map={texture} transparent depthWrite={false} />
    </mesh>
  )
}

/**
 * A billboarded text label rendered into a canvas texture.
 *
 * Deliberately NOT drei's `<Text>`: troika loads its default font over the
 * network, which breaks airgapped deployments and the strict CSP. A 2D-canvas
 * sprite uses the system font stack, needs no fetch, and is plenty for rack
 * name plates.
 */
export function TextSprite({
  text,
  position,
  heightM = 0.22,
  color = "#e4e4e7",
  background = "rgba(24,24,27,0.85)",
}: {
  text: string
  position: [number, number, number]
  /** World height of the label in metres. */
  heightM?: number
  color?: string
  background?: string
}) {
  // Same canvas painter as FaceLabel — one place that decides how crisp text
  // in the room is.
  const anisotropy = useMaxAnisotropy()
  const { texture, aspect } = useMemo(() => {
    const t = textTexture(text, { color, background, anisotropy })
    return { texture: t.texture, aspect: t.w / t.h }
  }, [text, color, background, anisotropy])
  useEffect(() => () => texture.dispose(), [texture])

  return (
    // raycast disabled: the label floats above the cabinet and would otherwise
    // swallow clicks meant for the rack/devices behind it (the raycaster hits
    // sprites even when they draw on top). depthTest stays ON so labels are
    // occluded naturally instead of bleeding through nearer cabinets.
    <sprite
      position={position}
      scale={[heightM * aspect, heightM, 1]}
      raycast={() => null}
    >
      <spriteMaterial map={texture} transparent />
    </sprite>
  )
}
