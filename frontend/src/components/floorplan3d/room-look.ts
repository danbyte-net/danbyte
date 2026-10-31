/**
 * The room's look in each theme: a clean architectural model - a pale or
 * deep zinc slab, light walls with a fine edge line, a soft grid that fades
 * out away from the camera, and the plan's background as a muted floor
 * texture (the 2D plan's Muted background, background-look.tsx). Colours
 * only; the meshes that wear them are room.tsx, wall-mesh.tsx and
 * area-floor-mesh.tsx.
 */

export interface RoomLook {
  /** The floor slab. */
  slab: string
  /** A wall with no colour of its own, and its edge lines. */
  wall: string
  wallEdge: string
  /** The grid's lines and their strength at the camera. */
  grid: string
  gridOpacity: number
  /** A name plate over the room: its plate, text and hairline. */
  plate: string
  plateText: string
  plateBorder: string
}

export const ROOM_LOOK: Record<"light" | "dark", RoomLook> = {
  light: {
    slab: "#d4d4d8",
    wall: "#f4f4f5",
    wallEdge: "#a1a1aa",
    grid: "#71717a",
    gridOpacity: 0.32,
    plate: "rgba(255,255,255,0.94)",
    plateText: "#18181b",
    plateBorder: "rgba(24,24,27,0.18)",
  },
  dark: {
    slab: "#1f1f23",
    wall: "#52525b",
    wallEdge: "#a1a1aa",
    grid: "#a1a1aa",
    gridOpacity: 0.2,
    plate: "rgba(24,24,27,0.92)",
    plateText: "#f4f4f5",
    plateBorder: "rgba(244,244,245,0.16)",
  },
}

export const roomLook = (dark: boolean): RoomLook =>
  ROOM_LOOK[dark ? "dark" : "light"]

/** Where the grid fades (metres from the camera): whole up to `near`, gone
 * by `far` - a soft grid near the eye, none across a far-off campus where a
 * fine grid would only shimmer. Scaled by the cell, so a plan of 600 mm
 * cells fades out some fifty metres off. */
export function gridFade(cellM: number): { near: number; far: number } {
  return { near: cellM * 25, far: cellM * 85 }
}
