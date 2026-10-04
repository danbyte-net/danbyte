import { Position } from "@xyflow/react"
import type { Node, NodeHandle } from "@xyflow/react"

// A big Diagram's cards, given to React Flow already measured. React Flow
// mounts every node it has not measured yet, visible or not, to find the
// handles its edges start from - on a 2,400-device map that is every card
// in the DOM at once, only to be taken out again a moment later. A Diagram
// card's handles are there only so React Flow draws its edges (the links
// and overlays find their own ends from the boxes), and its box is known
// from the build. So the box and the handles go in with the node, where
// React Flow's CSS puts them, and only the cards in view mount. A card
// that does mount is measured as before. A photo is its fixed box, with
// the card's two handles: it goes in measured too.

/** Nodes from which the Diagram's cards are handed over measured. A small
 * map is measured by mounting it: that costs little. */
export const PRESIZE_AT = 200

/** A 1px handle at the middle of a node's side, as the card and junction
 * nodes draw theirs. */
function handle(
  type: "source" | "target",
  position: Position,
  w: number,
  h: number
): NodeHandle {
  const x =
    position === Position.Left ? 0 : position === Position.Right ? w : w / 2
  const y =
    position === Position.Top ? 0 : position === Position.Bottom ? h : h / 2
  return {
    id: null,
    type,
    position,
    x: x - 0.5,
    y: y - 0.5,
    width: 1,
    height: 1,
  }
}

/**
 * `n` with its measured box and its handles, when it is a Diagram card -
 * drawn as its card or its photo, which put their handles in the same
 * places - or a junction with a size; any other node as it is.
 */
export function presized(n: Node): Node {
  const w = n.width
  const h = n.height
  if (w === undefined || h === undefined || n.hidden) return n
  let sides: [Position, Position]
  if (n.type === "card") sides = [Position.Top, Position.Bottom]
  else if (n.type === "junction") sides = [Position.Left, Position.Right]
  else return n
  if (n.handles && n.measured?.width === w && n.measured.height === h) return n
  return {
    ...n,
    measured: { width: w, height: h },
    handles: [
      handle("target", sides[0], w, h),
      handle("source", sides[1], w, h),
    ],
  }
}
