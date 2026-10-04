import { useEffect, useMemo, useRef, useState } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { cn } from "@/lib/utils"
import { useDateFormat } from "@/lib/datetime"
import {
  type ColumnDef,
  type ColumnFiltersState,
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
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ChevronDown,
  ChevronRight,
  Download,
} from "lucide-react"

import { ColumnsMenu } from "@/components/column-menu"
import type { ColumnGroup } from "@/components/column-menu"
import {
  collectRowKeys,
  customFieldColumns,
  inlineChoiceLabel,
  listFieldColumns,
  mergeAutoColumns,
  unreadableFields,
} from "@/components/columns/auto-columns"
import type { ChoiceLabel } from "@/components/columns/auto-columns"
import { api } from "@/lib/api"
import type { DcimChoices } from "@/lib/api"
import { useDeviceFieldVisibility, useListFields } from "@/lib/list-fields"
import { tableApi } from "@/lib/tables"
import { useTablePreference } from "@/lib/use-table-preference"
import { useUserPrefs } from "@/lib/use-user-prefs"
import { exportTable, type ExportFormat } from "@/lib/table-export"
import { naturalSortingFn } from "@/lib/natural-sort"
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
  /** How many rows exist on the server, when `data` is one capped page of
   * them (an embedded list fetches `page_size=500`). More than `data` holds
   * and the table says so, rather than looking complete at exactly 500.
   * Ignored under `serverPagination`, which pages through everything. */
  total?: number
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
  /** The parent's copy of the selection - what `onSelectedRowsChange` last
   * handed it. When the parent empties it (a bulk bar's Clear, a finished
   * bulk action) the ticks clear to match. */
  selectedRows?: readonly T[]
  /** Initial column-visibility map. Useful for hiding columns that are
   * only kept around for grouping (e.g. vrfName behind a VRF group
   * header). */
  initialColumnVisibility?: VisibilityState
  /** ID of the column that should absorb extra horizontal space (CLAUDE.md
   * elastic-column pattern). The header gets `w-full`, the cell gets
   * `w-full max-w-0 truncate`. */
  flexColumn?: string
  /** Keep the header row in view while the rows scroll. The table's own frame
   * becomes the scroller - both ways - so give the DataTable a parent that
   * bounds its height (a `flex min-h-0 flex-1 flex-col` pane): the frame then
   * shrinks to fit, the rows scroll under the header, and the horizontal
   * scrollbar sits at the pane's bottom edge instead of after the last row. */
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
  /** Fetch every row the current filters match, for export. Server-paginated
   * tables must supply this or the download holds only the visible page. */
  exportAll?: () => Promise<T[]>
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
  /** Opt-in: the pointer is over this row, or (`null`) over none - it left
   * the rows, or is on a group banner. A page uses it to point at the row's
   * object elsewhere, e.g. a rack on a floor plan. */
  onRowHover?: (row: T | null) => void
  /** Opt-in: a click on the row itself. A click on a link, checkbox, button,
   * input or other control in a cell stays that control's, and so does a
   * text selection or a click inside a menu or dialog a cell opened. */
  onRowClick?: (row: T, event: React.MouseEvent<HTMLTableRowElement>) => void
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
  /** Server-sorted lists hand their sort state in, so a `SortHeader` click
   * asks the server for a different order instead of shuffling the page it
   * has. The header keeps its arrow and its click; only who does the sorting
   * changes. Omit for client-side sorting. */
  serverSorting?: {
    sorting: SortingState
    onSortingChange: (sorting: SortingState) => void
  }
  /** Catalog columns (#243): every field the list's rows carry and every
   * custom field, offered hidden in the Columns menu. On by default for a
   * `tableId` registered with an `api` in lib/tables.ts. `false` opts out;
   * `api` points at a list path directly (a table without a registry entry);
   * `get` finds the list row inside a wrapped row; `exclude` names fields a
   * page leaves out on purpose. */
  autoColumns?:
    | false
    | {
        api?: string | null
        get?: (row: T) => unknown
        exclude?: string[]
      }
}

// Headless data table for every list page in Danbyte. Hands the column
// definitions in - TanStack Table handles sort + filter + group +
// selection + visibility. The shadcn primitives provide the visual layer.
export function DataTable<T>({
  columns: ownColumns,
  data,
  total,
  groupBy,
  columnsLabel = "Columns",
  renderGroupHeader,
  onSelectedRowsChange,
  selectedRows,
  initialColumnVisibility,
  flexColumn,
  stickyHeader,
  tableId,
  striped,
  enableExport = true,
  exportAll,
  exportName,
  exportTitle,
  rowClassName,
  rowStyle,
  onRowHover,
  onRowClick,
  embedded,
  pagedWhenGrouped,
  searchable,
  searchPlaceholder,
  serverPagination,
  serverSorting,
  autoColumns,
}: DataTableProps<T>) {
  const [localSorting, setLocalSorting] = useState<SortingState>([])
  const sorting = serverSorting ? serverSorting.sorting : localSorting
  const setSorting = (updater: Updater<SortingState>) => {
    const next = typeof updater === "function" ? updater(sorting) : updater
    if (serverSorting) serverSorting.onSortingChange(next)
    else setLocalSorting(next)
  }
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([])
  const [globalFilter, setGlobalFilter] = useState("")
  // Show/hide ticks made in this session on a table without saved layouts.
  const [sessionVisibility, setSessionVisibility] = useState<VisibilityState>(
    {}
  )
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({})
  const [grouping] = useState(groupBy ? [groupBy] : [])

  // ─── Display preferences ───────────────────────────────────────────────
  // Row striping follows the user's global `table_stripes` preference unless
  // a `striped` prop overrides it for this specific table.
  const { values: displayPrefs, setPref } = useUserPrefs()
  const { formatDateTime } = useDateFormat()
  const capped = serverPagination ? null : truncationNotice(total, data.length)
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

  // ─── Catalog columns (#243) ────────────────────────────────────────────
  // Every field the list's rows carry, and every custom field, as a hidden
  // column the Columns menu offers. Fetched lazily - when the menu is about to
  // open, or when the saved layout shows a column no factory wrote - so a
  // table nobody customises costs no extra request.
  const autoApi =
    embedded || autoColumns === false
      ? null
      : autoColumns?.api !== undefined
        ? autoColumns.api
        : tableApi(tableId)
  const ownIds = useMemo(
    () => new Set(ownColumns.map((c) => c.id).filter(Boolean) as string[]),
    [ownColumns]
  )
  const savedAutoShown = pref.order.some(
    (id) => !ownIds.has(id) && !pref.hidden.includes(id)
  )
  const [catalogWanted, setCatalogWanted] = useState(false)
  const catalogQuery = useListFields(autoApi, catalogWanted || savedAutoShown)
  const catalog = catalogQuery.data
  const deviceFields = useDeviceFieldVisibility(
    !!catalog?.fields.some((f) => f.setting)
  )
  const dcimQuery = useQuery({
    queryKey: ["dcim-choices"],
    queryFn: () => api<DcimChoices>("/api/dcim/choices/"),
    enabled: !!catalog?.fields.some((f) => f.choices),
    staleTime: 60 * 60_000,
  })
  const qc = useQueryClient()
  // Pages pass `get` inline; a ref keeps the built columns stable.
  const getRow = useRef<(row: T) => unknown>((r) => r)
  getRow.current = (autoColumns && autoColumns.get) || ((r: T): unknown => r)
  // Offer a field only when the rows carry its top-level key; remembered so a
  // filter that empties the table does not make columns vanish.
  const seenKeys = useRef(new Set<string>())
  const rowKeySig = catalog
    ? [...collectRowKeys(data, (r) => getRow.current(r), seenKeys.current)]
        .sort()
        .join(" ")
    : ""
  // …and only while its values read as something: a field whose every value
  // so far renders no text (a set of figures) would be a column of dashes.
  const readable = useRef(new Set<string>())
  const unreadable = useRef(new Set<string>())
  const unreadableSig = catalog
    ? unreadableFields(
        catalog.fields,
        data,
        (r) => getRow.current(r),
        readable.current,
        unreadable.current
      ).join(" ")
    : ""
  const autoCols = useMemo(() => {
    if (!catalog) return []
    const keys = new Set(rowKeySig.split(" "))
    const blank = new Set(unreadableSig.split(" "))
    const get = (r: T) => getRow.current(r)
    const dcim = dcimQuery.data as Record<string, unknown> | undefined
    const choiceLabel: ChoiceLabel = (f, v) => {
      if (f.options) return inlineChoiceLabel(f, v)
      const list = f.choices ? dcim?.[f.choices] : undefined
      const hit = Array.isArray(list)
        ? (list as { value: string | number; label: string }[]).find(
            (o) => String(o.value) === v
          )
        : undefined
      return hit?.label ?? v
    }
    const fields = catalog.fields.filter(
      (f) =>
        keys.has(f.key.split(".")[0]) &&
        !blank.has(f.key) &&
        !(f.setting && deviceFields[f.setting] === false)
    )
    return [
      ...listFieldColumns<T>(fields, {
        get,
        sortable: !serverSorting,
        choiceLabel,
      }),
      ...(keys.has("custom_fields")
        ? customFieldColumns<T>(catalog.custom_fields, {
            get,
            defaultHidden: true,
            sortable: !serverSorting,
            queryClient: qc,
          })
        : []),
    ]
  }, [
    catalog,
    rowKeySig,
    unreadableSig,
    deviceFields,
    dcimQuery.data,
    serverSorting,
    qc,
  ])
  const excludeSig = (autoColumns && autoColumns.exclude?.join(" ")) || ""
  const columns = useMemo(
    () =>
      mergeAutoColumns(
        ownColumns,
        autoCols,
        excludeSig ? excludeSig.split(" ") : []
      ),
    [ownColumns, autoCols, excludeSig]
  )

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

  // Visibility is derived, never copied into state once: a session tick, else
  // the saved layout, else the column's default. The saved `order` is the set
  // of columns a layout knows about - an id in it and not in `hidden` is
  // shown, so ticking a hidden-by-default column sticks; an id the layout has
  // never seen (a column added since) takes its default. A layout saved as
  // `hidden` only (older rows) still hides exactly those.
  const columnVisibility = useMemo<VisibilityState>(() => {
    const known = new Set(tableId && pref.loaded ? pref.order : [])
    const hidden = new Set(tableId && pref.loaded ? pref.hidden : [])
    const vis: VisibilityState = {}
    for (const c of columns) {
      const id = c.id
      if (!id) continue
      vis[id] =
        id in sessionVisibility
          ? sessionVisibility[id]
          : known.has(id)
            ? !hidden.has(id)
            : hidden.has(id)
              ? false
              : !(
                  initialColumnVisibility?.[id] === false ||
                  c.meta?.defaultHidden
                )
    }
    return vis
  }, [
    columns,
    sessionVisibility,
    tableId,
    pref.loaded,
    pref.order,
    pref.hidden,
    initialColumnVisibility,
  ])

  // The saved order, re-derived whenever the column set changes - data-gated
  // columns (monitoring, range) and catalog columns mount after their fetch,
  // and an order computed without them would exile them past the pinned
  // actions column. pref.order tracks edits optimistically, so this is live.
  const columnOrder = useMemo(
    () =>
      tableId && pref.order.length
        ? applyManageableOrder(
            allIds,
            manageableIds,
            pref.order,
            (id) => columnVisibility[id] !== false
          )
        : [],
    [tableId, pref.order, allIds, manageableIds, columnVisibility]
  )

  // A show/hide toggle from TanStack (the plain Columns dropdown): a session
  // tick, and on a saved-layout table also written through as a layout.
  const onColumnVisibilityChange = (updater: Updater<VisibilityState>) => {
    const next =
      typeof updater === "function" ? updater(columnVisibility) : updater
    const changed: VisibilityState = {}
    for (const [id, v] of Object.entries(next))
      if (columnVisibility[id] !== v) changed[id] = v
    setSessionVisibility((prev) => ({ ...prev, ...changed }))
    if (!tableId || pref.isForced) return
    const seq = manageableSeq(columnOrder, allIds, manageableIds)
    const vis = { ...columnVisibility, ...changed }
    pref.setLayout({
      order: seq,
      hidden: seq.filter((id) => vis[id] === false),
    })
  }
  // Commit a full layout from the Columns menu in ONE atomic write - order +
  // hidden together. (The old per-toggle auto-save could race itself and drop
  // changes / re-check boxes; staging a draft and saving once fixes that.)
  // Saved ids that are not mounted right now - a catalog column before the
  // catalog loaded, a data-gated column - are carried through, not dropped.
  const applyLayout = (order: string[], hidden: string[]) => {
    if (pref.isForced) return
    const mounted = new Set(manageableIds)
    const nextOrder = carryUnmounted(order, pref.order, mounted)
    const nextHidden = [
      ...hidden,
      ...pref.hidden.filter((id) => !mounted.has(id) && !hidden.includes(id)),
    ]
    setSessionVisibility({})
    if (tableId) pref.setLayout({ order: nextOrder, hidden: nextHidden })
  }
  const resetLayout = () => {
    setSessionVisibility({})
    pref.reset()
  }
  const groupFor = (id: string): ColumnGroup =>
    columns.find((c) => c.id === id)?.meta?.group ?? "columns"
  // Default to every group expanded so the child rows show on first
  // render - collapsing is interactive but a fresh page should reveal
  // its data, not hide it. When the data changes (filter applied, new
  // groups appear), reset back to "all expanded" - otherwise an old
  // expanded-id map silently collapses any group whose id wasn't in it.
  const [expanded, setExpanded] = useState<ExpandedState>(true)
  useEffect(() => {
    setExpanded(true)
  }, [data])

  // A selection follows the object, not its position: when every row has
  // its own distinct `id`, rows are keyed by it, so a filter, a refetch or a
  // deleted neighbour never moves a tick onto another row (#176). Rows
  // without one keep TanStack's index keys.
  const keyById = useMemo(() => hasDistinctIds(data), [data])

  const table = useReactTable({
    data,
    getRowId: keyById ? rowIdOf : undefined,
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
    manualSorting: !!serverSorting,
    // Text sorts in natural order ("DIMM 2" before "DIMM 10") unless a column
    // sets its own sortingFn; numbers and dates still sort by value.
    defaultColumn: { sortingFn: naturalSortingFn },
    onColumnFiltersChange: setColumnFilters,
    onColumnVisibilityChange: onColumnVisibilityChange,
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

  // Footer figures, in one place for the pager's "is there anything to page"
  // question and the row count's grammar.
  const rowTotal =
    serverPagination?.totalRows ?? table.getFilteredRowModel().rows.length
  const pageTotal = serverPagination?.pageCount ?? table.getPageCount()

  // A ticked row that leaves the list - deleted, refetched away, or hidden by
  // the list's filters or this table's own search box - leaves the selection
  // too, so a bulk action never reaches a row nobody can see. Rows on other
  // pages stay: that is what "Select all N" ticks.
  useEffect(() => {
    setRowSelection((prev) => {
      const keys = Object.keys(prev)
      if (keys.length === 0) return prev
      const shown = table.getFilteredRowModel().rowsById
      const grouped = table.getGroupedRowModel().rowsById
      const kept = keys.filter((k) => k in shown || k in grouped)
      if (kept.length === keys.length) return prev
      return Object.fromEntries(kept.map((k) => [k, true]))
    })
    // table is stable; prune when the rows or the filters change
  }, [data, globalFilter, columnFilters])

  // The parent emptied its copy of the selection: clear the ticks to match.
  // Only that edge counts - a caller that passes a fresh [] on every render
  // must never wipe a tick it has not been told about yet.
  const parentHadSelection = useRef(false)
  useEffect(() => {
    if (!selectedRows) return
    const had = parentHadSelection.current
    parentHadSelection.current = selectedRows.length > 0
    if (had && selectedRows.length === 0)
      setRowSelection((prev) => (Object.keys(prev).length ? {} : prev))
  }, [selectedRows])

  const selectedCount = Object.keys(rowSelection).length
  // The header checkbox ticks the page in front of you. When that is only
  // part of the list, the bar says so and offers the rest.
  const spansPages = paged && pageTotal > 1 && grouping.length === 0
  const allRowsSelected = spansPages && table.getIsAllRowsSelected()
  const pageSelected =
    spansPages && !allRowsSelected && table.getIsAllPageRowsSelected()

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
    // min-w-0: a table placed straight into a flex row may shrink below its
    // columns' width - the frame below then scrolls instead of the row growing.
    <div
      className={cn(
        "flex min-w-0 flex-col gap-2",
        stickyHeader && "min-h-0 flex-1"
      )}
    >
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
          the bar only appears there when rows are selected. It wraps rather
          than overflowing, so a narrow pane never cuts Download / Columns off. */}
      {(!embedded || selectedCount > 0) && (
        <div className="flex min-h-6 flex-wrap items-center justify-between gap-x-2 gap-y-1">
          <span className="flex items-center gap-2 text-xs text-muted-foreground">
            {selectedCount > 0 && (
              <span className="font-medium text-foreground">
                {selectedCount} selected
              </span>
            )}
            {pageSelected && (
              <Button
                variant="link"
                size="sm"
                className="h-auto p-0 text-xs text-foreground"
                onClick={() => table.toggleAllRowsSelected(true)}
              >
                Select all {rowTotal}
              </Button>
            )}
            {allRowsSelected && (
              <Button
                variant="link"
                size="sm"
                className="h-auto p-0 text-xs text-foreground"
                onClick={() => table.toggleAllRowsSelected(false)}
              >
                Clear
              </Button>
            )}
          </span>
          {!embedded && (
            <div className="ml-auto flex items-center gap-1">
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
                          const opts = {
                            name: base,
                            title: exportTitle || prettifyName(base),
                            generatedAt: formatDateTime(new Date()),
                          }
                          // A selection always wins; otherwise a server-paged
                          // table exports everything its filters match.
                          const all =
                            exportAll && selectedCount === 0
                              ? exportAll
                              : undefined
                          // Shown columns that need data first (object
                          // references export as names, not ids).
                          const prepares = table
                            .getVisibleLeafColumns()
                            .map((c) => c.columnDef.meta?.prepareExport)
                            .filter((f) => !!f)
                          if (!all && !prepares.length) {
                            exportTable(table, fmt, opts)
                            return
                          }
                          void (async () => {
                            const rows = all ? await all() : undefined
                            const source = rows ?? exportSourceRows(table)
                            await Promise.all(prepares.map((f) => f(source)))
                            exportTable(table, fmt, opts, rows)
                          })()
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
                  isHidden={(id) => columnVisibility[id] === false}
                  groupFor={groupFor}
                  loading={!!autoApi && catalogWanted && catalogQuery.isLoading}
                  onIntent={() => autoApi && setCatalogWanted(true)}
                  onApply={applyLayout}
                  onReset={resetLayout}
                />
              ) : (
                <DropdownMenu
                  onOpenChange={(o) => o && autoApi && setCatalogWanted(true)}
                >
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
                  <DropdownMenuContent
                    align="end"
                    className="max-h-[55vh] w-56 overflow-y-auto"
                  >
                    {table
                      .getAllColumns()
                      .filter((c) => c.getCanHide())
                      .map((c) => (
                        <DropdownMenuCheckboxItem
                          key={c.id}
                          checked={c.getIsVisible()}
                          onCheckedChange={(v) => c.toggleVisibility(!!v)}
                        >
                          <span className="truncate">
                            {resolveColumnLabel(c.id, c.columnDef)}
                          </span>
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
          `bg` doesn't leak past the border-radius on first/last rows. It can
          only scroll when it is narrower than the table: every flex item
          between here and the page needs `min-w-0`, or the chain grows to the
          table's width and the page clips it with no scrollbar at all.
          With `stickyHeader` the frame may shrink below the table's height,
          and the table container inside it (the element that scrolls, and so
          the one a sticky header sticks to) shrinks with it. */}
      <div
        className={cn(
          "overflow-x-auto rounded-lg border border-border",
          stickyHeader &&
            "flex min-h-0 flex-col [&>[data-slot=table-container]]:min-h-0"
        )}
      >
        <Table data-stripes={stripes ? "on" : "off"}>
          {/* The header tint is mixed into an opaque colour, never an alpha:
              rows and columns that scroll under a sticky header (or under the
              pinned actions cell) must not show through it. */}
          <TableHeader
            className={
              stickyHeader
                ? "sticky top-0 z-10 bg-[color-mix(in_oklab,var(--muted)_40%,var(--background))] shadow-[inset_0_-1px_0_var(--border)]"
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
                        ? "sticky right-0 z-20 bg-[color-mix(in_oklab,var(--muted)_40%,var(--background))] shadow-[inset_1px_0_0_var(--border)]"
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
          <TableBody
            onMouseLeave={onRowHover ? () => onRowHover(null) : undefined}
          >
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
                      onMouseEnter={
                        onRowHover ? () => onRowHover(null) : undefined
                      }
                    >
                      <TableCell
                        colSpan={table.getVisibleLeafColumns().length}
                        className="py-2"
                      >
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
                    className={cn(
                      rowClassName?.(row.original as T),
                      onRowClick && "cursor-pointer"
                    )}
                    style={rowStyle?.(row.original as T)}
                    onMouseEnter={
                      onRowHover ? () => onRowHover(row.original) : undefined
                    }
                    onClick={
                      onRowClick
                        ? (e) => {
                            if (isRowClick(e)) onRowClick(row.original, e)
                          }
                        : undefined
                    }
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
                  colSpan={table.getVisibleLeafColumns().length}
                  className="h-24 text-center text-sm text-muted-foreground"
                >
                  No results.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {/* One capped page of a longer list says so - a detail tab that fetches
          500 rows otherwise looks complete at exactly 500. */}
      {capped && (
        <p className="num px-1 text-[11px] text-muted-foreground">{capped}</p>
      )}

      {/* Pager - shown on every flat (non-grouped) list, even single-page ones,
          so the row count + rows-per-page control are always available (the
          selector persists to Settings → Preferences). In `serverPagination`
          mode the same row drives the server's page instead, and the
          rows-per-page control is dropped (the caller owns the page size). */}
      {/* An embedded, server-paged table with one page has nothing to
          page and nothing to say - "3 rows" under three rows is chrome. */}
      {(paged || serverPagination) &&
        !(embedded && serverPagination && pageTotal <= 1) && (
          <div className="flex items-center justify-between gap-2 text-xs whitespace-nowrap text-muted-foreground">
            <span className="num truncate">
              {rowTotal} {rowTotal === 1 ? "row" : "rows"}
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
              {/* One page needs no pager: "Page 1 of 1 · Prev · Next" under
                a three-row table is chrome with nothing to do. */}
              {pageTotal > 1 && (
                <span className="num">
                  Page{" "}
                  {serverPagination?.page ??
                    table.getState().pagination.pageIndex + 1}{" "}
                  of {pageTotal}
                </span>
              )}
              {pageTotal > 1 && (
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
              )}
              {pageTotal > 1 && (
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
              )}
            </div>
          </div>
        )}
    </div>
  )
}

/** What to say under a table holding one capped page of a longer list, or
 * null when it holds the lot. `total` is what the server reported; `shown`
 * is what arrived. */
export function truncationNotice(
  total: number | undefined,
  shown: number
): string | null {
  if (total == null || !Number.isFinite(total) || total <= shown) return null
  return `Showing the first ${shown.toLocaleString()} of ${total.toLocaleString()} - filter or open the full list to see the rest.`
}

// Turn a file-base name ("ip-ranges") into a heading ("Ip Ranges") for the
// export page when no explicit exportTitle is given.
function prettifyName(s: string): string {
  return s.replace(/[_-]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
}

// Words a column id spells in lower case that read as acronyms.
const ACRONYMS: Record<string, string> = {
  ip: "IP",
  ips: "IPs",
  vm: "VM",
  vms: "VMs",
  vlan: "VLAN",
  vlans: "VLANs",
  vrf: "VRF",
  vrfs: "VRFs",
  sla: "SLA",
  dhcp: "DHCP",
  dns: "DNS",
  mac: "MAC",
  mtu: "MTU",
  rd: "RD",
  cidr: "CIDR",
  cid: "CID",
  id: "ID",
  asn: "ASN",
  vcpus: "vCPUs",
  oob: "OOB",
  u: "U",
}

// Prettify a column id for the Columns menu: split on `_`/`-`, sentence case,
// acronyms kept ("primary_ip" → "Primary IP", "vlan_id" → "VLAN ID").
function prettifyColumnId(id: string): string {
  return id
    .split(/[_-]/)
    .filter(Boolean)
    .map((w, i) => {
      const lower = w.toLowerCase()
      if (ACRONYMS[lower]) return ACRONYMS[lower]
      return i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : lower
    })
    .join(" ")
}

// Resolve the human-readable label shown for a column in the Columns menu, in
// priority order: explicit `meta.label` → plain-string `header` → prettified id.
export function resolveColumnLabel(
  id: string,
  columnDef?: { header?: unknown; meta?: { label?: string } }
): string {
  const metaLabel = columnDef?.meta?.label
  if (typeof metaLabel === "string" && metaLabel.trim()) return metaLabel
  if (typeof columnDef?.header === "string" && columnDef.header.trim())
    return columnDef.header
  return prettifyColumnId(id)
}

// ─── Row clicks ──────────────────────────────────────────────────────────

/** The controls a cell can hold: a click on one is the control's own. */
const ROW_CONTROL = [
  "a",
  "button",
  "input",
  "select",
  "textarea",
  "label",
  "summary",
  "[contenteditable='true']",
  "[data-row-click='ignore']",
  ...[
    "button",
    "checkbox",
    "combobox",
    "link",
    "menuitem",
    "option",
    "radio",
    "switch",
    "tab",
  ].map((r) => `[role='${r}']`),
].join(",")

/**
 * Whether a click on a row (`currentTarget`) is the row's own, for
 * `onRowClick`: not on a link, checkbox, button or other control in a cell,
 * not the end of a text selection, and not from a menu or dialog a cell
 * opened (React bubbles those through their portal, from outside the row).
 */
export function isRowClick(e: {
  target: EventTarget | null
  currentTarget: EventTarget | null
  defaultPrevented?: boolean
}): boolean {
  const row = e.currentTarget
  const target = e.target
  if (e.defaultPrevented) return false
  if (!(row instanceof Element) || !(target instanceof Node)) return false
  if (!row.contains(target)) return false
  const el = target instanceof Element ? target : target.parentElement
  const control = el?.closest(ROW_CONTROL)
  if (control && control !== row && row.contains(control)) return false
  const selection = window.getSelection()
  if (selection && !selection.isCollapsed && selection.toString().trim())
    return false
  return true
}

// ─── Column-order helpers ────────────────────────────────────────────────
// Reordering only shuffles the *manageable* columns; pinned ones (select,
// actions) keep their natural slots. `applyManageableOrder` rebuilds the full
// TanStack columnOrder from a desired manageable sequence; `manageableSeq`
// extracts the current manageable sequence back out for the menu.

/** Slot ids the sequence has never seen (new feature columns) at their
 * *designed* position - right after the nearest preceding column the sequence
 * knows - instead of appending them at the far end, where a saved layout from
 * before the column existed would banish it off-screen. A saved layout lists
 * its shown columns before its hidden ones, so the anchor is the nearest
 * *shown* predecessor when `isShown` says which those are - a hidden one sits
 * in the tail and would drag the new column past everything on screen. */
function insertUnknownAtDesignedPosition(
  norm: string[],
  manageableIds: string[],
  isShown?: (id: string) => boolean
): void {
  for (const id of manageableIds) {
    if (norm.includes(id)) continue
    const defIdx = manageableIds.indexOf(id)
    let insertAt = -1
    for (const wantShown of isShown ? [true, false] : [false]) {
      for (let j = defIdx - 1; j >= 0; j--) {
        const prev = manageableIds[j]
        const at = norm.indexOf(prev)
        if (at !== -1 && (!wantShown || isShown!(prev))) {
          insertAt = at + 1
          break
        }
      }
      if (insertAt !== -1) break
    }
    norm.splice(Math.max(insertAt, 0), 0, id)
  }
}

export function applyManageableOrder(
  allIds: string[],
  manageableIds: string[],
  seq: string[],
  isShown?: (id: string) => boolean
): string[] {
  const mset = new Set(manageableIds)
  const norm = seq.filter((id) => mset.has(id))
  insertUnknownAtDesignedPosition(norm, manageableIds, isShown)
  let i = 0
  return allIds.map((id) => (mset.has(id) ? norm[i++] : id))
}

/** `order` from the Columns menu, with the saved ids it could not show (not
 * mounted right now) put back after the nearest saved predecessor it kept. */
export function carryUnmounted(
  order: string[],
  saved: string[],
  mounted: Set<string>
): string[] {
  const out = [...order]
  saved.forEach((id, i) => {
    if (mounted.has(id) || out.includes(id)) return
    let at = -1
    for (let j = i - 1; j >= 0 && at === -1; j--) at = out.indexOf(saved[j])
    out.splice(at + 1, 0, id)
  })
  return out
}

/** The rows an export writes when it is not handed any: the selection, else
 * everything the filters match. */
function exportSourceRows<T>(table: {
  getSelectedRowModel: () => {
    flatRows: { original: T; getIsGrouped: () => boolean }[]
  }
  getFilteredRowModel: () => {
    flatRows: { original: T; getIsGrouped: () => boolean }[]
  }
}): T[] {
  const selected = table
    .getSelectedRowModel()
    .flatRows.filter((r) => !r.getIsGrouped())
  const source = selected.length
    ? selected
    : table.getFilteredRowModel().flatRows.filter((r) => !r.getIsGrouped())
  return source.map((r) => r.original)
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
  const sorted = column.getIsSorted()
  // The active direction reads on the header itself - without it a sort
  // that reorders only a few rows looks like a click that did nothing.
  const Icon =
    sorted === "asc" ? ArrowUp : sorted === "desc" ? ArrowDown : ArrowUpDown
  return (
    <Button
      variant="ghost"
      size="sm"
      className={cn("-ml-3 h-7 px-2 text-xs", sorted && "text-foreground")}
      aria-sort={
        sorted === "asc"
          ? "ascending"
          : sorted === "desc"
            ? "descending"
            : undefined
      }
      onClick={() => column.toggleSorting(sorted === "asc")}
    >
      {label}
      <Icon
        className={cn("ml-1 h-3 w-3", sorted ? "opacity-100" : "opacity-60")}
      />
    </Button>
  )
}

/** True when every row has its own `id` (a string or number) and no two
 * share one - the rows can be keyed by it instead of by position. */
export function hasDistinctIds(rows: readonly unknown[]): boolean {
  if (rows.length === 0) return false
  const seen = new Set<string>()
  for (const r of rows) {
    const id = (r as { id?: unknown } | null)?.id
    if (typeof id !== "string" && typeof id !== "number") return false
    const key = String(id)
    if (seen.has(key)) return false
    seen.add(key)
  }
  return true
}

// Top-level rows by their own id; sub-rows as TanStack keys them.
function rowIdOf<T>(row: T, index: number, parent?: { id: string }): string {
  return parent
    ? `${parent.id}.${index}`
    : String((row as { id: string | number }).id)
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
