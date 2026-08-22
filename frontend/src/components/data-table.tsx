import { useEffect, useMemo, useRef, useState } from "react"
import {
  type ColumnDef,
  type ColumnFiltersState,
  type ColumnOrderState,
  type ExpandedState,
  type SortingState,
  type Updater,
  type VisibilityState,
  type RowSelectionState,
  flexRender,
  getCoreRowModel,
  getExpandedRowModel,
  getFilteredRowModel,
  getGroupedRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
} from "@tanstack/react-table"
import { ArrowUpDown, ChevronDown, ChevronRight, Download } from "lucide-react"

import { ColumnsMenu } from "@/components/column-menu"
import { useTablePreference } from "@/lib/use-table-preference"
import { useUserPrefs } from "@/lib/use-user-prefs"
import { exportTable, type ExportFormat } from "@/lib/table-export"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"

interface DataTableProps<T> {
  columns: ColumnDef<T, unknown>[]
  data: T[]
  /** Field to group rows by (creates a section header per unique value). */
  groupBy?: string
  /** Label used for the columns dropdown. Defaults to "Columns". */
  columnsLabel?: string
  /** Custom renderer for the group-section banner. Receives the group's
   * first leaf row so the consumer can pull fields like vrf.color / rd
   * out of the row shape. Falls back to plain "value (N rows)". */
  renderGroupHeader?: (info: {
    value: unknown
    count: number
    sampleRow: T
  }) => React.ReactNode
  /** Fired whenever the row selection changes - receives the array of
   * originals so the parent can wire bulk-action bars without thinking
   * about TanStack's keyed selection state. */
  onSelectedRowsChange?: (rows: T[]) => void
  /** Initial column-visibility map. Useful for hiding columns that are
   * only kept around for grouping (e.g. vrfName behind a VRF group
   * header). */
  initialColumnVisibility?: VisibilityState
  /** ID of the column that should absorb extra horizontal space (CLAUDE.md
   * elastic-column pattern). The header gets `w-full`, the cell gets
   * `w-full max-w-0 truncate`. */
  flexColumn?: string
  /** Sticky header inside a scrollable container. */
  stickyHeader?: boolean
  /** Opt this table into saved column preferences (order + visibility),
   * persisted per user via /api/prefs/columns/<tableId>/. Must match an id
   * in `lib/tables.ts`. When set, the Columns menu gains reorder + reset and
   * honours an admin "forced" lock. Omit to keep the table stateless. */
  tableId?: string
  /** Force zebra striping on/off. Omit to follow the user's `table_stripes`
   * display preference (Settings → Preferences). */
  striped?: boolean
  /** Hide the Export menu (CSV / HTML / Print). Export is on by default for
   * every table; opt out for trivial/embedded tables. */
  enableExport?: boolean
  /** File base name for exports. Defaults to `tableId` or "export". */
  exportName?: string
  /** Heading shown on the exported HTML / print page. Defaults to the file
   * name. */
  exportTitle?: string
  /** Optional per-row tailwind classes (e.g. a status-based background tint).
   * Row hover/selection still win (declared `!important` in tokens.css). */
  rowClassName?: (original: T) => string | undefined
  /** Optional per-row inline style - use for tints derived from user-chosen
   * colors (arbitrary hex) that can't be expressed as a Tailwind class. Row
   * hover/selection still win (declared `!important` in tokens.css). */
  rowStyle?: (original: T) => React.CSSProperties | undefined
  /** Embedded in a detail-page tab / pane - suppress the Export + Columns
   * toolbar (those belong on full list pages). The selection count still
   * appears when rows are ticked; with nothing selected the toolbar bar is
   * omitted entirely so there's no empty spacer above the table. */
  embedded?: boolean
  /** Grouped views show the whole hierarchy by default. Opt in to paging the
   * post-expansion rows (group banners interleaved) when a grouped table can
   * hold hundreds of interactive rows - e.g. the monitoring policy tables. */
  pagedWhenGrouped?: boolean
  /** Show a filter box above the table. Embedded panes (device components,
   * detail tabs) suppress the Export/Columns toolbar but still want to find a
   * row in a long list - this is that box, and it filters every column. */
  searchable?: boolean
  /** Placeholder for the filter box. */
  searchPlaceholder?: string
  /** Server-paginated lists (the API hands back one page at a time - audit log,
   * jobs) pass their page state here so the table's own pager drives the
   * *server* page. Without it those pages hand-rolled a second Prev/Next row
   * under the table and showed two pagers. Client-side paging is off in this
   * mode: the fetched page is rendered in full. */
  serverPagination?: {
    /** 1-based current page. */
    page: number
    pageCount: number
    /** Total matching rows on the server (not just this page). */
    totalRows: number
    onPageChange: (page: number) => void
  }
}

// Headless data table for every list page in Danbyte. Hands the column
// definitions in - TanStack Table handles sort + filter + group +
// selection + visibility. The shadcn primitives provide the visual layer.
export function DataTable<T>({
  columns,
  data,
  groupBy,
  columnsLabel = "Columns",
  renderGroupHeader,
  onSelectedRowsChange,
  initialColumnVisibility,
  flexColumn,
  stickyHeader,
  tableId,
  striped,
  enableExport = true,
  exportName,
  exportTitle,
  rowClassName,
  rowStyle,
  embedded,
  pagedWhenGrouped,
  searchable,
  searchPlaceholder,
  serverPagination,
}: DataTableProps<T>) {
  const [sorting, setSorting] = useState<SortingState>([])
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([])
  const [globalFilter, setGlobalFilter] = useState("")
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>(
    initialColumnVisibility ?? {}
  )
  const [columnOrder, setColumnOrder] = useState<ColumnOrderState>([])
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({})
  const [grouping] = useState(groupBy ? [groupBy] : [])

  // ─── Display preferences ───────────────────────────────────────────────
  // Row striping follows the user's global `table_stripes` preference unless
  // a `striped` prop overrides it for this specific table.
  const { values: displayPrefs, setPref } = useUserPrefs()
  const stripes = striped ?? displayPrefs.table_stripes === true

  // ─── Pagination ────────────────────────────────────────────────────────
  // Client-side paging driven by the user's "Default page size" preference
  // (Settings → Preferences). Grouped/tree views aren't paged - they show the
  // whole hierarchy. `0` (or grouping) means "show all".
  const prefPageSize = Number(displayPrefs.page_size) || 25
  const paged =
    !serverPagination &&
    prefPageSize > 0 &&
    (!groupBy || pagedWhenGrouped === true)
  const [pagination, setPagination] = useState({
    pageIndex: 0,
    pageSize: paged ? prefPageSize : 100000,
  })
  useEffect(() => {
    setPagination((p) => ({
      ...p,
      pageIndex: 0,
      pageSize: paged ? prefPageSize : 100000,
    }))
  }, [prefPageSize, paged])

  // ─── Saved column preferences ──────────────────────────────────────────
  const pref = useTablePreference(tableId)
  // Natural leaf-column ids (in definition order) and the subset the user is
  // allowed to manage (hide / reorder). Pinned columns (select, actions) have
  // enableHiding === false and stay put.
  const { allIds, manageableIds } = useMemo(() => {
    const all: string[] = []
    const manageable: string[] = []
    for (const c of columns) {
      const id = (c as { id?: string }).id
      if (!id) continue
      all.push(id)
      if ((c as { enableHiding?: boolean }).enableHiding !== false)
        manageable.push(id)
    }
    return { allIds: all, manageableIds: manageable }
  }, [columns])

  // Apply the saved layout. The ORDER is re-derived whenever the column set
  // changes - data-gated columns (monitoring, range) mount only after their
  // fetch resolves, and an order computed without them would exile them past
  // the pinned actions column at the far right. Re-deriving is safe: pref.order
  // tracks in-session reorders optimistically, so this is idempotent for them.
  // HIDDEN is applied once per id (late-mounting ids included) so a user's
  // in-session show/hide toggles are never clobbered.
  const appliedHiddenIds = useRef<Set<string>>(new Set())
  useEffect(() => {
    if (!tableId || !pref.loaded) return
    if (pref.order.length) {
      setColumnOrder(applyManageableOrder(allIds, manageableIds, pref.order))
    }
    const fresh = pref.hidden.filter(
      (id) => manageableIds.includes(id) && !appliedHiddenIds.current.has(id)
    )
    if (fresh.length) {
      for (const id of fresh) appliedHiddenIds.current.add(id)
      setColumnVisibility((v) => {
        const next = { ...v }
        for (const id of fresh) next[id] = false
        return next
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    tableId,
    pref.loaded,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    allIds.join(" "),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    pref.order.join(" "),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    pref.hidden.join(" "),
  ])

  // Persisted change handlers - write through to the pref hook (no-op when
  // there's no tableId or the layout is forced).
  const persistHidden = (vis: VisibilityState) => {
    if (!tableId || pref.isForced) return
    const hidden = manageableIds.filter((id) => vis[id] === false)
    pref.setLayout({ hidden })
  }
  const onColumnVisibilityChange = (updater: Updater<VisibilityState>) => {
    setColumnVisibility((prev) => {
      const next = typeof updater === "function" ? updater(prev) : updater
      persistHidden(next)
      return next
    })
  }
  // Commit a full layout from the Columns menu in ONE atomic write - order +
  // hidden together. (The old per-toggle auto-save could race itself and drop
  // changes / re-check boxes; staging a draft and saving once fixes that.)
  const applyLayout = (order: string[], hidden: string[]) => {
    if (pref.isForced) return
    setColumnOrder(applyManageableOrder(allIds, manageableIds, order))
    // Raw visibility set (bypasses the per-toggle persist wrapper) - the single
    // pref.setLayout below is the one and only write.
    setColumnVisibility(() => {
      const vis: VisibilityState = {}
      for (const id of hidden) if (manageableIds.includes(id)) vis[id] = false
      return vis
    })
    if (tableId) pref.setLayout({ order, hidden })
  }
  const resetLayout = () => {
    setColumnOrder([])
    setColumnVisibility(initialColumnVisibility ?? {})
    appliedHiddenIds.current.clear()
    pref.reset()
  }
  // Default to every group expanded so the child rows show on first
  // render - collapsing is interactive but a fresh page should reveal
  // its data, not hide it. When the data changes (filter applied, new
  // groups appear), reset back to "all expanded" - otherwise an old
  // expanded-id map silently collapses any group whose id wasn't in it.
  const [expanded, setExpanded] = useState<ExpandedState>(true)
  useEffect(() => {
    setExpanded(true)
  }, [data])

  const table = useReactTable({
    data,
    columns,
    state: {
      sorting,
      columnFilters,
      globalFilter,
      columnVisibility,
      columnOrder,
      rowSelection,
      grouping,
      expanded,
      pagination,
    },
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    onColumnVisibilityChange: onColumnVisibilityChange,
    onColumnOrderChange: setColumnOrder,
    onRowSelectionChange: setRowSelection,
    onExpandedChange: setExpanded,
    onPaginationChange: setPagination,
    enableRowSelection: true,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    onGlobalFilterChange: setGlobalFilter,
    getGroupedRowModel: getGroupedRowModel(),
    getExpandedRowModel: getExpandedRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    autoResetPageIndex: false,
    autoResetExpanded: false,
    // When grouping, treat sub-rows as the items to render after the
    // group header - without this, expanded() doesn't reach them.
    getSubRows: (row) =>
      (row as unknown as { subRows?: unknown[] }).subRows as
        | never[]
        | undefined,
  })

  const selectedCount = Object.keys(rowSelection).length

  // Bubble the actual row originals up so parents don't have to map keys.
  // Only when the selection actually CHANGED: a parent typically stores this
  // in state, so emitting a fresh array on every `data` identity change turns
  // an unstable upstream memo into an infinite render loop (React #185 - it
  // took down the tenants page). The equality guard keeps every table immune.
  const lastEmitted = useRef<T[] | null>(null)
  useEffect(() => {
    if (!onSelectedRowsChange) return
    const leaves = table
      .getSelectedRowModel()
      .flatRows.filter((r) => !r.getIsGrouped())
      .map((r) => r.original as T)
    const prev = lastEmitted.current
    if (
      prev &&
      prev.length === leaves.length &&
      prev.every((row, i) => row === leaves[i])
    )
      return
    lastEmitted.current = leaves
    onSelectedRowsChange(leaves)
    // table is stable; re-emit when selection or data changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowSelection, data])

  return (
    <div className="flex flex-col gap-2">
      {searchable && (
        <Input
          value={globalFilter}
          onChange={(e) => setGlobalFilter(e.target.value)}
          placeholder={searchPlaceholder ?? "Search…"}
          className="h-8 max-w-xs text-[13px]"
          aria-label="Filter rows"
        />
      )}
      {/* Compact bar above the table - only shows up at all if there's
          something to say. Selection count on the left when rows are
          ticked, Columns dropdown on the right. The full row of "36
          rows" duplicating the page-header badge is gone. Embedded tables
          drop the Export + Columns controls (they belong on list pages), so
          the bar only appears there when rows are selected. */}
      {(!embedded || selectedCount > 0) && (
        <div className="flex h-6 items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground">
            {selectedCount > 0 && (
              <span className="font-medium text-foreground">
                {selectedCount} selected
              </span>
            )}
          </span>
          {!embedded && (
            <div className="flex items-center gap-1">
              {enableExport && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 px-2 text-xs"
                      title="Download a pretty snapshot of this view (not re-importable). For editable data, use Import / Export."
                    >
                      <Download className="mr-1 h-3 w-3" />
                      Download
                      {selectedCount > 0 && (
                        <span className="ml-1 text-muted-foreground">
                          ({selectedCount})
                        </span>
                      )}
                      <ChevronDown className="ml-1 h-3 w-3" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-44">
                    {(
                      [
                        ["html", "HTML page (shareable)"],
                        ["xlsx", "Excel (.xlsx)"],
                        ["csv", "CSV (spreadsheet)"],
                        ["print", "Print / Save as PDF"],
                      ] as [ExportFormat, string][]
                    ).map(([fmt, label]) => (
                      <DropdownMenuItem
                        key={fmt}
                        onSelect={() => {
                          const base = exportName || tableId || "export"
                          exportTable(table, fmt, {
                            name: base,
                            title: exportTitle || prettifyName(base),
                            generatedAt: new Date().toLocaleString(),
                          })
                        }}
                      >
                        {label}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
              {tableId ? (
                // Preference-aware: drag to reorder + tick to show, saved as one
                // atomic layout. Reset falls back to the tenant default; the
                // whole thing is read-only when an admin has forced the layout.
                <ColumnsMenu
                  label={columnsLabel}
                  isForced={pref.isForced}
                  hasUserRow={pref.hasUserRow}
                  seq={manageableSeq(columnOrder, allIds, manageableIds)}
                  labelFor={(id) =>
                    resolveColumnLabel(id, table.getColumn(id)?.columnDef)
                  }
                  isHidden={(id) =>
                    !(table.getColumn(id)?.getIsVisible() ?? true)
                  }
                  onApply={applyLayout}
                  onReset={resetLayout}
                />
              ) : (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 px-2 text-xs"
                    >
                      {columnsLabel}
                      <ChevronDown className="ml-1 h-3 w-3" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-48">
                    {table
                      .getAllColumns()
                      .filter((c) => c.getCanHide())
                      .map((c) => (
                        <DropdownMenuCheckboxItem
                          key={c.id}
                          className="capitalize"
                          checked={c.getIsVisible()}
                          onCheckedChange={(v) => c.toggleVisibility(!!v)}
                        >
                          {c.id}
                        </DropdownMenuCheckboxItem>
                      ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </div>
          )}
        </div>
      )}

      {/* Table.
          `overflow-x-auto` lets a wide table (full, non-truncated cells) scroll
          horizontally instead of clipping; it still clips the row hover
          background to the rounded corners (overflow-y computes to auto), so the
          `bg` doesn't leak past the border-radius on first/last rows. */}
      <div className="overflow-x-auto rounded-lg border border-border">
        <Table data-stripes={stripes ? "on" : "off"}>
          <TableHeader
            className={
              stickyHeader
                ? "sticky top-0 z-10 bg-muted/40 shadow-[inset_0_-1px_0_var(--border)]"
                : undefined
            }
          >
            {table.getHeaderGroups().map((hg) => (
              <TableRow key={hg.id}>
                {hg.headers.map((h) => (
                  <TableHead
                    key={h.id}
                    className={
                      "text-xs " +
                      (flexColumn && h.column.id === flexColumn
                        ? "w-full "
                        : "whitespace-nowrap ") +
                      // The chrome columns hug their content. `w-px` + nowrap
                      // is the shrink-to-fit idiom: without it an auto-layout
                      // table pools its slack in the trailing column, which
                      // left a wide empty band in front of the row actions on
                      // every table that doesn't name a flexColumn.
                      (h.column.id === "actions" || h.column.id === "select"
                        ? "w-px "
                        : "") +
                      // Pin the row-actions column to the right edge so Edit/
                      // Delete stay reachable on wide tables (many columns) that
                      // scroll horizontally, instead of vanishing off the edge.
                      (h.column.id === "actions"
                        ? "sticky right-0 z-20 bg-muted/40 shadow-[inset_1px_0_0_var(--border)]"
                        : "")
                    }
                  >
                    {h.isPlaceholder
                      ? null
                      : flexRender(h.column.columnDef.header, h.getContext())}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {table.getRowModel().rows.length ? (
              table.getRowModel().rows.map((row) => {
                // Grouped header row: rendered when the row is a grouping
                // pseudo-row (one per unique groupBy value). Skip rendering
                // it as data - we paint a banner row instead.
                if (row.getIsGrouped()) {
                  const groupVal = row.getValue(grouping[0])
                  const sampleRow = (row.subRows[0]?.original ??
                    null) as T | null
                  return (
                    <TableRow
                      key={row.id}
                      className="bg-muted/30 hover:bg-muted/40"
                    >
                      <TableCell colSpan={columns.length} className="py-2">
                        <button
                          type="button"
                          onClick={row.getToggleExpandedHandler()}
                          className="inline-flex items-center gap-2 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase hover:text-foreground"
                        >
                          {row.getIsExpanded() ? (
                            <ChevronDown className="h-3 w-3" />
                          ) : (
                            <ChevronRight className="h-3 w-3" />
                          )}
                          {renderGroupHeader && sampleRow ? (
                            renderGroupHeader({
                              value: groupVal,
                              count: row.subRows.length,
                              sampleRow,
                            })
                          ) : (
                            <>
                              {typeof groupVal === "string"
                                ? groupVal
                                : String(groupVal ?? "-")}
                              <span className="ml-1 tracking-normal text-muted-foreground/70 normal-case">
                                {row.subRows.length}{" "}
                                {row.subRows.length === 1 ? "row" : "rows"}
                              </span>
                            </>
                          )}
                        </button>
                      </TableCell>
                    </TableRow>
                  )
                }
                return (
                  <TableRow
                    key={row.id}
                    data-state={row.getIsSelected() ? "selected" : undefined}
                    className={rowClassName?.(row.original as T)}
                    style={rowStyle?.(row.original as T)}
                  >
                    {row.getVisibleCells().map((cell) => (
                      <TableCell
                        key={cell.id}
                        className={
                          "py-2 text-sm " +
                          // Never truncate. The flex column still absorbs extra
                          // width, but shows its content in full; if that makes
                          // the table wider than its container, the wrapper
                          // scrolls horizontally instead of clipping cells.
                          (flexColumn && cell.column.id === flexColumn
                            ? "w-full whitespace-nowrap "
                            : "whitespace-nowrap ") +
                          // Chrome columns hug their content (see the header
                          // note), and the actions sit at the row's right edge.
                          (cell.column.id === "select" ? "w-px " : "") +
                          (cell.column.id === "actions"
                            ? "w-px text-right "
                            : "") +
                          // Keep the row-actions column pinned to the right edge
                          // (see the header note) so it never scrolls out of reach.
                          (cell.column.id === "actions"
                            ? "sticky right-0 bg-background shadow-[inset_1px_0_0_var(--border)]"
                            : "")
                        }
                      >
                        {flexRender(
                          cell.column.columnDef.cell,
                          cell.getContext()
                        )}
                      </TableCell>
                    ))}
                  </TableRow>
                )
              })
            ) : (
              <TableRow>
                <TableCell
                  colSpan={columns.length}
                  className="h-24 text-center text-sm text-muted-foreground"
                >
                  No results.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {/* Pager - shown on every flat (non-grouped) list, even single-page ones,
          so the row count + rows-per-page control are always available (the
          selector persists to Settings → Preferences). In `serverPagination`
          mode the same row drives the server's page instead, and the
          rows-per-page control is dropped (the caller owns the page size). */}
      {(paged || serverPagination) && (
        <div className="flex items-center justify-between gap-2 text-xs whitespace-nowrap text-muted-foreground">
          <span className="num truncate">
            {serverPagination?.totalRows ??
              table.getFilteredRowModel().rows.length}{" "}
            rows
          </span>
          <div className="flex shrink-0 items-center gap-2">
            {!serverPagination && (
              <span className="flex items-center gap-1">
                Rows
                <Select
                  value={String(prefPageSize)}
                  onValueChange={(v) => {
                    const n = Number(v)
                    table.setPageSize(n)
                    setPref("page_size", n)
                  }}
                >
                  <SelectTrigger
                    size="sm"
                    className="h-6 w-20 text-xs"
                    aria-label="Rows"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {[25, 50, 100, 250, 1000].map((n) => (
                      <SelectItem key={n} value={String(n)}>
                        {n}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </span>
            )}
            <span className="num">
              Page{" "}
              {serverPagination?.page ??
                table.getState().pagination.pageIndex + 1}{" "}
              of {serverPagination?.pageCount ?? table.getPageCount()}
            </span>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-xs"
              onClick={() =>
                serverPagination
                  ? serverPagination.onPageChange(serverPagination.page - 1)
                  : table.previousPage()
              }
              disabled={
                serverPagination
                  ? serverPagination.page <= 1
                  : !table.getCanPreviousPage()
              }
            >
              Prev
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-xs"
              onClick={() =>
                serverPagination
                  ? serverPagination.onPageChange(serverPagination.page + 1)
                  : table.nextPage()
              }
              disabled={
                serverPagination
                  ? serverPagination.page >= serverPagination.pageCount
                  : !table.getCanNextPage()
              }
            >
              Next
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

// Turn a file-base name ("ip-ranges") into a heading ("Ip Ranges") for the
// export page when no explicit exportTitle is given.
function prettifyName(s: string): string {
  return s.replace(/[_-]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
}

// Prettify a column id for the Columns menu: split on `_`/`-`, capitalize each
// word, join with spaces ("primary_ip" → "Primary Ip").
function prettifyColumnId(id: string): string {
  return id
    .split(/[_-]/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ")
}

// Resolve the human-readable label shown for a column in the Columns menu, in
// priority order: explicit `meta.label` → plain-string `header` → prettified id.
function resolveColumnLabel(
  id: string,
  columnDef?: { header?: unknown; meta?: { label?: string } }
): string {
  const metaLabel = columnDef?.meta?.label
  if (typeof metaLabel === "string" && metaLabel.trim()) return metaLabel
  if (typeof columnDef?.header === "string" && columnDef.header.trim())
    return columnDef.header
  return prettifyColumnId(id)
}

// ─── Column-order helpers ────────────────────────────────────────────────
// Reordering only shuffles the *manageable* columns; pinned ones (select,
// actions) keep their natural slots. `applyManageableOrder` rebuilds the full
// TanStack columnOrder from a desired manageable sequence; `manageableSeq`
// extracts the current manageable sequence back out for the menu.

/** Slot ids the sequence has never seen (new feature columns) at their
 * *designed* position - right after the nearest preceding column the sequence
 * knows - instead of appending them at the far end, where a saved layout from
 * before the column existed would banish it off-screen. */
function insertUnknownAtDesignedPosition(
  norm: string[],
  manageableIds: string[]
): void {
  for (const id of manageableIds) {
    if (norm.includes(id)) continue
    const defIdx = manageableIds.indexOf(id)
    let insertAt = 0
    for (let j = defIdx - 1; j >= 0; j--) {
      const at = norm.indexOf(manageableIds[j])
      if (at !== -1) {
        insertAt = at + 1
        break
      }
    }
    norm.splice(insertAt, 0, id)
  }
}

export function applyManageableOrder(
  allIds: string[],
  manageableIds: string[],
  seq: string[]
): string[] {
  const mset = new Set(manageableIds)
  const norm = seq.filter((id) => mset.has(id))
  insertUnknownAtDesignedPosition(norm, manageableIds)
  let i = 0
  return allIds.map((id) => (mset.has(id) ? norm[i++] : id))
}

function manageableSeq(
  columnOrder: string[],
  allIds: string[],
  manageableIds: string[]
): string[] {
  const mset = new Set(manageableIds)
  const base = columnOrder.length ? columnOrder : allIds
  const seq = base.filter((id) => mset.has(id))
  insertUnknownAtDesignedPosition(seq, manageableIds)
  return seq
}

// Re-export the canonical sort-header button helper so call-sites have
// one less import.
export function SortHeader({
  column,
  label,
}: {
  column: {
    toggleSorting: (asc?: boolean) => void
    getIsSorted: () => false | "asc" | "desc"
  }
  label: string
}) {
  return (
    <Button
      variant="ghost"
      size="sm"
      className="-ml-3 h-7 px-2 text-xs"
      onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
    >
      {label}
      <ArrowUpDown className="ml-1 h-3 w-3" />
    </Button>
  )
}

// Selection cell helpers
export const selectionColumn = <T,>(): ColumnDef<T> => ({
  id: "select",
  enableSorting: false,
  enableHiding: false,
  header: ({ table }) => (
    <Checkbox
      checked={
        table.getIsAllPageRowsSelected() ||
        (table.getIsSomePageRowsSelected() && "indeterminate")
      }
      onCheckedChange={(v) => table.toggleAllPageRowsSelected(!!v)}
      aria-label="Select all"
    />
  ),
  cell: ({ row }) => (
    <Checkbox
      checked={row.getIsSelected()}
      onCheckedChange={(v) => row.toggleSelected(!!v)}
      aria-label="Select row"
    />
  ),
})
