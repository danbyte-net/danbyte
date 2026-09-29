import type { SpaceMapCell } from "@/lib/api"
import { parseCidr } from "@/lib/prefix-tree"

// Behaviour of the prefix space map (components/space-map.tsx), kept free of
// React so the click/zoom rules are testable on their own.

/** An existing prefix the map can link to. */
export interface SpaceMapPrefixRef {
  cidr: string
  id: string
}

/** One level of the zoom path: the block the map is drawn inside, and the most
 * specific child prefix holding it (null = the map's own prefix). */
export interface SpaceMapStep {
  cidr: string
  prefix: SpaceMapPrefixRef | null
}

export type SpaceMapAction =
  | { kind: "zoom"; cidr: string }
  | { kind: "open"; prefix: SpaceMapPrefixRef }
  | { kind: "new-prefix"; cidr: string }
  | { kind: "new-ip"; cidr: string }

/** A block can be mapped deeper only while it can still split: IPv4 above
 * /31 (the map stops at /31), IPv6 above /128. */
export function isDescendable(cidr: string): boolean {
  const c = parseCidr(cidr)
  if (!c) return false
  return c.prefixlen < (c.family === 4 ? 31 : 128)
}

/** The prefix a used cell links to: the most specific one covering it (full),
 * or the first child inside it (partial). */
export function cellPrefix(cell: SpaceMapCell): SpaceMapPrefixRef | null {
  const cidr = cell.overlap_with[0]
  return cell.used && cidr && cell.prefix_id
    ? { cidr, id: cell.prefix_id }
    : null
}

/**
 * What a cell offers, in menu order. A cell with a single action runs it on
 * click; a cell with several opens a menu.
 *
 * - free: zoom in, new child prefix, register an IP.
 * - partly used: zoom in - its free space is one level down. Only a block
 *   too small to zoom falls back to opening the child inside it.
 * - full: open the prefix it is (or sits in), then zoom in to carve up that
 *   prefix's own space.
 */
export function cellActions(
  cell: SpaceMapCell,
  { allowIp = true }: { allowIp?: boolean } = {}
): SpaceMapAction[] {
  const zoom: SpaceMapAction[] = isDescendable(cell.cidr)
    ? [{ kind: "zoom", cidr: cell.cidr }]
    : []
  const prefix = cellPrefix(cell)
  const open: SpaceMapAction[] = prefix ? [{ kind: "open", prefix }] : []
  switch (cell.state) {
    case "partial":
      return zoom.length ? zoom : open
    case "full":
      return [...open, ...zoom]
    default:
      return [
        ...zoom,
        { kind: "new-prefix", cidr: cell.cidr },
        ...(allowIp ? [{ kind: "new-ip" as const, cidr: cell.cidr }] : []),
      ]
  }
}

/** The zoom step for descending into `cell` from `current`. Zooming into a
 * full cell enters the prefix that holds it; anything else stays inside the
 * prefix the current view is already in. */
export function zoomStep(
  cell: SpaceMapCell,
  current: SpaceMapStep | undefined
): SpaceMapStep {
  const prefix =
    cell.state === "full" ? cellPrefix(cell) : (current?.prefix ?? null)
  return { cidr: cell.cidr, prefix }
}

/** Share of a block in use, as a short percentage ("25%", "<1%"). */
export function formatUsed(fraction: number): string {
  if (fraction <= 0) return "0%"
  if (fraction >= 1) return "100%"
  if (fraction < 0.01) return "<1%"
  if (fraction > 0.99) return ">99%"
  return `${Math.round(fraction * 100)}%`
}

/** The tooltip line under a cell's CIDR. */
export function cellNote(cell: SpaceMapCell): string {
  const more =
    cell.overlap_count > cell.overlap_with.length
      ? ` +${cell.overlap_count - cell.overlap_with.length}`
      : ""
  switch (cell.state) {
    case "partial":
      return `${formatUsed(cell.used_fraction)} used · ${cell.overlap_with.join(", ")}${more}`
    case "full":
      return cell.exact
        ? "Existing prefix"
        : `In ${cell.overlap_with[0] ?? "a prefix"}`
    default:
      return cell.dirty
        ? `Free · ${cell.ip_count} IP${cell.ip_count === 1 ? "" : "s"} inside`
        : "Free"
  }
}
