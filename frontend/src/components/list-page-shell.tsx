import { usePageTitle } from "@/lib/page-title"
import { useCallback, useId, useMemo, useState } from "react"
import type { ReactNode } from "react"
import { Link } from "@tanstack/react-router"
import type { LinkProps } from "@tanstack/react-router"
import { AlertTriangle, ChevronLeft, ChevronRight, Search } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import {
  NarrowRailSheet,
  type NarrowRail,
} from "@/components/narrow-rail-sheet"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Loading } from "@/components/loading"
import { QueryError } from "@/components/query-error"
import { SavedViews, type SavedViewsProps } from "@/components/saved-views"
import { FacetVisibilityProvider } from "@/components/filter-rail"
import { useListFacetPrefs } from "@/lib/use-facet-prefs"
import { ListToolbarContext } from "@/lib/list-toolbar"
import type { ListToolbar } from "@/lib/list-toolbar"
import {
  ListCapContext,
  listCap,
  listCapCount,
  listCapNotice,
} from "@/lib/list-cap"

// ─── The canonical list-page chrome ──────────────────────────────────────
//
// Every `/things` list page shares the same shell: an optional filter rail
// on the left, then a header bar (title + count chip + actions) over a
// scrollable body: a toolbar row (filters, saved views, search - and the
// table's own Download / Columns, which the table moves up into it, #507),
// then the content, switching loading → error → content.
// ListPageShell owns all of it so the ~70 list routes can't drift on header
// height, rail wiring, search styling, the loading/error triad, or - the
// bug that keeps recurring - the `min-h-0` that makes the body actually
// scroll.
//
//   const { rail, filteredRows } = useTableFilters(columns, rows)
//   return (
//     <ListPageShell
//       title="Manufacturers"
//       count={filteredRows.length}
//       rail={rail}
//       search={{ value: q, onChange: setQ, placeholder: "Filter…" }}
//       add={canAdd && <Button size="sm" asChild><Link to="/manufacturers/new">Add manufacturer</Link></Button>}
//       actions={<TableActions ioType="manufacturer" />}
//       query={query}
//     >
//       <DataTable data={filteredRows} columns={columns} tableId="manufacturers" />
//       <SomeDeleteDialog … />
//     </ListPageShell>
//   )

export function ListPageShell({
  title,
  backTo,
  backLabel,
  count,
  rail,
  search,
  add,
  actions,
  savedViews,
  query,
  page,
  summary,
  narrowRail,
  children,
}: {
  title: string
  /** Sub-list pages (a view *of* another list, e.g. /racks/elevations) get the
   * same breadcrumb back-link DetailShell renders - pass the parent list route
   * and its label. Omit on a top-level list. */
  backTo?: LinkProps["to"]
  backLabel?: string
  /** Row-count chip next to the title. Omit to hide it. */
  count?: number
  /** Filter rail (typically `useTableFilters().rail`) rendered to the left. */
  rail?: ReactNode
  /** Search box in the toolbar row over the table - the shell renders the
   * icon + input. */
  search?: {
    value: string
    onChange: (value: string) => void
    placeholder?: string
  }
  /** The header's Add button (solid primary) - first in the action ribbon,
   * see `components/action-ribbon.tsx`. */
  add?: ReactNode
  /** The rest of the header's action cluster (Import/Export, …), after Add. */
  actions?: ReactNode
  /** Saved views for this list. One prop, because the control needs only the
   * list's identity and its filter handle - the search box is already here. */
  savedViews?: {
    /** RBAC object slug, e.g. "device". */
    objectType: string
    filters: SavedViewsProps["filters"]
  }
  /** Drives the body's loading/error switch. When loading or errored, the
   * children are not rendered. Omit to always render children. */
  query?: { isLoading: boolean; isError: boolean; error: unknown }
  /** The server's answer for a list fetched in one capped request
   * (`query.data`). When it holds more rows than arrived, the count chip
   * reads "N of M", a notice says the list is cut off, and the facet rail and
   * the table's Download say they cover the loaded rows (#412). */
  page?: { count?: number; results?: unknown[] }
  /** A row above the table once data is ready - e.g. count chips that apply
   * a facet (the Lifecycle page's windows). */
  summary?: ReactNode
  /** The rail for a window too narrow to show it: a toolbar-row button
   * (below `lg`) opening it in a sheet from the left. `content` gets a
   * `close`. */
  narrowRail?: NarrowRail
  /** The table (and any dialogs/bulk bars) - rendered once data is ready. */
  children: ReactNode
}) {
  usePageTitle(title)
  // Facets the user hid on this list (#285), for the rail to honour.
  const facetPrefs = useListFacetPrefs()
  const cap = listCap(page)
  // The toolbar row the page's table moves its controls into.
  const bodyId = useId()
  const [slot, setSlot] = useState<HTMLElement | null>(null)
  const [owner, setOwner] = useState<string | null>(null)
  const claim = useCallback(
    (id: string, el: HTMLElement) => {
      // Only a table in this shell's body: not one in a dialog it opened.
      // Read off the DOM, as the body's ref is not attached yet when its
      // children's layout effects run.
      if (
        el.closest("[data-list-body]")?.getAttribute("data-list-body") ===
        bodyId
      )
        setOwner((cur) => cur ?? id)
      return () => setOwner((cur) => (cur === id ? null : cur))
    },
    [bodyId]
  )
  const hasToolbar = !!(search || narrowRail)
  const toolbar = useMemo<ListToolbar | null>(
    () => (hasToolbar ? { slot, owner, claim } : null),
    [hasToolbar, slot, owner, claim]
  )
  // The rail and the table read the cap too (FilterRail, DataTable's
  // Download), so the whole page sits inside its provider.
  const shell = (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex min-h-0 min-w-0 flex-1">
        <FacetVisibilityProvider value={facetPrefs}>
          {rail}
        </FacetVisibilityProvider>

        <div className="flex min-w-0 flex-1 flex-col">
          {/* The controls wrap under the title when they don't fit beside it,
              and onto further rows when they don't fit one. A scrolling strip
              hid them past its edge with no cue that they were there. */}
          <header className="flex min-h-14 shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-4 py-2 lg:px-6">
            {backTo ? (
              <nav className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
                <Button variant="ghost" size="sm" asChild className="h-6 px-1">
                  <Link to={backTo}>
                    <ChevronLeft className="h-3 w-3" /> {backLabel}
                  </Link>
                </Button>
                <ChevronRight className="h-3 w-3 opacity-60" />
                <h1 className="text-base font-semibold text-foreground">
                  {title}
                </h1>
              </nav>
            ) : (
              <h1 className="text-base font-semibold">{title}</h1>
            )}
            {count !== undefined && (
              <Badge variant={cap ? "warning" : "secondary"}>
                {cap ? listCapCount(count, cap) : count}
              </Badge>
            )}
            <div className="ml-auto flex grow flex-wrap items-center justify-end gap-2">
              {add}
              {actions}
            </div>
          </header>
          {/* Focusable, so a keyboard can scroll it when the content has
              no links or buttons of its own (#470). */}
          <div
            data-list-body={bodyId}
            tabIndex={0}
            role="region"
            aria-label={title}
            className="min-h-0 flex-1 overflow-auto p-4 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring lg:p-6"
          >
            {hasToolbar && (
              // One row for finding rows: filters, saved views and search on
              // the left, the table's selection, Download and Columns (moved
              // up here by the table) on the right. It sits outside the
              // loading switch, so the search box never remounts mid-typing.
              <div className="mb-2 flex min-h-8 flex-wrap items-center gap-x-2 gap-y-1.5">
                {narrowRail && <NarrowRailSheet rail={narrowRail} />}
                {savedViews && search && (
                  <SavedViews
                    objectType={savedViews.objectType}
                    q={search.value}
                    onQ={search.onChange}
                    filters={savedViews.filters}
                  />
                )}
                {search && (
                  // Narrows (to 10rem) before anything wraps, and widens back
                  // to 18rem when the row has room.
                  <div className="relative max-w-72 min-w-40 flex-[1_1_10rem]">
                    <Search className="absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      placeholder={search.placeholder ?? "Filter…"}
                      aria-label={search.placeholder ?? "Filter"}
                      value={search.value}
                      onChange={(e) => search.onChange(e.target.value)}
                      className="h-8 w-full pl-8 text-xs"
                    />
                  </div>
                )}
                <div ref={setSlot} className="contents" />
              </div>
            )}
            {query?.isLoading ? (
              <Loading />
            ) : query?.isError ? (
              <QueryError error={query.error} />
            ) : (
              <>
                {cap && (
                  // Same amber as the `warning` badge beside the title.
                  <p
                    role="status"
                    className="num mb-3 flex items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-800 dark:text-amber-300"
                  >
                    <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                    {listCapNotice(cap)}
                  </p>
                )}
                {summary && <div className="mb-3">{summary}</div>}
                {children}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
  return (
    <ListCapContext.Provider value={cap}>
      <ListToolbarContext.Provider value={toolbar}>
        {shell}
      </ListToolbarContext.Provider>
    </ListCapContext.Provider>
  )
}
