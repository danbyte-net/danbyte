// ─── The prefix tree beside the prefix and IP lists ─────────────────────
//
// The left rail of /prefixes and /ips shows either the filters or a tree of
// one VRF's prefixes - and a prefix page's IPs and Child prefixes tabs the
// same tree rooted at that prefix (components/prefix-tree-rail.tsx). The tree never
// loads whole: GET /api/prefixes/tree/ answers one level at a time, paged,
// with each node's direct-child count, and a search answers the matches
// with the path above them. This module is the pure part - URL params, the
// API shapes, and turning the loaded levels into the rows the pane draws
// and the keys a keyboard presses into moves.

export type RailMode = "filters" | "tree"

/** `?rail=tree` - the rail shows the tree (absent: the filters). */
export const RAIL_PARAM = "rail"
/** `?within=<prefix id>` - the selected node; the table shows what is in it. */
export const WITHIN_PARAM = "within"
/** `?tree_vrf=<vrf id>|global` - the tree's VRF while nothing is selected. */
export const TREE_VRF_PARAM = "tree_vrf"
export const GLOBAL_VRF = "global"

/** Nodes per request, and per "Show more". */
export const TREE_PAGE = 200

/** The key of the VRF's top level in the loaded-levels map. */
export const ROOT = "__root__"

export interface TreeNode {
  id: string
  cidr: string
  /** Nearest visible prefix above; null at the VRF root. */
  parent: string | null
  child_count: number
  /** Search answers only: an outermost match (false: a prefix on its path). */
  match?: boolean
}

export interface TreePage {
  parent: string | null
  count: number
  offset: number
  limit: number
  results: TreeNode[]
}

export interface TreeSearch {
  q: string
  count: number
  truncated: boolean
  results: TreeNode[]
}

export interface TreeReveal {
  vrf: string | null
  path: (TreeNode & { index: number })[]
}

/** One parent's children as far as they have loaded. */
export interface Level {
  nodes: TreeNode[]
  /** Children the parent has (the server's count). */
  total: number
  /** A page is on its way. */
  loading: boolean
  error?: unknown
  /** Only some children, on purpose (a search path): no "Show more". */
  partial?: boolean
}

export type TreeRow =
  | {
      kind: "node"
      key: string
      node: TreeNode
      depth: number
      parentKey: string
      expanded: boolean
      hasChildren: boolean
      /** 1-based position among the loaded siblings, and their total. */
      pos: number
      size: number
    }
  | {
      kind: "more"
      key: string
      parentKey: string
      depth: number
      remaining: number
      loading: boolean
    }
  | { kind: "loading"; key: string; parentKey: string; depth: number }

/** The pages fetched for one parent → its level. */
export function levelFromPages(
  pages: readonly (
    { data?: TreePage; isFetching?: boolean; error?: unknown } | undefined
  )[]
): Level | undefined {
  if (pages.length === 0) return undefined
  const nodes: TreeNode[] = []
  let total = 0
  let loading = false
  let error: unknown
  for (const p of pages) {
    if (!p) continue
    if (p.data) {
      nodes.push(...p.data.results)
      total = p.data.count
    } else if (p.error) {
      error = p.error
    } else {
      loading = true
    }
    if (p.isFetching && !p.data) loading = true
  }
  return { nodes, total: Math.max(total, nodes.length), loading, error }
}

/** A search answer → its levels: each prefix on a path holds only the path
 * below it. Matches are not in the map - they open like any other node.
 * In a tree rooted at a prefix (`root`), what hangs from it is the top. */
export function searchLevels(
  search: TreeSearch,
  root: string | null = null
): Map<string, Level> {
  const out = new Map<string, Level>()
  for (const n of search.results) {
    const key = n.parent === null || n.parent === root ? ROOT : n.parent
    let level = out.get(key)
    if (!level) {
      level = { nodes: [], total: 0, loading: false, partial: true }
      out.set(key, level)
    }
    level.nodes.push(n)
    level.total = level.nodes.length
  }
  return out
}

/** The prefixes a search opens: every one on a path (not the matches). */
export function searchExpanded(search: TreeSearch): string[] {
  return search.results.filter((n) => !n.match).map((n) => n.id)
}

/** The loaded tree → the rows on screen, depth first. A node shows its
 * children when it is expanded: those loaded, then a "Show more" row while
 * the server has more, or a loading row before the first page arrives. */
export function flattenTree(
  getLevel: (key: string) => Level | undefined,
  expanded: ReadonlySet<string>,
  root: string = ROOT
): TreeRow[] {
  const rows: TreeRow[] = []
  const walk = (parentKey: string, depth: number) => {
    const level = getLevel(parentKey)
    if (!level || (level.nodes.length === 0 && level.loading)) {
      if (parentKey !== root)
        rows.push({ kind: "loading", key: `${parentKey}/…`, parentKey, depth })
      return
    }
    const size = level.partial ? level.nodes.length : level.total
    level.nodes.forEach((node, i) => {
      const hasChildren = node.child_count > 0
      const open = hasChildren && expanded.has(node.id)
      rows.push({
        kind: "node",
        key: node.id,
        node,
        depth,
        parentKey,
        expanded: open,
        hasChildren,
        pos: i + 1,
        size,
      })
      if (open) walk(node.id, depth + 1)
    })
    const remaining = level.total - level.nodes.length
    if (!level.partial && remaining > 0)
      rows.push({
        kind: "more",
        key: `${parentKey}/+`,
        parentKey,
        depth,
        remaining,
        loading: level.loading,
      })
  }
  walk(root, 0)
  return rows
}

export type TreeAction =
  | { type: "focus"; index: number }
  | { type: "expand"; id: string }
  | { type: "collapse"; id: string }
  | { type: "select"; id: string }
  | { type: "more"; parentKey: string }

/** What a key does on the row at `index` (the WAI-ARIA tree pattern):
 * Up/Down move, Home/End jump, Right opens or steps into a node, Left
 * closes it or steps out to its parent, Enter or Space selects. */
export function treeKey(
  rows: readonly TreeRow[],
  index: number,
  key: string
): TreeAction | null {
  if (rows.length === 0) return null
  const i = Math.min(Math.max(index, 0), rows.length - 1)
  const row = rows[i]
  switch (key) {
    case "ArrowDown":
      return { type: "focus", index: Math.min(i + 1, rows.length - 1) }
    case "ArrowUp":
      return { type: "focus", index: Math.max(i - 1, 0) }
    case "Home":
      return { type: "focus", index: 0 }
    case "End":
      return { type: "focus", index: rows.length - 1 }
    case "ArrowRight":
      if (row.kind !== "node" || !row.hasChildren) return null
      if (!row.expanded) return { type: "expand", id: row.node.id }
      return i + 1 < rows.length ? { type: "focus", index: i + 1 } : null
    case "ArrowLeft": {
      if (row.kind === "node" && row.expanded)
        return { type: "collapse", id: row.node.id }
      const parent = rows.findIndex(
        (r) => r.kind === "node" && r.node.id === row.parentKey
      )
      return parent >= 0 ? { type: "focus", index: parent } : null
    }
    case "Enter":
    case " ":
      if (row.kind === "node") return { type: "select", id: row.node.id }
      if (row.kind === "more") return { type: "more", parentKey: row.parentKey }
      return null
    default:
      return null
  }
}

/** How many children of each parent on a revealed path must load for the
 * path to show: up to the step's own position, in whole pages. */
export function revealLimits(reveal: TreeReveal): Record<string, number> {
  const out: Record<string, number> = {}
  for (const step of reveal.path) {
    const need = Math.ceil((step.index + 1) / TREE_PAGE) * TREE_PAGE
    if (need > TREE_PAGE) out[step.parent ?? ROOT] = need
  }
  return out
}

/** A reveal path for a tree rooted at the prefix `root`: only the steps
 * below it, the first one at the top. Null when the selection is the root
 * itself or not inside it. */
export function rootedReveal(
  reveal: TreeReveal,
  root: string
): TreeReveal | null {
  const at = reveal.path.findIndex((s) => s.id === root)
  if (at < 0 || at === reveal.path.length - 1) return null
  const path = reveal.path
    .slice(at + 1)
    .map((s, i) => (i === 0 ? { ...s, parent: null } : s))
  return { vrf: reveal.vrf, path }
}

/** The rail's state in the URL. */
export function readRailParams(search: Record<string, unknown>): {
  mode: RailMode | null
  within: string | null
  treeVrf: string | null
} {
  const text = (v: unknown) =>
    typeof v === "string" ? v : typeof v === "number" ? String(v) : ""
  const rail = text(search[RAIL_PARAM])
  return {
    mode: rail === "tree" ? "tree" : rail === "filters" ? "filters" : null,
    within: text(search[WITHIN_PARAM]) || null,
    treeVrf: text(search[TREE_VRF_PARAM]) || null,
  }
}
