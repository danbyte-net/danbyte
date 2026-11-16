import {
  cloneElement,
  isValidElement,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react"
import type { ReactElement, ReactNode } from "react"
import { useQueries, useQuery } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { ChevronRight, ListFilter, ListTree, Search, X } from "lucide-react"

import { api } from "@/lib/api"
import type { VRFOption } from "@/lib/api"
import { apiAll } from "@/lib/api-all"
import { useListSearch, useSearchWriter } from "@/lib/url-filters"
import { useTablePreference } from "@/lib/use-table-preference"
import {
  GLOBAL_VRF,
  RAIL_PARAM,
  ROOT,
  TREE_PAGE,
  TREE_VRF_PARAM,
  WITHIN_PARAM,
  flattenTree,
  focusWindows,
  levelFromPages,
  readRailParams,
  revealLimits,
  searchExpanded,
  searchLevels,
  treeKey,
} from "@/lib/prefix-tree-nav"
import type {
  Level,
  RailMode,
  TreePage,
  TreeReveal,
  TreeRow,
  TreeSearch,
} from "@/lib/prefix-tree-nav"
import { cn } from "@/lib/utils"
import type { NarrowRail } from "@/components/narrow-rail-sheet"
import { FacetHeading } from "@/components/filter-rail"
import { SegmentedTabs } from "@/components/segmented-tabs"
import { Loading } from "@/components/loading"
import { QueryError } from "@/components/query-error"
import { EmptyState } from "@/components/empty-state"
import { Badge } from "@/components/ui/badge"
import { Combobox } from "@/components/ui/combobox"
import { Input } from "@/components/ui/input"
import { TruncatedText } from "@/components/ui/truncated-text"

// ─── The Filters / Tree rail of /prefixes and /ips ──────────────────────
//
// The rail shows the list's filters or a tree of one VRF's prefixes. The
// mode is in the URL (`?rail=tree`) and remembered per user and list (a
// pref row beside the table's columns); a selected node is `?within=<id>`
// and scopes the table on the server, whichever mode the rail is in - with
// the filters showing, it is the removable chip over the table.
//
// A prefix page's IPs and Child prefixes tabs use the same rail as
// navigation (`focus`): the branch the prefix sits in, from the top prefix
// above it, opened down to it with its siblings around it and its own
// children open. A picked prefix opens its page, same tab, tree still
// open; the filter box searches the branch. Both tabs share one mode (one
// pref, `rail-prefix-detail`).
//
// A VRF page's Prefixes and IPs tabs use it with the tree fixed to that VRF
// (`vrf`): its top-level prefixes on top, no VRF picker, one mode for both
// tabs (`rail-vrf-detail`) and one selection.

export type RailPage = "prefixes" | "ips" | "prefix-detail" | "vrf-detail"

const RAIL_ITEMS = [
  { value: "filters", label: "Filters" },
  { value: "tree", label: "Tree" },
] as const

/** The rail's mode: the URL's, else the user's stored one, else Filters. */
export function useRailMode(
  page: RailPage,
  active = true
): {
  mode: RailMode
  setMode: (m: RailMode) => void
} {
  const search = useListSearch()
  const write = useSearchWriter()
  const urlMode = readRailParams(search).mode
  const pref = useTablePreference(`rail-${page}`)
  const stored: RailMode = pref.order[0] === "tree" ? "tree" : "filters"
  const mode: RailMode = urlMode ?? (pref.loaded ? stored : "filters")
  // A stored Tree shows in the URL, so a copied link opens the same rail -
  // only while the rail is on screen (a prefix page's other tabs stay clean).
  useEffect(() => {
    if (active && !urlMode && pref.loaded && stored === "tree")
      write((prev) => ({ ...prev, [RAIL_PARAM]: "tree" }))
  }, [active, urlMode, pref.loaded, stored, write])
  const { setLayout } = pref
  const setMode = (m: RailMode) => {
    write((prev) => ({
      ...prev,
      [RAIL_PARAM]: m === "tree" ? "tree" : undefined,
    }))
    setLayout({ order: [m], hidden: [] })
  }
  return { mode, setMode }
}

function revealUrl(id: string) {
  return `/api/prefixes/tree/?${new URLSearchParams({ reveal: id })}`
}

/** Everything a list page needs from the rail: the mode, the selection and
 * its VRF, the params that scope the table, and the view state the tree
 * keeps while it is open (shared by the rail and the narrow-screen sheet).
 * With `focus` the tree is that prefix's branch, opened down to it, and a
 * pick opens the picked prefix's page (a prefix page's tabs); with `vrf` it
 * is that VRF's whole tree, without a picker (a VRF page's tabs, which
 * scope their tables to the VRF themselves); while `active` is false a
 * stored Tree is not written into the URL. */
export function usePrefixTreeRail(
  page: RailPage,
  {
    focus = null,
    vrf: fixedVrf = null,
    active = true,
  }: { focus?: string | null; vrf?: string | null; active?: boolean } = {}
) {
  const search = useListSearch()
  const write = useSearchWriter()
  const nav = useNavigate()
  const { mode, setMode } = useRailMode(page, active)
  const params = readRailParams(search)
  const pinned = focus ? null : fixedVrf
  const treeVrf = focus || pinned ? null : params.treeVrf
  // A prefix page's tree navigates: a `within` in its URL is ignored.
  const within = focus ? null : params.within

  const revealId = focus ?? within
  const reveal = useQuery({
    queryKey: ["prefix-tree-reveal", revealId],
    queryFn: () => api<TreeReveal>(revealUrl(revealId!)),
    enabled: !!revealId,
    retry: false,
    staleTime: 60_000,
  })
  // A VRF's tree: a selection in another VRF scopes nothing.
  const outside =
    !!within &&
    !!pinned &&
    !!reveal.data &&
    (reveal.data.vrf ?? GLOBAL_VRF) !== pinned
  const vrf = focus
    ? (reveal.data?.vrf ?? GLOBAL_VRF)
    : pinned
      ? pinned
      : within && reveal.data
        ? (reveal.data.vrf ?? GLOBAL_VRF)
        : (treeVrf ?? GLOBAL_VRF)
  const selectedCidr =
    within && reveal.data && !outside
      ? (reveal.data.path[reveal.data.path.length - 1]?.cidr ?? null)
      : null

  const select = (id: string | null) => {
    if (focus) {
      // Another prefix's page, on the same tab, the tree still open.
      if (!id || id === focus) return
      void nav({
        to: "/prefixes/$id",
        params: { id },
        search: ((prev: Record<string, unknown>) => ({
          tab: prev.tab,
          [RAIL_PARAM]: "tree",
        })) as never,
      })
      return
    }
    write((prev) => ({
      ...prev,
      [WITHIN_PARAM]: id ?? undefined,
      [TREE_VRF_PARAM]: pinned || vrf === GLOBAL_VRF ? undefined : vrf,
    }))
  }
  const setVrf = (v: string) =>
    write((prev) => ({
      ...prev,
      [WITHIN_PARAM]: undefined,
      [TREE_VRF_PARAM]: v === GLOBAL_VRF ? undefined : v,
    }))

  // The table's scope: the selection; with the tree open and nothing
  // selected, the tree's VRF. A prefix or VRF page's tab is scoped already.
  const scopeParams = useMemo((): Record<string, string> => {
    if (within && !outside) return { within }
    return mode === "tree" && !focus && !pinned ? { vrf } : {}
  }, [within, outside, mode, vrf, focus, pinned])

  const view = useTreeView(vrf, focus, revealId, reveal.data)

  return {
    mode,
    setMode,
    within,
    vrf,
    setVrf,
    select,
    selectedCidr,
    revealError: (!!within && reveal.isError) || outside,
    // The selection that scopes the table (none while it is outside).
    scoped: within && !outside ? within : null,
    /** The prefix whose page this is (a prefix page's tree). */
    focus,
    /** That page's branch failed to load. */
    focusError: focus ? reveal.error : null,
    /** The tree is one VRF's, with no picker. */
    vrfPinned: !!pinned,
    scopeParams,
    view,
  }
}

export type PrefixTreeRail = ReturnType<typeof usePrefixTreeRail>

/** Open nodes, the window of each level loaded (first offset and end), and
 * the filter box. */
function useTreeView(
  vrf: string,
  focus: string | null,
  revealId: string | null,
  reveal: TreeReveal | null | undefined
) {
  const [expanded, setExpanded] = useState<string[]>([])
  const [starts, setStarts] = useState<Record<string, number>>({})
  const [limits, setLimits] = useState<Record<string, number>>({})
  const [text, setText] = useState("")
  const [q, setQ] = useState("")
  // Open nodes while a search shows (its paths open; reset per search).
  const [searchOpen, setSearchOpen] = useState<string[]>([])

  useEffect(() => {
    const t = setTimeout(() => setQ(text.trim()), 250)
    return () => clearTimeout(t)
  }, [text])

  // A path to show opens down to it, once per prefix: a list's selection
  // from the URL pages each level far enough to show it; a prefix page
  // opens its own prefix too, each level at the page that holds the path.
  const revealed = useRef<string | null>(null)
  useEffect(() => {
    if (!revealId || !reveal || revealed.current === revealId) return
    revealed.current = revealId
    const ids = reveal.path.map((n) => n.id)
    const open = focus ? ids : ids.slice(0, -1)
    setExpanded((prev) => [...new Set([...prev, ...open])])
    if (focus) {
      const windows = focusWindows(reveal)
      setStarts((prev) => ({ ...prev, ...windows }))
      setLimits((prev) => {
        const next = { ...prev }
        for (const [k, start] of Object.entries(windows))
          next[k] = Math.max(next[k] ?? 0, start + TREE_PAGE)
        return next
      })
      return
    }
    const need = revealLimits(reveal)
    setLimits((prev) => {
      const next = { ...prev }
      for (const [k, v] of Object.entries(need)) {
        const key = k === ROOT ? `${ROOT}:${reveal.vrf ?? GLOBAL_VRF}` : k
        next[key] = Math.max(next[key] ?? TREE_PAGE, v)
      }
      return next
    })
  }, [revealId, reveal, focus])

  // The top level pages per VRF.
  const keyOf = (parentKey: string) =>
    parentKey === ROOT ? `${ROOT}:${vrf}` : parentKey
  const startOf = (parentKey: string) => starts[keyOf(parentKey)] ?? 0
  const endOf = (parentKey: string) =>
    limits[keyOf(parentKey)] ?? startOf(parentKey) + TREE_PAGE
  const more = (parentKey: string, before = false) => {
    const key = keyOf(parentKey)
    if (before)
      setStarts((prev) => ({
        ...prev,
        [key]: Math.max(0, (prev[key] ?? 0) - TREE_PAGE),
      }))
    else
      setLimits((prev) => ({
        ...prev,
        [key]: (prev[key] ?? (starts[key] ?? 0) + TREE_PAGE) + TREE_PAGE,
      }))
  }

  return {
    vrf,
    focus,
    /** A prefix page's branch: the top prefix above it (or itself). */
    branch: focus ? (reveal?.path[0] ?? null) : null,
    expanded,
    setExpanded,
    startOf,
    endOf,
    more,
    text,
    setText,
    q,
    searchOpen,
    setSearchOpen,
  }
}

type TreeView = ReturnType<typeof useTreeView>

function pageUrl(vrf: string, parent: string, offset: number) {
  const p = new URLSearchParams({
    offset: String(offset),
    limit: String(TREE_PAGE),
  })
  if (parent !== ROOT) p.set("parent", parent)
  else p.set("vrf", vrf)
  return `/api/prefixes/tree/?${p}`
}

function searchUrl(vrf: string, branch: string | null, q: string) {
  const p = new URLSearchParams(branch ? { parent: branch, q } : { vrf, q })
  return `/api/prefixes/tree/?${p}`
}

/** The tree's rows: the levels loaded for the open nodes, or, while the
 * filter box holds text, the search's paths with lazily opened matches. A
 * prefix page's tree has one top node, its branch's, and searches below it. */
export function usePrefixTreeRows(view: TreeView) {
  const { vrf, q, focus, branch } = view
  const branchId = branch?.id ?? null
  const searching = q !== ""
  const searchQ = useQuery({
    queryKey: ["prefix-tree-search", branchId ?? vrf, q],
    queryFn: () => api<TreeSearch>(searchUrl(vrf, branchId, q)),
    enabled: searching && (!focus || !!branchId),
    staleTime: 30_000,
  })
  const { setSearchOpen } = view
  useEffect(() => {
    if (searchQ.data)
      setSearchOpen([
        ...(branchId ? [branchId] : []),
        ...searchExpanded(searchQ.data),
      ])
  }, [searchQ.data, setSearchOpen, branchId])
  // The branch's top prefix as the tree's one top node.
  const top = useMemo((): Level | null => {
    if (!branch) return null
    const { index: _index, ...node } = branch
    return {
      nodes: [{ ...node, parent: null }],
      total: 1,
      loading: false,
      partial: true,
    }
  }, [branch])
  const fromSearch = useMemo(() => {
    const out = searchQ.data
      ? searchLevels(searchQ.data)
      : new Map<string, Level>()
    if (top && searchQ.data) out.set(ROOT, top)
    return out
  }, [searchQ.data, top])

  const open = searching ? view.searchOpen : view.expanded
  const parents = useMemo(
    () =>
      searching
        ? open.filter((id) => !fromSearch.has(id))
        : focus
          ? open
          : [ROOT, ...open],
    [searching, open, fromSearch, focus]
  )
  const plan = parents.flatMap((parent) => {
    const start = view.startOf(parent)
    const pages = Math.ceil((view.endOf(parent) - start) / TREE_PAGE)
    return Array.from({ length: pages }, (_, i) => ({
      parent,
      offset: start + i * TREE_PAGE,
    }))
  })
  const results = useQueries({
    queries: plan.map(({ parent, offset }) => ({
      // A node's children are the same whichever tree shows them.
      queryKey: ["prefix-tree", vrf, parent, offset],
      queryFn: () => api<TreePage>(pageUrl(vrf, parent, offset)),
      staleTime: 30_000,
    })),
  })
  const sig = results
    .map(
      (r, i) =>
        `${plan[i].parent}@${plan[i].offset}:${r.dataUpdatedAt}:${r.status}`
    )
    .join(",")
  const levels = useMemo(() => {
    const byParent = new Map<string, typeof results>()
    const startOf = new Map<string, number>()
    plan.forEach((p, i) => {
      const list = byParent.get(p.parent) ?? []
      list.push(results[i])
      byParent.set(p.parent, list)
      if (!startOf.has(p.parent)) startOf.set(p.parent, p.offset)
    })
    const out = new Map<string, Level>(fromSearch)
    if (focus && top && !searching) out.set(ROOT, top)
    for (const [parent, pages] of byParent) {
      const level = levelFromPages(pages, startOf.get(parent) ?? 0)
      if (level) out.set(parent, level)
    }
    return out
    // sig stands in for the results' identity.
  }, [sig, fromSearch, focus, top, searching])
  const openSet = useMemo(() => new Set(open), [open])
  const rows = useMemo(
    () => flattenTree((k) => levels.get(k), openSet),
    [levels, openSet]
  )
  const first = searching ? undefined : levels.get(ROOT)
  return {
    rows,
    searching,
    search: searchQ,
    rootLoading: searching
      ? searchQ.isLoading || (!!focus && !branchId)
      : !first || (first.loading && first.nodes.length === 0),
    rootError: searching ? searchQ.error : first?.error,
    empty: searching
      ? !!searchQ.data && searchQ.data.results.length === 0
      : !!first && !first.loading && first.nodes.length === 0 && !first.error,
  }
}

// ─── Pieces ─────────────────────────────────────────────────────────────

export function RailModeSwitch({
  mode,
  onChange,
}: {
  mode: RailMode
  onChange: (m: RailMode) => void
}) {
  // shrink-0: a filter rail is a flex column, and once its facets overflow
  // it would squeeze the scrolling tab row to nothing.
  return (
    <div className="shrink-0">
      <SegmentedTabs
        label="Rail"
        items={RAIL_ITEMS}
        value={mode}
        onValueChange={onChange}
      />
    </div>
  )
}

/** The selection as a chip over the table: "Within 10.1.0.0/16 ×". */
export function WithinChip({ rail }: { rail: PrefixTreeRail }) {
  if (!rail.within) return null
  const label = rail.selectedCidr ?? (rail.revealError ? "unknown prefix" : "…")
  return (
    <Badge variant="outline" className="h-6 gap-1.5 pr-1 text-xs">
      <span className="text-muted-foreground">Within</span>
      <span className="font-mono">{label}</span>
      <button
        type="button"
        aria-label="Clear prefix scope"
        onClick={() => rail.select(null)}
        className="rounded-sm text-muted-foreground hover:text-foreground"
      >
        <X className="h-3 w-3" />
      </button>
    </Badge>
  )
}

/** The tree pane: VRF, the filter box, then the hierarchy. */
export function PrefixTreePane({
  rail,
  header,
  activeFilters = 0,
  onPicked,
}: {
  rail: PrefixTreeRail
  /** The Filters / Tree switch, on top. */
  header?: ReactNode
  /** Filters still applied while the tree shows. */
  activeFilters?: number
  /** After a node is picked (the narrow sheet closes). */
  onPicked?: () => void
}) {
  const { view } = rail
  const vrfs = useQuery({
    queryKey: ["vrfs-picker"],
    queryFn: () => apiAll<VRFOption>("/api/vrfs/?picker=1"),
    staleTime: 5 * 60_000,
    enabled: !rail.focus && !rail.vrfPinned,
  })
  const vrfOptions = useMemo(
    () => [
      { value: GLOBAL_VRF, label: "Global" },
      ...(vrfs.data?.results ?? []).map((v) => ({
        value: v.id,
        label: v.name,
        color: v.color,
      })),
    ],
    [vrfs.data]
  )
  const tree = usePrefixTreeRows(view)

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-col gap-3 p-4 pb-3">
        {header}
        {!rail.focus && !rail.vrfPinned && (
          <div>
            <FacetHeading label="VRF" />
            <Combobox
              aria-label="VRF"
              value={rail.vrf}
              onChange={(v) => {
                rail.setVrf(v ?? GLOBAL_VRF)
                view.setText("")
              }}
              options={vrfOptions}
              searchPlaceholder="Search VRFs…"
              emptyText="No VRFs."
              className="h-8 text-xs"
            />
          </div>
        )}
        <div className="relative">
          <Search className="absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            aria-label="Filter prefixes"
            placeholder="Filter prefixes…"
            value={view.text}
            onChange={(e) => view.setText(e.target.value)}
            className="h-8 pl-8 font-mono text-xs placeholder:font-sans"
          />
        </div>
        {activeFilters > 0 && (
          <p className="text-[11px] whitespace-nowrap text-muted-foreground">
            {activeFilters} {activeFilters === 1 ? "filter" : "filters"} on
          </p>
        )}
      </div>
      <div className="shrink-0 px-4">
        <FacetHeading
          label="Prefixes"
          onClear={rail.within ? () => rail.select(null) : undefined}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
        {rail.focusError ? (
          <QueryError error={rail.focusError} />
        ) : tree.rootLoading ? (
          <Loading />
        ) : tree.rootError ? (
          <QueryError error={tree.rootError} />
        ) : tree.empty ? (
          <EmptyState
            title={tree.searching ? "No matches." : "No prefixes."}
            className="mx-2"
          />
        ) : (
          <>
            <PrefixTree
              rows={tree.rows}
              selected={rail.within}
              current={rail.focus}
              dimPaths={tree.searching}
              onSelect={(id) => {
                if (id === rail.focus) return
                rail.select(id)
                onPicked?.()
              }}
              onToggle={(id, open) => {
                const set = tree.searching
                  ? view.setSearchOpen
                  : view.setExpanded
                set((prev) =>
                  open
                    ? [...new Set([...prev, id])]
                    : prev.filter((x) => x !== id)
                )
              }}
              onMore={view.more}
            />
            {tree.searching && tree.search.data?.truncated && (
              <p className="px-2 pt-2 text-[11px] text-muted-foreground">
                First {tree.search.data.count} matches
              </p>
            )}
          </>
        )}
      </div>
    </div>
  )
}

/** The hierarchy as an ARIA tree: one focus stop, the active row named by
 * aria-activedescendant, the arrow keys moving through the rows on screen. */
export function PrefixTree({
  rows,
  selected,
  current: here = null,
  dimPaths = false,
  onSelect,
  onToggle,
  onMore,
}: {
  rows: TreeRow[]
  selected: string | null
  /** The prefix whose page this is: marked, never a selection. */
  current?: string | null
  /** A search: the prefixes on a path read muted, the matches don't. */
  dimPaths?: boolean
  onSelect: (id: string) => void
  onToggle: (id: string, open: boolean) => void
  onMore: (parentKey: string, before?: boolean) => void
}) {
  const base = useId()
  const [active, setActive] = useState(-1)
  const selectedIndex = rows.findIndex(
    (r) => r.kind === "node" && r.node.id === (selected ?? here)
  )
  const current =
    active >= 0 && active < rows.length
      ? active
      : selectedIndex >= 0
        ? selectedIndex
        : 0
  const idOf = (r: TreeRow) => `${base}-${r.key}`.replace(/[^\w-]/g, "_")

  const act = (index: number) => {
    setActive(index)
    const row = rows.at(index)
    if (!row) return
    const el = document.getElementById(idOf(row))
    // jsdom has no scrollIntoView.
    if (el && "scrollIntoView" in el) el.scrollIntoView({ block: "nearest" })
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    const a = treeKey(rows, current, e.key)
    if (!a) return
    e.preventDefault()
    if (a.type === "focus") act(a.index)
    else if (a.type === "expand") onToggle(a.id, true)
    else if (a.type === "collapse") onToggle(a.id, false)
    else if (a.type === "select") onSelect(a.id)
    else onMore(a.parentKey, a.before)
  }

  return (
    <div
      role="tree"
      aria-label="Prefixes"
      tabIndex={0}
      aria-activedescendant={rows[current] ? idOf(rows[current]) : undefined}
      onKeyDown={onKeyDown}
      className="group/tree rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
    >
      {rows.map((row, i) => {
        const pad = { paddingLeft: `${row.depth * 12 + 4}px` }
        const isActive = i === current
        const ring =
          isActive &&
          "group-focus-visible/tree:ring-1 group-focus-visible/tree:ring-ring"
        if (row.kind === "loading")
          return (
            <div
              key={row.key}
              id={idOf(row)}
              role="treeitem"
              aria-level={row.depth + 1}
              aria-disabled
              aria-selected={false}
              style={pad}
              className={cn(
                "flex h-7 items-center gap-1 rounded-md text-[11px] text-muted-foreground",
                ring
              )}
            >
              <span className="w-4 shrink-0" />
              Loading…
            </div>
          )
        if (row.kind === "more") {
          const n = Math.min(row.remaining, TREE_PAGE)
          const label = `Show ${n.toLocaleString()} ${row.before ? "earlier" : "more"}`
          return (
            <div
              key={row.key}
              id={idOf(row)}
              role="treeitem"
              aria-level={row.depth + 1}
              aria-selected={false}
              aria-label={label}
              style={pad}
              onClick={() => {
                setActive(i)
                if (!row.loading) onMore(row.parentKey, row.before)
              }}
              className={cn(
                "flex h-7 cursor-pointer items-center gap-1 rounded-md pr-1.5 text-[11px] whitespace-nowrap text-muted-foreground hover:bg-muted hover:text-foreground",
                ring
              )}
            >
              <span className="w-4 shrink-0" />
              {row.loading ? (
                "Loading…"
              ) : (
                <>
                  {label}
                  <span className="num ml-auto text-muted-foreground/70">
                    {row.remaining.toLocaleString()}{" "}
                    {row.before ? "above" : "left"}
                  </span>
                </>
              )}
            </div>
          )
        }
        const { node } = row
        const isSel = node.id === selected
        const isCurrent = node.id === here
        return (
          <div
            key={row.key}
            id={idOf(row)}
            role="treeitem"
            aria-level={row.depth + 1}
            aria-setsize={row.size}
            aria-posinset={row.pos}
            aria-expanded={row.hasChildren ? row.expanded : undefined}
            aria-selected={isSel}
            aria-current={isCurrent ? "page" : undefined}
            aria-label={node.cidr}
            style={pad}
            onClick={() => {
              setActive(i)
              onSelect(node.id)
            }}
            className={cn(
              "flex h-7 cursor-pointer items-center gap-1 rounded-md pr-1.5 text-xs",
              isSel
                ? "bg-primary/10 font-medium text-foreground dark:bg-primary/25"
                : isCurrent
                  ? "cursor-default font-semibold text-foreground"
                  : "hover:bg-muted",
              dimPaths &&
                node.match === false &&
                !isSel &&
                "text-muted-foreground",
              ring
            )}
          >
            {row.hasChildren ? (
              <span
                aria-hidden
                onClick={(e) => {
                  e.stopPropagation()
                  setActive(i)
                  onToggle(node.id, !row.expanded)
                }}
                className="flex size-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-muted-foreground/15 hover:text-foreground"
              >
                <ChevronRight
                  className={cn(
                    "size-3.5 transition-transform",
                    row.expanded && "rotate-90"
                  )}
                />
              </span>
            ) : (
              <span className="size-4 shrink-0" />
            )}
            <TruncatedText className="font-mono">{node.cidr}</TruncatedText>
            {isCurrent && (
              <Badge
                variant="outline"
                className="ml-1 h-4 shrink-0 px-1 text-[10px] font-normal whitespace-nowrap"
              >
                This prefix
              </Badge>
            )}
            {node.child_count > 0 && (
              <Badge
                variant="secondary"
                className="num ml-auto h-4 min-w-5 px-1 text-[10px]"
              >
                {node.child_count.toLocaleString()}
              </Badge>
            )}
          </div>
        )
      })}
    </div>
  )
}

// ─── The rail itself ─────────────────────────────────────────────────────

const RAIL_ASIDE =
  "hidden h-full w-64 shrink-0 flex-col border-r border-border bg-background lg:flex"

/** The tree pane's head: the switch, then any controls the table keeps in
 * both modes (a prefix page's Show available / Show DHCP pool). */
function treeHeader(rail: PrefixTreeRail, treeExtras?: ReactNode) {
  return (
    <>
      <RailModeSwitch mode={rail.mode} onChange={rail.setMode} />
      {treeExtras}
    </>
  )
}

/** The left rail: the page's filter rail (the switch rides on top of it as a
 * rail extra) or the tree pane. */
export function TreeOrFilterRail({
  rail,
  filterRail,
  activeFilters,
  treeExtras,
}: {
  rail: PrefixTreeRail
  filterRail: ReactNode
  activeFilters?: number
  /** Shown under the switch in Tree mode too. */
  treeExtras?: ReactNode
}) {
  if (rail.mode === "filters") return <>{filterRail}</>
  return (
    <aside aria-label="Prefix tree" className={RAIL_ASIDE}>
      <PrefixTreePane
        rail={rail}
        activeFilters={activeFilters}
        header={treeHeader(rail, treeExtras)}
      />
    </aside>
  )
}

/** A filter rail in the narrow window's sheet, full width. */
function sheetFilterRail(filterRail: ReactNode) {
  return isValidElement(filterRail)
    ? cloneElement(filterRail as ReactElement<{ className?: string }>, {
        className: "flex h-full w-full border-r-0",
      })
    : null
}

/** The same rail for a narrow window, in the shell's sheet. */
export function narrowTreeRail({
  rail,
  filterRail,
  activeFilters,
  treeExtras,
}: {
  rail: PrefixTreeRail
  filterRail: ReactNode
  activeFilters?: number
  treeExtras?: ReactNode
}): NarrowRail {
  return {
    label: rail.mode === "tree" ? "Tree" : "Filters",
    icon:
      rail.mode === "tree" ? (
        <ListTree className="h-3.5 w-3.5" />
      ) : (
        <ListFilter className="h-3.5 w-3.5" />
      ),
    content: (close: () => void) =>
      rail.mode === "tree" ? (
        <PrefixTreePane
          rail={rail}
          activeFilters={activeFilters}
          onPicked={close}
          header={treeHeader(rail, treeExtras)}
        />
      ) : (
        (sheetFilterRail(filterRail) ?? (
          <div className="p-4">
            <RailModeSwitch mode={rail.mode} onChange={rail.setMode} />
          </div>
        ))
      ),
  }
}
