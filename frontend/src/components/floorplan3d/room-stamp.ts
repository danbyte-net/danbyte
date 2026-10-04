import { tintStamp } from "@/components/floorplan/tile-paint"

/**
 * The 3D room's frame stamp: one string over every view setting the room
 * draws by. The room only draws on demand, so a change that reaches it as a
 * prop - a toggle, a quality tier, a rack's Color by tint (#247), the rack a
 * table row points at - must change this string, or the canvas keeps the
 * old picture (`Stage`'s `InvalidateOnToggle` draws a frame on each new
 * stamp).
 */
export function roomStamp({
  showWalls,
  showCables,
  showCeiling,
  showAirflow,
  showNames,
  namesScope,
  namesAtEdge,
  showUNumbers,
  floorPeek,
  shellMode,
  quality,
  tints,
  pointed,
}: {
  showWalls: boolean
  showCables: boolean
  showCeiling: boolean
  showAirflow: boolean
  showNames: boolean
  namesScope: string
  namesAtEdge: boolean
  showUNumbers: boolean
  floorPeek: boolean
  shellMode: string
  quality: string
  /** Each rack tile's tint, by tile id. */
  tints?: ReadonlyMap<string, string>
  /** The rack tiles pointed at from outside the room. */
  pointed?: ReadonlySet<string>
}): string {
  return [
    showWalls,
    showCables,
    showCeiling,
    showAirflow,
    showNames,
    namesScope,
    namesAtEdge,
    showUNumbers,
    floorPeek,
    shellMode,
    quality,
    tints ? tintStamp(tints) : "",
    pointed ? [...pointed].sort().join(",") : "",
  ].join("|")
}
