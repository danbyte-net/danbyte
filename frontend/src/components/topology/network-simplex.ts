import type dagre from "@dagrejs/dagre"

// dagre's network-simplex ranker (@dagrejs/dagre 3.0.0, lib/rank/
// network-simplex.ts and feasible-tree.ts) on flat arrays instead of
// graphlib objects. It makes the same choices in the same order - the same
// initial ranks, the same tight tree grown in the same order, the same edge
// leaving and entering at every pivot - so it gives exactly the ranks
// dagre's own ranker gives, and with them the same layout. It is only
// faster: a pivot is a few array passes instead of graphlib calls, which
// on a 2,400-device site is most of the time a layout takes.
//
// What decides the result, and so what is kept exactly:
// - the graph's nodes and edges in graphlib's order (`nodes()`, `edges()`),
//   parallel edges merged first-seen as dagre's `simplify` merges them;
// - the tight tree's DFS: tree nodes in graphlib key order, each node's
//   in-edges then out-edges in creation order;
// - the tree's edges in insertion order (the first with a negative cut
//   value leaves) and the graph's edges in order (the first with the least
//   slack enters).
// What does not (and is free here): the order a DFS walks the tree - low
// and lim only answer "is x under y", the cut values and ranks are sums
// over the tree.

type Graph = Parameters<typeof dagre.layout>[0]

interface NodeLabel {
  rank?: number
}
interface EdgeLabel {
  weight?: number
  minlen?: number
}

/** A property key JavaScript orders first (an array index): graphlib's
 * `nodes()` is `Object.keys`, so such a node sorts before the others. */
function isArrayIndex(s: string): boolean {
  return /^(?:0|[1-9]\d*)$/.test(s) && Number(s) < 4294967295
}

/**
 * Rank `g` as dagre's "network-simplex" ranker would: every node label gets
 * the same `rank`. Pass it as the graph's `ranker`.
 */
export function networkSimplex(g: Graph): void {
  const names: string[] = g.nodes()
  const n = names.length
  if (n === 0) throw new Error("Graph must have at least one node")
  const index = new Map<string, number>()
  for (let i = 0; i < n; i++) index.set(names[i], i)

  // ── simplify: one edge per (v, w), weights summed, the longest minlen ──
  const src: number[] = []
  const dst: number[] = []
  const weight: number[] = []
  const minlen: number[] = []
  const pair = new Map<number, number>()
  for (const e of g.edges()) {
    const v = index.get(e.v)!
    const w = index.get(e.w)!
    const label = g.edge(e) as EdgeLabel
    const key = v * n + w
    let i = pair.get(key)
    if (i === undefined) {
      i = src.length
      pair.set(key, i)
      src.push(v)
      dst.push(w)
      weight.push(0)
      minlen.push(1)
    }
    weight[i] = weight[i] + label.weight!
    minlen[i] = Math.max(minlen[i], label.minlen!)
  }
  const m = src.length
  const edgeOf = (v: number, w: number) => pair.get(v * n + w)

  // Each node's edges as graphlib's nodeEdges lists them: in-edges, then
  // out-edges, each in creation order (a self-loop once, as an in-edge).
  const inList: number[][] = Array.from({ length: n }, () => [])
  const outList: number[][] = Array.from({ length: n }, () => [])
  for (let e = 0; e < m; e++) {
    inList[dst[e]].push(e)
    if (src[e] !== dst[e]) outList[src[e]].push(e)
  }
  const nodeEdges: number[][] = inList.map((l, v) => l.concat(outList[v]))

  const rank = new Float64Array(n)
  const slack = (e: number) => rank[dst[e]] - rank[src[e]] - minlen[e]

  // ── initial ranks: longest path to a sink ──────────────────────────────
  {
    const done = new Uint8Array(n)
    const stack: number[] = []
    const cursor = new Int32Array(n)
    for (let s = 0; s < n; s++) {
      if (done[s] || inList[s].length) continue
      stack.push(s)
      done[s] = 1
      while (stack.length) {
        const v = stack[stack.length - 1]
        const out = outList[v]
        if (cursor[v] < out.length) {
          const w = dst[out[cursor[v]++]]
          if (!done[w]) {
            done[w] = 1
            stack.push(w)
          }
          continue
        }
        let r = Number.POSITIVE_INFINITY
        for (const e of out) r = Math.min(r, rank[dst[e]] - minlen[e])
        rank[v] = r === Number.POSITIVE_INFINITY ? 0 : r
        stack.pop()
      }
    }
  }

  // ── the tight tree ─────────────────────────────────────────────────────
  const keyed = names.some(isArrayIndex)
  const inTree = new Uint8Array(n)
  /** Tree nodes in insertion order, or (array-index names) as keys. */
  const treeNodes: number[] = []
  const treeKeys: Record<string, number> = {}
  const treeOrder = (): number[] =>
    keyed ? Object.values(treeKeys) : treeNodes.slice()
  const addNode = (v: number) => {
    inTree[v] = 1
    treeNodes.push(v)
    if (keyed) treeKeys[names[v]] = v
  }
  /** Tree edges in insertion order; `alive` drops the ones taken out. */
  const teA: number[] = []
  const teB: number[] = []
  const alive: number[] = []
  const adj: number[][] = Array.from({ length: n }, () => [])
  const addTreeEdge = (a: number, b: number) => {
    const t = teA.length
    teA.push(a)
    teB.push(b)
    alive.push(1)
    adj[a].push(t)
    adj[b].push(t)
  }
  const dropTreeEdge = (t: number) => {
    alive[t] = 0
    for (const v of [teA[t], teB[t]]) {
      const list = adj[v]
      list.splice(list.indexOf(t), 1)
    }
  }

  const start = 0
  addNode(start)
  {
    const stackV: number[] = []
    const stackI: number[] = []
    const tightTree = (): number => {
      for (const root of treeOrder()) {
        stackV.push(root)
        stackI.push(0)
        while (stackV.length) {
          const top = stackV.length - 1
          const v = stackV[top]
          const list = nodeEdges[v]
          if (stackI[top] >= list.length) {
            stackV.pop()
            stackI.pop()
            continue
          }
          const e = list[stackI[top]++]
          const w = v === src[e] ? dst[e] : src[e]
          if (!inTree[w] && !slack(e)) {
            addNode(w)
            addTreeEdge(v, w)
            stackV.push(w)
            stackI.push(0)
          }
        }
      }
      return treeNodes.length
    }
    while (tightTree() < n) {
      let best = Number.POSITIVE_INFINITY
      let edge = -1
      for (let e = 0; e < m; e++) {
        let s = Number.POSITIVE_INFINITY
        if (inTree[src[e]] !== inTree[dst[e]]) s = slack(e)
        if (s < best) {
          best = s
          edge = e
        }
      }
      if (edge < 0) break
      const delta = inTree[src[edge]] ? slack(edge) : -slack(edge)
      for (const v of treeNodes) rank[v] += delta
    }
  }

  // ── low/lim, cut values and ranks, from the tree's root ────────────────
  const root = treeOrder()[0]
  const low = new Int32Array(n)
  const lim = new Int32Array(n)
  const parent = new Int32Array(n)
  /** Cut value of the tree edge from a node up to its parent. */
  const cut = new Float64Array(n)
  const post: number[] = []
  const pre: number[] = []

  const lowLim = () => {
    post.length = 0
    pre.length = 0
    const seen = new Uint8Array(n)
    const stackV = [root]
    const stackI = [0]
    let next = 1
    low[root] = next
    parent[root] = -1
    seen[root] = 1
    pre.push(root)
    while (stackV.length) {
      const top = stackV.length - 1
      const v = stackV[top]
      const list = adj[v]
      if (stackI[top] < list.length) {
        const t = list[stackI[top]++]
        const w = teA[t] === v ? teB[t] : teA[t]
        if (seen[w]) continue
        seen[w] = 1
        parent[w] = v
        low[w] = next
        pre.push(w)
        stackV.push(w)
        stackI.push(0)
        continue
      }
      lim[v] = next++
      post.push(v)
      stackV.pop()
      stackI.pop()
    }
  }

  const cutValues = () => {
    // Children before parents; the root (last) has no edge up.
    for (let k = 0; k < post.length - 1; k++) {
      const child = post[k]
      const up = parent[child]
      let childIsTail = true
      let ge = edgeOf(child, up)
      if (ge === undefined) {
        childIsTail = false
        ge = edgeOf(up, child)!
      }
      let value = weight[ge]
      for (const e of nodeEdges[child]) {
        const isOut = src[e] === child
        const other = isOut ? dst[e] : src[e]
        if (other === up) continue
        const pointsToHead = isOut === childIsTail
        const w = weight[e]
        value += pointsToHead ? w : -w
        // A tree edge to anything but the parent goes down to a child.
        if (inTree[other] && parent[other] === child && other !== root) {
          const c = cut[other]
          value += pointsToHead ? -c : c
        }
      }
      cut[child] = value
    }
  }

  const updateRanks = () => {
    for (let k = 1; k < pre.length; k++) {
      const v = pre[k]
      const up = parent[v]
      let e = edgeOf(v, up)
      let flipped = false
      if (e === undefined) {
        e = edgeOf(up, v)!
        flipped = true
      }
      rank[v] = rank[up] + (flipped ? minlen[e] : -minlen[e])
    }
  }

  const cutOf = (t: number) =>
    parent[teA[t]] === teB[t] ? cut[teA[t]] : cut[teB[t]]

  lowLim()
  cutValues()
  for (;;) {
    let leave = -1
    for (let t = 0; t < teA.length; t++)
      if (alive[t] && cutOf(t) < 0) {
        leave = t
        break
      }
    if (leave < 0) break

    // The leaving edge as the graph has it: v -> w.
    let v = teA[leave]
    let w = teB[leave]
    if (edgeOf(v, w) === undefined) {
      v = teB[leave]
      w = teA[leave]
    }
    let tail = v
    let flip = false
    if (lim[v] > lim[w]) {
      tail = w
      flip = true
    }
    const lo = low[tail]
    const hi = lim[tail]
    const under = (x: number) => lo <= lim[x] && lim[x] <= hi
    let enter = -1
    for (let e = 0; e < m; e++) {
      if (flip !== under(src[e]) || flip === under(dst[e])) continue
      if (enter < 0 || slack(e) < slack(enter)) enter = e
    }
    if (enter < 0)
      throw new TypeError("Reduce of empty array with no initial value")

    dropTreeEdge(leave)
    addTreeEdge(src[enter], dst[enter])
    lowLim()
    cutValues()
    updateRanks()
  }

  for (let i = 0; i < n; i++) (g.node(names[i]) as NodeLabel).rank = rank[i]
}
