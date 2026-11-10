// Free space in the prefix list (GET /api/prefixes/?free=1, api.prefix_space).
// The server sends the free blocks of the parents on each page; this module
// lays them out as rows between the real prefixes.

import type { Prefix } from "@/lib/api"
import { parseCidr } from "@/lib/prefix-tree"
import type { NestedPrefix } from "@/lib/prefix-tree"

/** One free block, as the list and /api/prefixes/available/ send it. */
export interface FreeBlock {
  kind?: "free"
  cidr: string
  prefixlen: number
  family: 4 | 6
  /** The parent's id (the list), or `{id, cidr}` (available). */
  parent: string | { id: string; cidr: string }
  vrf: string | null | { id: string; name: string }
}

/** What a free row carries on top of the parent-shaped fields. */
export interface FreeMark {
  /** "block" - a free block; "more" - the "+ N more free" row. */
  kind: "block" | "more"
  cidr: string
  prefixlen: number
  family: 4 | 6
  parentId: string
  /** "more" rows: how many blocks are not shown. */
  more?: number
  /** "more" rows: the rest can be fetched (else the row links to the map). */
  expandable?: boolean
  /** The one block Next available picked. */
  next?: boolean
}

export type ListRow = NestedPrefix & { _free?: FreeMark }

export const isFreeRow = (r: { _free?: FreeMark }): boolean => !!r._free

/** The parent id of a free block, whichever shape it came in. */
export function blockParent(b: FreeBlock): string {
  return typeof b.parent === "string" ? b.parent : b.parent.id
}

/** "512 addresses", or "/64s" under the IPv6 floor. */
export function freeSizeLabel(prefixlen: number, family: 4 | 6): string {
  if (family === 6 && prefixlen <= 64) {
    const n = 1n << BigInt(64 - prefixlen)
    return n === 1n ? "one /64" : `${n.toLocaleString("en-US")} /64s`
  }
  const n = 1n << BigInt((family === 4 ? 32 : 128) - prefixlen)
  return `${n.toLocaleString("en-US")} ${n === 1n ? "address" : "addresses"}`
}

/** `/29`, `29` → 29; anything else → null. */
export function parseSize(text: string): number | null {
  const m = /^\/?(\d{1,3})$/.exec(text.trim())
  if (!m) return null
  const n = Number(m[1])
  return n <= 128 ? n : null
}

/** A typed scope: a network with its length and no host bits. */
export function scopeError(text: string): string | null {
  const t = text.trim()
  if (!t) return null
  const c = parseCidr(t)
  if (!c || !t.includes("/")) return "A prefix, e.g. 10.20.0.0/19."
  return null
}

/** The sizes a free block can be carved into at its start: its own length
 * down to /32 (IPv4) or /128, IPv6 stepping through /64 and the usual
 * longer ones. */
export function carveSizes(cidr: string): number[] {
  const c = parseCidr(cidr)
  if (!c) return []
  const out: number[] = []
  if (c.family === 4) {
    for (let n = c.prefixlen; n <= 32; n++) out.push(n)
    return out
  }
  for (let n = c.prefixlen; n <= 64; n++) out.push(n)
  for (const n of [80, 96, 112, 120, 124, 126, 127, 128])
    if (n > Math.max(64, c.prefixlen - 1) && n >= c.prefixlen) out.push(n)
  return out
}

/** The network address of `cidr` with a new length. */
export function withLength(cidr: string, length: number): string {
  const slash = cidr.indexOf("/")
  return `${slash < 0 ? cidr : cidr.slice(0, slash)}/${length}`
}

const startOf = (cidr: string): bigint => parseCidr(cidr)?.start ?? 0n

function freeRow(parent: NestedPrefix, mark: FreeMark, depth: number): ListRow {
  return {
    ...parent,
    id: `free:${parent.id}:${mark.kind}:${mark.cidr}`,
    cidr: mark.cidr,
    family: mark.family,
    status: null,
    description: "",
    gateway: null,
    vlan: null,
    tags: [],
    custom_fields: {},
    utilisation_pct: null,
    _depth: depth,
    _parentId: parent.id,
    _free: mark,
  }
}

export interface LayoutOpts {
  /** Free blocks per parent id, in address order. */
  blocks: Map<string, FreeBlock[]>
  /** How many free blocks each parent has in all. */
  totals: Record<string, number>
  /** Parents whose rest the reader asked for (fetched into `blocks`). */
  expanded: Set<string>
  /** Rows a collapsed parent shows. */
  collapsed: number
  /** A size is set: only parents with such a block, each followed by its
   * blocks (the children stay out of the way). */
  sized: boolean
  /** Next available: only the first block of all, marked. */
  nextOnly: boolean
}

/**
 * The nested rows with free rows laid in.
 *
 * Without a size, a parent's free blocks sit between its children in
 * address order, one level deeper, and a parent with more than `collapsed`
 * ends with "+ N more free". With a size, the list is the parents that have
 * such a block, each followed by its blocks. Next available keeps only the
 * first block of all (in table order) and its parent.
 */
export function layoutFreeRows(rows: NestedPrefix[], o: LayoutOpts): ListRow[] {
  const shownFor = (p: NestedPrefix): FreeBlock[] => {
    const all = o.blocks.get(p.id) ?? []
    return o.expanded.has(p.id) ? all : all.slice(0, o.collapsed)
  }
  const moreRow = (p: NestedPrefix, shown: number, depth: number) => {
    const total = o.totals[p.id] ?? 0
    const fetched = o.blocks.get(p.id)?.length ?? 0
    if (total <= shown) return null
    return freeRow(
      p,
      {
        kind: "more",
        cidr: p.cidr,
        prefixlen: 0,
        family: (p.family ?? 4),
        parentId: p.id,
        more: total - shown,
        expandable:
          !o.expanded.has(p.id) && (fetched < total || shown < fetched),
      },
      depth
    )
  }
  const markOf = (b: FreeBlock): FreeMark => ({
    kind: "block",
    cidr: b.cidr,
    prefixlen: b.prefixlen,
    family: b.family,
    parentId: blockParent(b),
  })

  if (o.sized && o.nextOnly) {
    // The lowest block in the first VRF (in table order) that has one.
    let pick: { p: NestedPrefix; b: FreeBlock; at: bigint } | null = null
    for (const p of rows) {
      const list = o.blocks.get(p.id)
      if (!list?.length) continue
      const first = list[0]
      const vrf = p.vrf?.id ?? null
      if (pick && (pick.p.vrf?.id ?? null) !== vrf) break
      const at = startOf(first.cidr)
      if (!pick || (first.family === pick.b.family && at < pick.at))
        pick = { p, b: first, at }
    }
    if (!pick) return []
    return [
      { ...pick.p, _depth: 0 },
      freeRow(pick.p, { ...markOf(pick.b), next: true }, 1),
    ]
  }

  if (o.sized) {
    const out: ListRow[] = []
    for (const p of rows) {
      if (!(o.totals[p.id] > 0)) continue
      const shown = shownFor(p)
      out.push({ ...p, _depth: 0 })
      for (const b of shown) out.push(freeRow(p, markOf(b), 1))
      const more = moreRow(p, shown.length, 1)
      if (more) out.push(more)
    }
    return out
  }

  // Interleave by address: each parent's queue of free blocks drains before
  // the first child that starts after a block, and at the end of its subtree.
  type Open = { row: NestedPrefix; queue: FreeBlock[]; shown: number }
  const out: ListRow[] = []
  const stack: Open[] = []
  const drain = (open: Open, before: bigint | null) => {
    while (
      open.queue.length &&
      (before === null || startOf(open.queue[0].cidr) < before)
    ) {
      const b = open.queue.shift()!
      out.push(freeRow(open.row, markOf(b), open.row._depth + 1))
    }
  }
  const close = (open: Open) => {
    drain(open, null)
    const more = moreRow(open.row, open.shown, open.row._depth + 1)
    if (more) out.push(more)
  }
  for (const row of rows) {
    // Rows come depth-first, so the row's parent is on the stack; whatever
    // sits above it has ended (a root row, or a new VRF, empties it).
    while (stack.length && stack[stack.length - 1].row.id !== row._parentId)
      close(stack.pop()!)
    if (stack.length) drain(stack[stack.length - 1], startOf(row.cidr))
    out.push(row)
    const queue = [...shownFor(row)]
    stack.push({ row, queue, shown: queue.length })
  }
  while (stack.length) close(stack.pop()!)
  return out
}

/** Group free blocks by parent, keeping their order. */
export function blocksByParent(blocks: FreeBlock[]): Map<string, FreeBlock[]> {
  const out = new Map<string, FreeBlock[]>()
  for (const b of blocks) {
    const id = blockParent(b)
    const list = out.get(id)
    if (list) list.push(b)
    else out.set(id, [b])
  }
  return out
}

/** The prefix fields a free row's Create opens the form with. */
export function createSearch(row: ListRow): {
  cidr: string
  vrf: string | undefined
  site: string | undefined
  location: undefined
  free: string
} {
  return {
    cidr: row.cidr,
    vrf: (row as Prefix).vrf?.id ?? undefined,
    site: (row as Prefix).site?.id ?? undefined,
    location: undefined,
    free: row.cidr,
  }
}
