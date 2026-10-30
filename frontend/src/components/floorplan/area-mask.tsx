import { CELL } from "./canvas-geometry"

/** Dims everything outside an area's outline, so a live view made from a
 * room - or a room's part of its floor - reads as the room. World px, over
 * the plan, inert. `outline` and the grid are in cells. */
export function AreaMask({
  outline,
  width,
  height,
}: {
  outline: [number, number][]
  width: number
  height: number
}) {
  if (outline.length < 3) return null
  const outer = `M0 0H${width * CELL}V${height * CELL}H0Z`
  const inner = `M${outline.map(([x, y]) => `${x * CELL} ${y * CELL}`).join("L")}Z`
  return (
    <path
      data-part="area-mask"
      d={outer + inner}
      fillRule="evenodd"
      fillOpacity={0.6}
      className="pointer-events-none fill-background"
    />
  )
}
