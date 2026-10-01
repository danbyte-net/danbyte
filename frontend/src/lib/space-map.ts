import type { SpaceMapCell } from "@/lib/api"
import { bigIntToIp, contains, parseCidr } from "@/lib/prefix-tree"

// Behaviour of the prefix space map (components/space-map.tsx), kept free of
// React so the click/zoom rules are testable on their own.

/** An existing prefix the map can link to. */
export interface SpaceMapPrefixRef {
  cidr: string
  id: string
}

export type SpaceMapAction =
  | { kind: "zoom"; cidr: string }
  | { kind: "open"; prefix: SpaceMapPrefixRef }
  | { kind: "new-prefix"; cidr: string }
  | { kind: "new-ip"; cidr: string }

/** A parsed CIDR, or null when it doesn't parse or its prefix length is out
 * of range for its family. */
function parsed(cidr: string) {
  const c = parseCidr(cidr)
  if (!c || !Number.isInteger(c.prefixlen)) return null
  return c.prefixlen <= (c.family === 4 ? 32 : 128) ? c : null
}

/** A block can be mapped deeper only while it can still split: IPv4 above
 * /31 (the map stops at /31), IPv6 above /128. */
export function isDescendable(cidr: string): boolean {
  const c = parsed(cidr)
  if (!c) return false
  return c.prefixlen < (c.family === 4 ? 31 : 128)
}

/** Separates the blocks of a zoom path in the `?zoom=` search param. */
const ZOOM_SEP = ","

/**
 * The zoom path from the `?zoom=` search param: the blocks the operator
 * zoomed through, outermost first. Each must sit strictly inside the one
 * before it (the first inside `root`); the path is cut at the first block
 * that doesn't, so a stale or hand-edited link still lands somewhere real.
 */
export function parseZoomPath(raw: unknown, root: string): string[] {
  if (typeof raw !== "string" || !raw) return []
  let outer = parsed(root)
  const path: string[] = []
  for (const part of raw.split(ZOOM_SEP)) {
    const cidr = part.trim()
    const c = parsed(cidr)
    if (!outer || !c || !contains(outer, c) || !isDescendable(cidr)) break
    path.push(cidr)
    outer = c
  }
  return path
}

/** Does block `outer` hold `inner`, or is it the same block? */
export function holdsBlock(outer: string, inner: string): boolean {
  if (outer === inner) return true
  const o = parsed(outer)
  const i = parsed(inner)
  return !!o && !!i && contains(o, i)
}

/** The block of `len` bits that holds `cidr` (its supernet), or null when
 * `len` isn't shorter than the block's own length. */
export function supernetOf(cidr: string, len: number): string | null {
  const c = parsed(cidr)
  if (!c || !Number.isInteger(len) || len < 0 || len >= c.prefixlen) return null
  const host = BigInt((c.family === 4 ? 32 : 128) - len)
  return `${bigIntToIp((c.start >> host) << host, c.family)}/${len}`
}

/**
 * The blocks a prefix's map can zoom out through, one bit at a time:
 * from `outer` (its outermost master) down to the prefix itself, outermost
 * first. Empty when `outer` doesn't hold it.
 */
export function outerLevels(cidr: string, outer: string): string[] {
  const c = parsed(cidr)
  const o = parsed(outer)
  if (!c || !o || !contains(o, c)) return []
  const levels: string[] = []
  for (let len = o.prefixlen; len < c.prefixlen; len++) {
    const block = supernetOf(cidr, len)
    if (block) levels.push(block)
  }
  return [...levels, cidr]
}

/** The `?out=` view of a prefix's map: a block that holds the prefix, inside
 * its outermost master - or null for a value that isn't one. */
export function parseOutView(
  raw: unknown,
  cidr: string,
  outer: string | null
): string | null {
  if (typeof raw !== "string" || !raw || !outer) return null
  return outerLevels(cidr, outer).slice(0, -1).includes(raw) ? raw : null
}

/** The `?zoom=` value for a path (undefined drops the param). */
export function zoomParam(path: string[]): string | undefined {
  return path.length ? path.join(ZOOM_SEP) : undefined
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
 * - free: zoom in, new child prefix, register an IP (the last two only when
 *   the user may add them).
 * - partly used: zoom in - its free space is one level down. Only a block
 *   too small to zoom falls back to opening the child inside it.
 * - full: open the prefix it is (or sits in), then zoom in to carve up that
 *   prefix's own space.
 */
export function cellActions(
  cell: SpaceMapCell,
  {
    allowPrefix = true,
    allowIp = true,
  }: { allowPrefix?: boolean; allowIp?: boolean } = {}
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
        ...(allowPrefix
          ? [{ kind: "new-prefix" as const, cidr: cell.cidr }]
          : []),
        ...(allowIp ? [{ kind: "new-ip" as const, cidr: cell.cidr }] : []),
      ]
  }
}

/** Share of a block in use, as a short percentage ("25%", "<1%"). */
export function formatUsed(fraction: number): string {
  if (fraction <= 0) return "0%"
  if (fraction >= 1) return "100%"
  if (fraction < 0.01) return "<1%"
  if (fraction > 0.99) return ">99%"
  return `${Math.round(fraction * 100)}%`
}

/** The IP ranges a cell holds, as a tooltip clause (or ""). */
function rangeNote(cell: SpaceMapCell): string {
  const n = cell.range_count
  if (n === 0) return ""
  if (n === 1 && cell.ranges.length) return ` · range ${cell.ranges[0]}`
  return ` · ${n} ranges`
}

/** The tooltip line under a cell's CIDR. */
export function cellNote(cell: SpaceMapCell): string {
  const more =
    cell.overlap_count > cell.overlap_with.length
      ? ` +${cell.overlap_count - cell.overlap_with.length}`
      : ""
  switch (cell.state) {
    case "partial":
      return `${formatUsed(cell.used_fraction)} used · ${cell.overlap_with.join(", ")}${more}${rangeNote(cell)}`
    case "full":
      return cell.exact
        ? "Existing prefix"
        : `In ${cell.overlap_with[0] ?? "a prefix"}`
    default:
      return `Free${
        cell.dirty
          ? ` · ${cell.ip_count} IP${cell.ip_count === 1 ? "" : "s"} inside`
          : ""
      }${rangeNote(cell)}`
  }
}
