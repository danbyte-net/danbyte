import type { FloorPlanFloor } from "@/lib/api"
import type { ScenePayload } from "@/components/floorplan3d/world"

import { CELL } from "./canvas-geometry"
import { levelToLevel } from "./levels"

type Pt = [number, number]

/** Another level drawn faintly under this one: its walls and the outlines
 * of what stands on it, in this level's cells. */
export interface OnionSkin {
  walls: Pt[][]
  boxes: Pt[][]
}

/** The onion skin of `scene` (the level `from`) seen from level `to`. */
export function onionSkin(
  scene: ScenePayload,
  from: FloorPlanFloor,
  to: FloorPlanFloor
): OnionSkin {
  const map = (p: Pt) => levelToLevel(p, from, to)
  return {
    walls: (scene.walls ?? [])
      .filter((w) => w.points.length >= 2)
      .map((w) => w.points.map(map)),
    boxes: scene.tiles
      .filter((t) => !t.is_zone)
      .map((t) =>
        (
          [
            [t.x, t.y],
            [t.x + t.w, t.y],
            [t.x + t.w, t.y + t.h],
            [t.x, t.y + t.h],
          ] as Pt[]
        ).map(map)
      ),
  }
}

const path = (pts: Pt[], close = false) =>
  pts.map((p, i) => `${i ? "L" : "M"}${p[0] * CELL} ${p[1] * CELL}`).join(" ") +
  (close ? " Z" : "")

/** The onion skin as faint, dashed strokes; it never takes a click. */
export function OnionLayer({ skin }: { skin: OnionSkin }) {
  return (
    <g
      data-layer="onion"
      pointerEvents="none"
      className="stroke-muted-foreground"
      fill="none"
      opacity={0.45}
    >
      {skin.boxes.map((b, i) => (
        <path
          key={`b${i}`}
          d={path(b, true)}
          strokeWidth={1}
          strokeDasharray="3 3"
          vectorEffect="non-scaling-stroke"
        />
      ))}
      {skin.walls.map((w, i) => (
        <path
          key={`w${i}`}
          d={path(w)}
          strokeWidth={2.5}
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
      ))}
    </g>
  )
}
