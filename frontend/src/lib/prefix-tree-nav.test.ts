import { describe, expect, it } from "vitest"

import {
  ROOT,
  TREE_PAGE,
  flattenTree,
  levelFromPages,
  readRailParams,
  revealLimits,
  focusWindows,
  searchExpanded,
  searchLevels,
  treeKey,
} from "./prefix-tree-nav"
import type { Level, TreeNode, TreePage, TreeRow } from "./prefix-tree-nav"

const node = (
  id: string,
  cidr: string,
  child_count = 0,
  parent: string | null = null,
  match?: boolean
): TreeNode => ({
  id,
  cidr,
  child_count,
  parent,
  ...(match === undefined ? {} : { match }),
})

const page = (
  parent: string | null,
  results: TreeNode[],
  count = results.length,
  offset = 0
): { data: TreePage } => ({
  data: { parent, count, offset, limit: TREE_PAGE, results },
})

const shape = (rows: TreeRow[]) =>
  rows.map((r) =>
    r.kind === "node"
      ? `${"  ".repeat(r.depth)}${r.node.cidr}${r.hasChildren ? (r.expanded ? " -" : " +") : ""}`
      : r.kind === "more"
        ? `${"  ".repeat(r.depth)}[${r.remaining} ${r.before ? "earlier" : "more"}]`
        : `${"  ".repeat(r.depth)}[loading]`
  )

describe("flattenTree over lazily loaded levels", () => {
  const levels = new Map<string, Level>([
    [
      ROOT,
      levelFromPages([
        page(null, [node("a", "10.0.0.0/8", 2), node("b", "192.168.0.0/16")]),
      ])!,
    ],
  ])
  const get = (k: string) => levels.get(k)

  it("shows the roots collapsed until a node opens", () => {
    expect(shape(flattenTree(get, new Set()))).toEqual([
      "10.0.0.0/8 +",
      "192.168.0.0/16",
    ])
  })

  it("shows a loading row under an open node until its page arrives", () => {
    expect(shape(flattenTree(get, new Set(["a"])))).toEqual([
      "10.0.0.0/8 -",
      "  [loading]",
      "192.168.0.0/16",
    ])
  })

  it("nests the children once loaded, with a more row for the rest", () => {
    const withKids = new Map(levels)
    withKids.set(
      "a",
      levelFromPages([page("a", [node("c", "10.1.0.0/16", 2000, "a")], 2001)])!
    )
    const rows = flattenTree((k) => withKids.get(k), new Set(["a"]))
    expect(shape(rows)).toEqual([
      "10.0.0.0/8 -",
      "  10.1.0.0/16 +",
      "  [2000 more]",
      "192.168.0.0/16",
    ])
    const child = rows[1]
    expect(child.kind === "node" && [child.pos, child.size]).toEqual([1, 2001])
  })

  it("appends later pages in order and marks one still fetching", () => {
    const first = page("a", [node("c1", "10.0.0.0/29", 0, "a")], 3)
    const second = page("a", [node("c2", "10.0.0.8/29", 0, "a")], 3, 1)
    const lv = levelFromPages([first, second, { isFetching: true }])!
    expect(lv.nodes.map((n) => n.id)).toEqual(["c1", "c2"])
    expect(lv.total).toBe(3)
    expect(lv.loading).toBe(true)
    const rows = flattenTree(
      (k) =>
        k === ROOT
          ? levelFromPages([page(null, [node("a", "10.0.0.0/8", 3)])])
          : lv,
      new Set(["a"])
    )
    const more = rows[rows.length - 1]
    expect(more.kind === "more" && [more.remaining, more.loading]).toEqual([
      1,
      true,
    ])
  })
})

describe("search levels", () => {
  // The answer for "10.9" when 10.9.0.0/16 is hidden from the reader: the
  // match hangs from the /8, the hidden CIDR is nowhere.
  const search = {
    q: "10.9",
    count: 1,
    truncated: false,
    results: [
      node("p8", "10.0.0.0/8", 2, null, false),
      node("m", "10.9.4.0/24", 3, "p8", true),
    ],
  }

  it("opens the path, not the matches, and shows only the path", () => {
    expect(searchExpanded(search)).toEqual(["p8"])
    const levels = searchLevels(search)
    const rows = flattenTree(
      (k) => levels.get(k),
      new Set(searchExpanded(search))
    )
    expect(shape(rows)).toEqual(["10.0.0.0/8 -", "  10.9.4.0/24 +"])
    expect(JSON.stringify(rows)).not.toContain("10.9.0.0")
    // A partial level has no "more" row, though the /8 has two children.
    expect(rows.some((r) => r.kind === "more")).toBe(false)
  })

  it("loads a match's children like any node once opened", () => {
    const levels = searchLevels(search)
    levels.set(
      "m",
      levelFromPages([page("m", [node("x", "10.9.4.0/25", 0, "m")], 3)])!
    )
    const rows = flattenTree((k) => levels.get(k), new Set(["p8", "m"]))
    expect(shape(rows)).toEqual([
      "10.0.0.0/8 -",
      "  10.9.4.0/24 -",
      "    10.9.4.0/25",
      "    [2 more]",
    ])
  })
})

describe("treeKey", () => {
  const levels = new Map<string, Level>([
    [
      ROOT,
      {
        nodes: [node("a", "10.0.0.0/8", 1), node("b", "172.16.0.0/12", 1)],
        total: 2,
        loading: false,
      },
    ],
    [
      "a",
      { nodes: [node("c", "10.1.0.0/16", 0, "a")], total: 1, loading: false },
    ],
  ])
  const rows = flattenTree((k) => levels.get(k), new Set(["a"]))
  // a(open) > c, b(closed)

  it("moves, jumps and wraps nowhere", () => {
    expect(treeKey(rows, 0, "ArrowDown")).toEqual({ type: "focus", index: 1 })
    expect(treeKey(rows, 2, "ArrowDown")).toEqual({ type: "focus", index: 2 })
    expect(treeKey(rows, 0, "ArrowUp")).toEqual({ type: "focus", index: 0 })
    expect(treeKey(rows, 1, "Home")).toEqual({ type: "focus", index: 0 })
    expect(treeKey(rows, 0, "End")).toEqual({ type: "focus", index: 2 })
  })

  it("opens, steps in, closes and steps out", () => {
    expect(treeKey(rows, 2, "ArrowRight")).toEqual({ type: "expand", id: "b" })
    expect(treeKey(rows, 0, "ArrowRight")).toEqual({ type: "focus", index: 1 })
    expect(treeKey(rows, 1, "ArrowRight")).toBeNull()
    expect(treeKey(rows, 0, "ArrowLeft")).toEqual({ type: "collapse", id: "a" })
    expect(treeKey(rows, 1, "ArrowLeft")).toEqual({ type: "focus", index: 0 })
  })

  it("selects with Enter or Space and pages a more row", () => {
    expect(treeKey(rows, 1, "Enter")).toEqual({ type: "select", id: "c" })
    expect(treeKey(rows, 2, " ")).toEqual({ type: "select", id: "b" })
    const more: TreeRow[] = [
      {
        kind: "more",
        key: "a/+",
        parentKey: "a",
        depth: 1,
        remaining: 5,
        loading: false,
      },
    ]
    expect(treeKey(more, 0, "Enter")).toEqual({ type: "more", parentKey: "a" })
    expect(treeKey(rows, 0, "x")).toBeNull()
  })
})

describe("URL and reveal", () => {
  it("reads the rail params, ignoring junk", () => {
    expect(
      readRailParams({ rail: "tree", within: "p1", tree_vrf: "v1" })
    ).toEqual({
      mode: "tree",
      within: "p1",
      treeVrf: "v1",
    })
    expect(readRailParams({ rail: "nope", within: 7 })).toEqual({
      mode: null,
      within: "7",
      treeVrf: null,
    })
    expect(readRailParams({})).toEqual({
      mode: null,
      within: null,
      treeVrf: null,
    })
  })

  it("pages each level of a revealed path far enough to show it", () => {
    const limits = revealLimits({
      vrf: null,
      path: [
        { ...node("a", "10.0.0.0/8", 1), index: 0 },
        { ...node("b", "10.1.0.0/16", 2000, "a"), index: 450 },
        { ...node("c", "10.1.7.0/29", 0, "b"), index: 1500 },
      ],
    })
    expect(limits).toEqual({ a: 3 * TREE_PAGE, b: 8 * TREE_PAGE })
  })
})

describe("a prefix page's branch", () => {
  const step = (n: TreeNode, index: number) => ({ ...n, index })
  const reveal = {
    vrf: null,
    path: [
      step(node("p8", "10.0.0.0/8", 1), 0),
      step(node("p16", "10.1.0.0/16", 2000, "p8"), 0),
      step(node("p29", "10.1.7.8/29", 0, "p16"), 1450),
    ],
  }

  it("opens each level at the page that holds the path", () => {
    expect(focusWindows(reveal)).toEqual({ p16: 7 * TREE_PAGE })
    // The first page needs no window.
    expect(focusWindows({ vrf: null, path: reveal.path.slice(0, 2) })).toEqual(
      {}
    )
  })

  it("pages a window both ways", () => {
    const start = 7 * TREE_PAGE
    const sibs = Array.from({ length: TREE_PAGE }, (_, i) =>
      node(`s${i}`, `10.1.${i}.0/29`, 0, "p16")
    )
    const level = levelFromPages([page("p16", sibs, 2000, start)], start)!
    expect(level.before).toBe(start)
    const levels = new Map<string, Level>([
      [ROOT, levelFromPages([page(null, [node("p16", "10.1.0.0/16", 2000)])])!],
      ["p16", level],
    ])
    const rows = flattenTree((k) => levels.get(k), new Set(["p16"]))
    expect(shape(rows.slice(0, 2))).toEqual([
      "10.1.0.0/16 -",
      `  [${start} earlier]`,
    ])
    expect(shape(rows.slice(-1))).toEqual([
      `  [${2000 - start - TREE_PAGE} more]`,
    ])
    const first = rows[2]
    expect(first.kind === "node" && [first.pos, first.size]).toEqual([
      start + 1,
      2000,
    ])
    expect(treeKey(rows, 1, "Enter")).toEqual({
      type: "more",
      parentKey: "p16",
      before: true,
    })
  })
})
