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
  levelFromPages,
  readRailParams,
  revealLimits,
  rootedReveal,
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
// A prefix page's IPs and Child prefixes tabs use the same rail with the
// tree rooted at that prefix (`root`): its children on top, no VRF picker,
// the filter box searching inside it. Both tabs share one mode (one pref,
// `rail-prefix-detail`) and one selection, so a node picked on one tab
// still scopes the other.

export type RailPage = "prefixes" | "ips" | "prefix-detail"

/** The prefix a rooted tree hangs from, and its VRF (`global` for none). */
export interface TreeRoot {
  id: string
  vrf: string
}

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
 * With `root` the tree hangs from that prefix (a prefix page's tabs); while
 * `active` is false a stored Tree is not written into the URL. */
export function usePrefixTreeRail(
  page: RailPage,
  {
    root = null,
    active = true,
  }: { root?: TreeRoot | null; active?: boolean } = {}
) {
  const search = useListSearch()
  const write = useSearchWriter()
  const { mode, setMode } = useRailMode(page, active)
  const params = readRailParams(search)
  const treeVrf = root ? null : params.treeVrf
  // The root itself is no selection: the tab shows the whole prefix.
  const within = root && params.within === root.id ? null : params.within

  const reveal = useQuery({
    queryKey: ["prefix-tree-reveal", within],
    queryFn: () => api<TreeReveal>(revealUrl(within!)),
    enabled: !!within,
    retry: false,
    staleTime: 60_000,
  })
  // A rooted tree reveals only the path below its root; a selection
  // outside it reads as unknown and scopes nothing.
  const shown = useMemo(
    () =>
      reveal.data && root ? rootedReveal(reveal.data, root.id) : reveal.data,
    [reveal.data, root]
  )
  const outside = !!root && !!reveal.data && !shown
  const vrf = root
    ? root.vrf
    : within && reveal.data
      ? (reveal.data.vrf ?? GLOBAL_VRF)
      : (treeVrf ?? GLOBAL_VRF)
  const selectedCidr =
    within && shown ? (shown.path[shown.path.length - 1]?.cidr ?? null) : null

  const select = (id: string | null) =>
    write((prev) => ({
      ...prev,
      [WITHIN_PARAM]: id && id !== root?.id ? id : undefined,
      [TREE_VRF_PARAM]: root || vrf === GLOBAL_VRF ? undefined : vrf,
    }))
  const setVrf = (v: string) =>
    write((prev) => ({
      ...prev,
      [WITHIN_PARAM]: undefined,
      [TREE_VRF_PARAM]: v === GLOBAL_VRF ? undefined : v,
    }))

  // The table's scope: the selection; with the tree open and nothing
  // selected, the tree's VRF.
  // A rooted tree's tab is the root's already: no VRF scope of its own.
  const scopeParams = useMemo((): Record<string, string> => {
    if (within && !outside) return { within }
    return mode === "tree" && !root ? { vrf } : {}
  }, [within, outside, mode, vrf, root])

  const view = useTreeView(vrf, root?.id ?? null, within, shown)

  return {
    mode,
    setMode,
    within,
    vrf,
    setVrf,
    select,
    selectedCidr,
    revealError: reveal.isError || outside,
    // The selection that scopes the table (none while it is outside a root).
    scoped: within && !outside ? within : null,
    rooted: !!root,
    scopeParams,
    view,
  }
}

export type PrefixTreeRail = ReturnType<typeof usePrefixTreeRail>

/** Open nodes, how far each level has paged, and the filter box. */
function useTreeView(
  vrf: string,
  root: string | null,
  within: string | null,
  reveal: TreeReveal | null | undefined
) {
  const [expanded, setExpanded] = useState<string[]>([])
  const [limits, setLimits] = useState<Record<string, number>>({})
  const [text, setText] = useState("")
  const [q, setQ] = useState("")
  // Open nodes while a search shows (its paths open; reset per search).
  const [searchOpen, setSearchOpen] = useState<string[]>([])

  useEffect(() => {
    const t = setTimeout(() => setQ(text.trim()), 250)
    return () => clearTimeout(t)
  }, [text])

  // A selection that arrives from the URL opens the path down to it, and
  // pages each level far enough to show it - once per selection.
  const revealed = useRef<string | null>(null)
  useEffect(() => {
    if (!within || !reveal || revealed.current === within) return
    revealed.current = within
    const above = reveal.path.slice(0, -1).map((n) => n.id)
    setExpanded((prev) => [...new Set([...prev, ...above])])
    const need = revealLimits(reveal)
    setLimits((prev) => {
      const next = { ...prev }
      for (const [k, v] of Object.entries(need)) {
        const key =
          k === ROOT ? `${ROOT}:${root ?? reveal.vrf ?? GLOBAL_VRF}` : k
        next[key] = Math.max(next[key] ?? TREE_PAGE, v)
      }
      return next
    })
  }, [within, reveal, root])

  // The top level pages per VRF, or per root prefix.
  const limitKey = (parentKey: string) =>
    parentKey === ROOT ? `${ROOT}:${root ?? vrf}` : parentKey
  const limitOf = (parentKey: string) =>
    limits[limitKey(parentKey)] ?? TREE_PAGE
  const more = (parentKey: string) =>
    setLimits((prev) => ({
      ...prev,
      [limitKey(parentKey)]:
        (prev[limitKey(parentKey)] ?? TREE_PAGE) + TREE_PAGE,
    }))

  return {
    vrf,
    root,
    expanded,
    setExpanded,
    limitOf,
    more,
    text,
    setText,
    q,
    searchOpen,
    setSearchOpen,
  }
}

type TreeView = ReturnType<typeof useTreeView>

function pageUrl(
  vrf: string,
  root: string | null,
  parent: string,
  offset: number
) {
  const p = new URLSearchParams({
    offset: String(offset),
    limit: String(TREE_PAGE),
  })
  if (parent !== ROOT) p.set("parent", parent)
  else if (root) p.set("parent", root)
  else p.set("vrf", vrf)
  return `/api/prefixes/tree/?${p}`
}

function searchUrl(vrf: string, root: string | null, q: string) {
  const p = new URLSearchParams(root ? { parent: root, q } : { vrf, q })
  return `/api/prefixes/tree/?${p}`
}

/** The tree's rows: the levels loaded for the open nodes, or, while the
 * filter box holds text, the search's paths with lazily opened matches. */
export function usePrefixTreeRows(view: TreeView) {
  const { vrf, root, q } = view
  const searching = q !== ""
  const searchQ = useQuery({
    queryKey: ["prefix-tree-search", root ?? vrf, q],
    queryFn: () => api<TreeSearch>(searchUrl(vrf, root, q)),
    enabled: searching,
    staleTime: 30_000,
  })
  const { setSearchOpen } = view
  useEffect(() => {
    if (searchQ.data) setSearchOpen(searchExpanded(searchQ.data))
  }, [searchQ.data, setSearchOpen])
  const fromSearch = useMemo(
    () =>
      searchQ.data
        ? searchLevels(searchQ.data, root)
        : new Map<string, Level>(),
    [searchQ.data, root]
  )

  const open = searching ? view.searchOpen : view.expanded
  const parents = useMemo(
    () =>
      searching ? open.filter((id) => !fromSearch.has(id)) : [ROOT, ...open],
    [searching, open, fromSearch]
  )
  const plan = parents.flatMap((parent) => {
    const pages = Math.ceil(view.limitOf(parent) / TREE_PAGE)
    return Array.from({ length: pages }, (_, i) => ({
      parent,
      offset: i * TREE_PAGE,
    }))
  })
  const results = useQueries({
    queries: plan.map(({ parent, offset }) => ({
      // The top level is keyed by its VRF or root prefix; a node's children
      // are the same whichever tree shows them.
      queryKey: [
        "prefix-tree",
        parent === ROOT ? (root ?? vrf) : vrf,
        parent,
        offset,
      ],
      queryFn: () => api<TreePage>(pageUrl(vrf, root, parent, offset)),
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
    plan.forEach((p, i) => {
      const list = byParent.get(p.parent) ?? []
      list.push(results[i])
      byParent.set(p.parent, list)
    })
    const out = new Map<string, Level>(fromSearch)
    for (const [parent, pages] of byParent) {
      const level = levelFromPages(pages)
      if (level) out.set(parent, level)
    }
    return out
    // sig stands in for the results' identity.
  }, [sig, fromSearch])
  const openSet = useMemo(() => new Set(open), [open])
  const rows = useMemo(
    () => flattenTree((k) => levels.get(k), openSet),
    [levels, openSet]
  )
  const top = searching ? undefined : levels.get(ROOT)
  return {
    rows,
    searching,
    search: searchQ,
    rootLoading: searching
      ? searchQ.isLoading
      : !top || (top.loading && top.nodes.length === 0),
    rootError: searching ? searchQ.error : top?.error,
    empty: searching
      ? !!searchQ.data && searchQ.data.results.length === 0
      : !!top && !top.loading && top.nodes.length === 0 && !top.error,
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
  return (
    <SegmentedTabs
      label="Rail"
      items={RAIL_ITEMS}
      value={mode}
      onValueChange={onChange}
    />
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
    enabled: !rail.rooted,
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
        {!rail.rooted && (
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
        {tree.rootLoading ? (
          <Loading />
        ) : tree.rootError ? (
          <QueryError error={tree.rootError} />
        ) : tree.empty ? (
          <EmptyState
            title={
              tree.searching
                ? "No matches."
                : rail.rooted
                  ? "No child prefixes."
                  : "No prefixes."
            }
            className="mx-2"
          />
        ) : (
          <>
            <PrefixTree
              rows={tree.rows}
              selected={rail.within}
              dimPaths={tree.searching}
              onSelect={(id) => {
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
  dimPaths = false,
  onSelect,
  onToggle,
  onMore,
}: {
  rows: TreeRow[]
  selected: string | null
  /** A search: the prefixes on a path read muted, the matches don't. */
  dimPaths?: boolean
  onSelect: (id: string) => void
  onToggle: (id: string, open: boolean) => void
  onMore: (parentKey: string) => void
}) {
  const base = useId()
  const [active, setActive] = useState(-1)
  const selectedIndex = rows.findIndex(
    (r) => r.kind === "node" && r.node.id === selected
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
    else onMore(a.parentKey)
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
          const label = `Show ${n.toLocaleString()} more`
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
                if (!row.loading) onMore(row.parentKey)
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
                    {row.remaining.toLocaleString()} left
                  </span>
                </>
              )}
            </div>
          )
        }
        const { node } = row
        const isSel = node.id === selected
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
