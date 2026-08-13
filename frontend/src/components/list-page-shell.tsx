import { type ReactNode } from "react"
import { Link } from "@tanstack/react-router"
import type { LinkProps } from "@tanstack/react-router"
import { ChevronLeft, ChevronRight, Search } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { QueryError } from "@/components/query-error"
import { SavedViews, type SavedViewsProps } from "@/components/saved-views"

// ─── The canonical list-page chrome ──────────────────────────────────────
//
// Every `/things` list page shares the same shell: an optional filter rail
// on the left, then a header bar (title + count chip + search + actions)
// over a scrollable body that switches loading → error → content.
// ListPageShell owns all of it so the ~70 list routes can't drift on header
// height, rail wiring, search styling, the loading/error triad, or — the
// bug that keeps recurring — the `min-h-0` that makes the body actually
// scroll.
//
//   const { rail, filteredRows } = useTableFilters(columns, rows)
//   return (
//     <ListPageShell
//       title="Manufacturers"
//       count={filteredRows.length}
//       rail={rail}
//       search={{ value: q, onChange: setQ, placeholder: "Filter…" }}
//       actions={<><TableActions ioType="manufacturer" />{addButton}</>}
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
  actions,
  savedViews,
  query,
  children,
}: {
  title: string
  /** Sub-list pages (a view *of* another list, e.g. /racks/elevations) get the
   * same breadcrumb back-link DetailShell renders — pass the parent list route
   * and its label. Omit on a top-level list. */
  backTo?: LinkProps["to"]
  backLabel?: string
  /** Row-count chip next to the title. Omit to hide it. */
  count?: number
  /** Filter rail (typically `useTableFilters().rail`) rendered to the left. */
  rail?: ReactNode
  /** Search box in the header — the shell renders the icon + input. */
  search?: {
    value: string
    onChange: (value: string) => void
    placeholder?: string
  }
  /** Header action cluster (Import/Export, Add, …), right-aligned after search. */
  actions?: ReactNode
  /** Saved views for this list. One prop, because the control needs only the
   * list's identity and its filter handle — the search box is already here. */
  savedViews?: {
    /** RBAC object slug, e.g. "device". */
    objectType: string
    filters: SavedViewsProps["filters"]
  }
  /** Drives the body's loading/error switch. When loading or errored, the
   * children are not rendered. Omit to always render children. */
  query?: { isLoading: boolean; isError: boolean; error: unknown }
  /** The table (and any dialogs/bulk bars) — rendered once data is ready. */
  children: ReactNode
}) {
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex min-h-0 min-w-0 flex-1">
        {rail}

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex h-14 shrink-0 [scrollbar-width:none] items-center gap-3 overflow-x-auto border-b border-border px-4 lg:px-6 [&::-webkit-scrollbar]:hidden [&>*]:shrink-0">
            {backTo ? (
              <nav className="flex items-center gap-1.5 text-xs text-muted-foreground">
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
            {count !== undefined && <Badge variant="secondary">{count}</Badge>}
            <div className="ml-auto flex items-center gap-2">
              {savedViews && search && (
                <SavedViews
                  objectType={savedViews.objectType}
                  q={search.value}
                  onQ={search.onChange}
                  filters={savedViews.filters}
                />
              )}
              {search && (
                <div className="relative">
                  <Search className="absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    placeholder={search.placeholder ?? "Filter…"}
                    value={search.value}
                    onChange={(e) => search.onChange(e.target.value)}
                    className="h-8 w-72 pl-8 text-xs"
                  />
                </div>
              )}
              {actions}
            </div>
          </header>
          <div className="min-h-0 flex-1 overflow-auto p-4 lg:p-6">
            {query?.isLoading ? (
              <p className="text-sm text-muted-foreground">Loading…</p>
            ) : query?.isError ? (
              <QueryError error={query.error} />
            ) : (
              children
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
