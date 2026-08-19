import { useThree } from "@react-three/fiber"

/**
 * The GPU's best anisotropic-filtering level.
 *
 * Anisotropy is what keeps a texture crisp when you look at it at a GRAZING
 * angle - which is how you see a rack face for most of a walk down the aisle.
 * Every texture here used to hard-code 4, far below what any modern GPU offers
 * (usually 16), and that is why the 3D panels read soft next to the 2D render
 * of the same faceplate. Ask the renderer instead of guessing.
 *
 * It does not rescue a low-resolution source image: a 600px-wide device photo
 * stretched across a 19" face is blurry at close range no matter how it's
 * filtered. This only stops Danbyte from adding blur of its own.
 */
export function useMaxAnisotropy(): number {
  return useThree((s) => s.gl.capabilities.getMaxAnisotropy())
}
