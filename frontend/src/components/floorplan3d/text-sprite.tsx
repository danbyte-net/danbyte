import { useMemo } from "react"
import * as THREE from "three"

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
  const { texture, aspect } = useMemo(() => {
    const pad = 12
    const fontPx = 44
    const canvas = document.createElement("canvas")
    const ctx = canvas.getContext("2d")!
    ctx.font = `600 ${fontPx}px ui-sans-serif, system-ui, sans-serif`
    const w = Math.ceil(ctx.measureText(text).width) + pad * 2
    const h = fontPx + pad * 2
    canvas.width = w
    canvas.height = h
    // Re-set after resize (canvas resets state).
    ctx.font = `600 ${fontPx}px ui-sans-serif, system-ui, sans-serif`
    ctx.fillStyle = background
    ctx.beginPath()
    ctx.roundRect(0, 0, w, h, 10)
    ctx.fill()
    ctx.fillStyle = color
    ctx.textBaseline = "middle"
    ctx.fillText(text, pad, h / 2 + 2)
    const texture = new THREE.CanvasTexture(canvas)
    texture.colorSpace = THREE.SRGBColorSpace
    texture.anisotropy = 4
    return { texture, aspect: w / h }
  }, [text, color, background])

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
