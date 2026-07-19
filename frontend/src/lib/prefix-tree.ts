import type { Prefix } from "@/lib/api"

// CIDR → numeric [start, end, prefixlen] (BigInt to handle IPv6 cleanly).
// Returns null for unparseable input — the caller treats null as "no
// containment, render as root."
export interface Cidr {
  start: bigint
  end: bigint
  prefixlen: number
  family: 4 | 6
}

export function parseCidr(cidr: string): Cidr | null {
  const slash = cidr.indexOf("/")
  if (slash < 0) return null
  const addr = cidr.slice(0, slash)
  const prefixlen = Number(cidr.slice(slash + 1))
  if (!Number.isFinite(prefixlen) || prefixlen < 0) return null

  if (addr.includes(":")) {
    // IPv6
    const n = ipv6ToBigInt(addr)
    if (n === null) return null
    const total = 128n
    const hostBits = total - BigInt(prefixlen)
    const network = (n >> hostBits) << hostBits
    const broadcast = network | ((1n << hostBits) - 1n)
    return { start: network, end: broadcast, prefixlen, family: 6 }
  }
  // IPv4
  const parts = addr.split(".")
  if (parts.length !== 4) return null
  let n = 0n
  for (const p of parts) {
    const v = Number(p)
    if (!Number.isFinite(v) || v < 0 || v > 255) return null
    n = (n << 8n) | BigInt(v)
  }
  const hostBits = 32n - BigInt(prefixlen)
  const network = (n >> hostBits) << hostBits
  const broadcast = network | ((1n << hostBits) - 1n)
  return { start: network, end: broadcast, prefixlen, family: 4 }
}

function ipv6ToBigInt(addr: string): bigint | null {
  // Minimal IPv6 parser — handles :: shorthand. We don't need to handle
  // IPv4-mapped notation here.
  const parts = addr.split("::")
  if (parts.length > 2) return null
  const left = parts[0] ? parts[0].split(":") : []
  const right = parts.length === 2 && parts[1] ? parts[1].split(":") : []
  const missing = 8 - left.length - right.length
  if (missing < 0) return null
  const groups = [...left, ...Array(missing).fill("0"), ...right]
  if (groups.length !== 8) return null
  let n = 0n
  for (const g of groups) {
    const v = parseInt(g, 16)
    if (!Number.isFinite(v) || v < 0 || v > 0xffff) return null
    n = (n << 16n) | BigInt(v)
  }
  return n
}

export function contains(parent: Cidr, child: Cidr): boolean {
  return (
    parent.family === child.family &&
    parent.prefixlen < child.prefixlen &&
    parent.start <= child.start &&
    parent.end >= child.end
  )
}

// BigInt → printable IP. IPv6 collapses its longest zero run to "::".
export function bigIntToIp(n: bigint, family: 4 | 6): string {
  if (family === 4) {
    return [24n, 16n, 8n, 0n]
      .map((sh) => ((n >> sh) & 255n).toString())
      .join(".")
  }
  const groups: number[] = []
  for (let i = 7n; i >= 0n; i--) groups.push(Number((n >> (i * 16n)) & 0xffffn))
  // find the longest run of zero groups (length >= 2) to compress
  let bestStart = -1
  let bestLen = 0
  let curStart = -1
  let curLen = 0
  for (let i = 0; i < 8; i++) {
    if (groups[i] === 0) {
      if (curStart < 0) curStart = i
      curLen++
      if (curLen > bestLen) {
        bestLen = curLen
        bestStart = curStart
      }
    } else {
      curStart = -1
      curLen = 0
    }
  }
  const hex = groups.map((g) => g.toString(16))
  if (bestLen < 2) return hex.join(":")
  const head = hex.slice(0, bestStart).join(":")
  const tail = hex.slice(bestStart + bestLen).join(":")
  return `${head}::${tail}`
}

// A bare IP address → BigInt (v4 or v6), or null if unparseable. Lets callers
// test range containment numerically (e.g. is this IP inside an IP range?).
export function ipToBigInt(addr: string): bigint | null {
  if (addr.includes(":")) return ipv6ToBigInt(addr)
  const parts = addr.split(".")
  if (parts.length !== 4) return null
  let n = 0n
  for (const p of parts) {
    const v = Number(p)
    if (!Number.isFinite(v) || v < 0 || v > 255) return null
    n = (n << 8n) | BigInt(v)
  }
  return n
}

// First (network) and last (broadcast) address of a CIDR, as IP strings.
// e.g. "10.0.10.0/24" → { start: "10.0.10.0", end: "10.0.10.255" }.
export function cidrHostRange(
  cidr: string
): { start: string; end: string } | null {
  const c = parseCidr(cidr)
  if (!c) return null
  return {
    start: bigIntToIp(c.start, c.family),
    end: bigIntToIp(c.end, c.family),
  }
}

/** Every usable host address in a CIDR, as BigInts, applying the same
 * network/broadcast trim as Python's `net.hosts()`: v4 `/≤30` drops the network
 * + broadcast; v6 `/≤126` drops only the network (no broadcast); /31·/32 and
 * /127·/128 keep all (point-to-point / host). Returns null if unparseable or if
 * the host count exceeds `cap` (too big to enumerate — e.g. a v6 /64). The cap
 * mirrors the backend `ENUMERABLE_HOST_CAP`. */
export function enumerableHostInts(
  cidr: string,
  cap = 4096
): { ints: bigint[]; family: 4 | 6 } | null {
  const c = parseCidr(cidr)
  if (!c) return null
  let lo = c.start
  let hi = c.end
  if (c.family === 4 && c.prefixlen <= 30) {
    lo = c.start + 1n
    hi = c.end - 1n
  } else if (c.family === 6 && c.prefixlen <= 126) {
    lo = c.start + 1n // v6 excludes only the subnet-router anycast (::0)
  }
  if (hi < lo) return { ints: [], family: c.family }
  if (hi - lo + 1n > BigInt(cap)) return null
  const ints: bigint[] = []
  for (let n = lo; n <= hi; n++) ints.push(n)
  return { ints, family: c.family }
}

export interface NestedPrefix extends Prefix {
  /** 0-based depth: top-level prefixes are 0, children are 1, etc. */
  _depth: number
  /** Parent prefix ID within the same VRF, or null at the root. */
  _parentId: string | null
}

// Walk a list of prefixes (assumed already filtered to the active tenant)
// and annotate each with its depth + parent id within the same VRF. The
// result preserves the input order at each level; callers can sort the
// list however they like before calling and the nesting will follow.
export function annotateNesting(prefixes: Prefix[]): NestedPrefix[] {
  // Group by VRF so containment can't accidentally cross routing contexts.
  const byVrf = new Map<string, Prefix[]>()
  for (const p of prefixes) {
    const key = p.vrf?.id ?? "__global__"
    const list = byVrf.get(key)
    if (list) list.push(p)
    else byVrf.set(key, [p])
  }

  const annotated = new Map<string, NestedPrefix>()
  for (const [, list] of byVrf) {
    // Sort by prefixlen ascending so each prefix encounters its potential
    // parents BEFORE itself. CIDR string is the secondary key — matches
    // the visual order users expect.
    const enriched = list
      .map((p) => ({ p, c: parseCidr(p.cidr) }))
      .filter((x) => x.c !== null) as { p: Prefix; c: Cidr }[]
    // Sort by start address asc, then prefixlen asc. Sorting by prefixlen
    // alone breaks the stack walk when multiple top-level prefixes share
    // the same prefixlen — pushing a peer pops the previous one, leaving
    // later descendants without their true ancestor. Address-first keeps
    // every potential parent on the stack until its range is exhausted.
    enriched.sort((a, b) => {
      if (a.c.start !== b.c.start) return a.c.start < b.c.start ? -1 : 1
      return a.c.prefixlen - b.c.prefixlen
    })

    // Track active ancestors via a stack — a new prefix's parent is the
    // deepest entry on the stack that still contains it. O(n) amortised
    // since each entry is pushed and popped once.
    const stack: { id: string; c: Cidr; depth: number }[] = []
    for (const { p, c } of enriched) {
      while (stack.length && !contains(stack[stack.length - 1].c, c)) {
        stack.pop()
      }
      const parent = stack.length ? stack[stack.length - 1] : null
      const depth = parent ? parent.depth + 1 : 0
      annotated.set(p.id, {
        ...p,
        _depth: depth,
        _parentId: parent ? parent.id : null,
      })
      stack.push({ id: p.id, c, depth })
    }
  }

  // Re-emit in the order the parent prefixes/groupings will expect —
  // depth-first per VRF, parents before children. Sorting the table
  // itself can break this; callers should keep grouping intact.
  const result: NestedPrefix[] = []
  const byParent = new Map<string | null, NestedPrefix[]>()
  for (const n of annotated.values()) {
    const arr = byParent.get(n._parentId)
    if (arr) arr.push(n)
    else byParent.set(n._parentId, [n])
  }
  function walk(parentId: string | null) {
    const children = byParent.get(parentId) ?? []
    children.sort((a, b) => a.cidr.localeCompare(b.cidr))
    for (const c of children) {
      result.push(c)
      walk(c.id)
    }
  }
  walk(null)
  return result
}
