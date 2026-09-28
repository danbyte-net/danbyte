import type { Edge, Node } from "@xyflow/react"

// Where the camera goes on a map too big to fit the screen. Fitted whole,
// a site of thousands of devices needs a zoom far below the least the
// canvas allows: clamped there, the camera looks at the middle of the map's
// box - often empty space between rows - and the user is left with a
// blank canvas. Such a map opens on a part of it that means something
// instead: the device in focus, else the most-cabled one, with the devices
// cabled to it that fit on screen with it, then the devices nearest it -
// enough of them to see where it sits. Pure.

/** The least zoom the map goes to. */
export const MIN_ZOOM = 0.05

/** The least zoom the part a big map opens on is shown at: its cards are
 * still boxes in their role colours, told apart. */
export const OPEN_ZOOM = 0.1

/** How many cards the part a big map opens on takes, cabled or not, before
 * it stops taking the nearest: the fewer, the closer the camera. */
export const OPEN_CARDS = 24

/** Nodes that are not devices on the map: zones and breakout junctions. */
const OTHER = new Set(["zone", "junction"])

export interface Box {
  x: number
  y: number
  width: number
  height: number
}

/** How far out from the anchor the nearest cards are looked for. */
const NEAREST = 400

const union = (a: Box, b: Box): Box => {
  const x = Math.min(a.x, b.x)
  const y = Math.min(a.y, b.y)
  return {
    x,
    y,
    width: Math.max(a.x + a.width, b.x + b.width) - x,
    height: Math.max(a.y + a.height, b.y + b.height) - y,
  }
}

/**
 * The nodes a map too big to fit opens on. The anchor: `focus` when it is
 * on the map, else the card with the most cables to other cards (through
 * a breakout's junction too; the first in reading order among equals).
 * Then the cards cabled to it, nearest first, and after them the other
 * cards nearest it until there are `OPEN_CARDS`, each taken while the box
 * of all taken still `fits` on screen. `box` gives a node's box on the
 * map. Empty for a map with no cards.
 */
export function openingPart(
  nodes: readonly Node[],
  edges: readonly Edge[],
  box: (n: Node) => Box,
  fits: (b: Box) => boolean,
  focus?: string | null
): Node[] {
  const cards = nodes.filter((n) => !n.hidden && !OTHER.has(n.type ?? ""))
  if (!cards.length) return []
  const byId = new Map(cards.map((n) => [n.id, n]))
  const adj = new Map<string, Set<string>>()
  const join = (a: string, b: string) => {
    if (a === b) return
    ;(adj.get(a) ?? adj.set(a, new Set()).get(a)!).add(b)
    ;(adj.get(b) ?? adj.set(b, new Set()).get(b)!).add(a)
  }
  for (const e of edges) if (!e.hidden) join(e.source, e.target)
  // A junction joins the cards its trunk and legs land on.
  for (const [id, set] of [...adj]) {
    if (byId.has(id)) continue
    const ends = [...set].filter((x) => byId.has(x))
    for (let i = 0; i < ends.length; i++)
      for (let j = i + 1; j < ends.length; j++) join(ends[i], ends[j])
  }
  const cabled = (id: string) =>
    [...(adj.get(id) ?? [])].filter((x) => byId.has(x))
  let anchor = focus ? byId.get(focus) : undefined
  if (!anchor) {
    let most = -1
    for (const n of cards) {
      const k = cabled(n.id).length
      const better =
        k > most ||
        (k === most &&
          anchor !== undefined &&
          (n.position.y < anchor.position.y ||
            (n.position.y === anchor.position.y &&
              n.position.x < anchor.position.x)))
      if (better) {
        most = k
        anchor = n
      }
    }
  }
  if (!anchor) return []
  const a = box(anchor)
  const cx = a.x + a.width / 2
  const cy = a.y + a.height / 2
  const far = (n: Node) => {
    const b = box(n)
    return Math.hypot(b.x + b.width / 2 - cx, b.y + b.height / 2 - cy)
  }
  const byDistance = (list: Node[]) =>
    list
      .map((n) => ({ n, d: far(n) }))
      .sort((p, q) => p.d - q.d || (p.n.id < q.n.id ? -1 : 1))
      .map((x) => x.n)
  const part = [anchor]
  let bounds = a
  const taken = new Set([anchor.id])
  const take = (n: Node) => {
    if (taken.has(n.id)) return
    const next = union(bounds, box(n))
    if (!fits(next)) return
    taken.add(n.id)
    part.push(n)
    bounds = next
  }
  for (const n of byDistance(cabled(anchor.id).map((id) => byId.get(id)!)))
    take(n)
  const rest = cards.filter((n) => !taken.has(n.id))
  for (const n of byDistance(rest).slice(0, NEAREST)) {
    if (part.length >= OPEN_CARDS) break
    take(n)
  }
  return part
}
