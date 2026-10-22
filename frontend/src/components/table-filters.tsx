import {
  type CellContext,
  type ColumnDef,
  type RowData,
} from "@tanstack/react-table"
import { useCallback, useMemo, useRef, useState } from "react"
import { flexRender } from "@tanstack/react-table"

import { Input } from "@/components/ui/input"
import { Slider } from "@/components/ui/slider"
import { evaluate, parse, type Expr } from "@/lib/filter-expr"
import { ExpressionFilter } from "@/components/filter-expression"
import {
  FacetGroup,
  FacetHeading,
  FilterRail,
  HideableFacet,
  tagObjectsLink,
  type FacetOption,
} from "@/components/filter-rail"
import { naturalCompare } from "@/lib/natural-sort"
import {
  decodeList,
  decodeRange,
  decodeText,
  encodeList,
  encodeRange,
  pruneUnknown,
  useListSearch,
  useSearchWriter,
  type RangeValue,
} from "@/lib/url-filters"

/** The advanced expression's id among a list's hideable facets. */
const EXPR_FACET_ID = "__expr"

// Auto-derive a filter rail from `ColumnDef.meta.facet`.
//
// Every list page that does this:
//
//   const cols = useMemo(() => [
//     {
//       id: "vrf",
//       accessorFn: r => r.vrf?.id ?? "__global__",
//       meta: { facet: { kind: "enum", label: "VRF",
//         get: r => r.vrf?.id ?? "__global__",
//         formatValue: (_v, r) => ({ label: r.vrf?.name ?? "Global", color: r.vrf?.color }),
//       }} satisfies ColumnMeta<Prefix, unknown>,
//       cell: ({ row }) => <VrfCell vrf={row.original.vrf} />,
//     },
//     // ... more columns
//   ], [])
//
//   const { rail, filteredRows } = useTableFilters(cols, rows)
//
//   return <>{rail}<DataTable data={filteredRows} columns={cols} /></>
//
// New column with a facet → filter rail picks it up automatically.

// ─── Type extension ────────────────────────────────────────────────────

export type FacetDef<TRow> =
  | EnumFacet<TRow>
  | TagsFacet<TRow>
  | RangeFacet<TRow>

interface EnumFacet<TRow> {
  kind: "enum"
  label?: string
  /** Extracts the bucket key from a row. Null = excluded from the facet. */
  get: (row: TRow) => string | null | undefined
  /** Optional renderer for a bucket - sample row helps pull display info
   * (a name + color) from a nested object whose key is the bucket id. */
  formatValue?: (
    value: string,
    sampleRow: TRow
  ) => { label: string; color?: string; textColor?: string }
  /** Hide the group when every row lands in the same bucket. A derived facet
   * ("is this catalog entry site-local?", "has this type been laid out?") is
   * only worth rail space where the data actually splits - ticking its one
   * option would select every row. Off by default: a facet over real catalog
   * objects still reads as a list of what exists. */
  hideWhenSingle?: boolean
}

interface TagsFacet<TRow> {
  kind: "tags"
  label?: string
  get: (row: TRow) => Array<{
    /** The tag's id, for the rail's link to everything carrying it. */
    id?: number | string
    slug: string
    name: string
    color?: string
    text_color?: string
  }>
}

interface RangeFacet<TRow> {
  kind: "range"
  label?: string
  get: (row: TRow) => number | null | undefined
  min?: number
  max?: number
  unit?: string
  placeholder?: { min?: string; max?: string }
}

// TanStack ColumnMeta is declaration-merge-extendable.
declare module "@tanstack/react-table" {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface ColumnMeta<TData extends RowData, TValue> {
    facet?: FacetDef<TData>
    /** Set by useTableFilters on a tags column: the rail's current selection
     * and its toggle, so the chips in the cells filter the table too. */
    tagFacet?: { active: Set<string>; toggle: (slug: string) => void }
    /** Enum facets whose cell is a plain badge (status, role, family…) should
     * not turn into a click target - set when the cell is already a link. */
    facetClickable?: boolean
    /** Explicit label for the Columns dropdown menu. Overrides the column's
     * string header / prettified id when resolving the menu's display text. */
    label?: string
    /** Plain-text value for table export (CSV / HTML / print). Escape hatch
     * for columns whose displayed cell differs from the raw accessor value;
     * omit and the exporter falls back to the column's accessor. */
    export?: {
      header?: string
      value: (row: TData) => string | number | null | undefined
    }
    /** Runs before an export when the column is shown - e.g. fetching the
     * labels an object reference exports as, so the file holds names. */
    prepareExport?: (rows: TData[]) => Promise<void>
    /** Hidden until ticked in the Columns menu (a saved layout that ticked
     * it wins). Catalog and custom-field columns set it. */
    defaultHidden?: boolean
    /** Section in the Columns menu's "Available" list; hand-written columns
     * default to "Columns". */
    group?: "fields" | "related" | "custom"
    /** The list-row key(s) this column shows, when its id is not that key
     * (`type` shows `device_type`) - so the catalog does not offer the same
     * field twice. */
    field?: string | string[]
    /** Set by DataTable on a cell-only column it gave an accessor so the
     * search box can read it; the export still treats it as cell-only. */
    searchOnly?: boolean
  }
}

// ─── Internal state shapes ─────────────────────────────────────────────

type RangeState = RangeValue
type FacetValue = Set<string> | RangeState
type FacetState = Record<string, FacetValue>

const EMPTY_SET: Set<string> = new Set()
const OPEN_RANGE: RangeState = { min: "", max: "" }

interface FacetEntry<TRow> {
  id: string
  def: FacetDef<TRow>
}

/** Where a list keeps its selection: React state (an embedded table) or the
 * URL (a list page). The engine below is the same for both. */
interface FacetStore {
  state: FacetState
  expr: string
  /** Functional update of one facet - stable. */
  update: (id: string, fn: (cur: FacetValue | undefined) => FacetValue) => void
  setExpr: (text: string) => void
  /** Replace every facet and the expression in one write (saved views). */
  replaceAll: (next: FacetState, expr: string) => void
}

function useFacetEntries<TRow>(
  columns: ColumnDef<TRow, unknown>[]
): FacetEntry<TRow>[] {
  // Memoize: a new facets array reference every render would cascade
  // through every downstream useMemo and trigger an infinite update loop
  // when the parent's selection / data changes.
  return useMemo<FacetEntry<TRow>[]>(() => {
    const out: FacetEntry<TRow>[] = []
    for (const col of columns) {
      const f = col.meta?.facet
      if (!f) continue
      const id =
        col.id ?? (typeof col.header === "string" ? col.header : undefined)
      if (!id) continue
      out.push({ id, def: f })
    }
    return out
  }, [columns])
}

function useLocalFacetStore(
  initialEnums?: Record<string, string[]>
): FacetStore {
  // Lazy initializer so the seed only applies on mount - later user toggles
  // own the state and aren't clobbered on re-render.
  const [state, setState] = useState<FacetState>(() => {
    if (!initialEnums) return {}
    const seed: FacetState = {}
    for (const [id, values] of Object.entries(initialEnums)) {
      if (values.length) seed[id] = new Set(values)
    }
    return seed
  })
  const [expr, setExpr] = useState("")
  const update = useCallback(
    (id: string, fn: (cur: FacetValue | undefined) => FacetValue) =>
      setState((s) => ({ ...s, [id]: fn(s[id]) })),
    []
  )
  const replaceAll = useCallback((next: FacetState, text: string) => {
    setState(next)
    setExpr(text)
  }, [])
  return { state, expr, update, setExpr, replaceAll }
}

/** Params a facet can never be named, because the list uses them itself. */
const RESERVED_PARAMS = new Set(["q", "expr", "tab", "sub", "page", "view"])

/** The URL param each facet is kept under: the facet's id, `tag` for a tags
 * facet, or an explicit name from `params` (a legacy deep-link name). */
export function facetParams(
  facets: { id: string; def: { kind: string } }[],
  params?: Record<string, string>
): Map<string, { param: string; range: boolean }> {
  const out = new Map<string, { param: string; range: boolean }>()
  const used = new Set<string>()
  for (const { id, def } of facets) {
    let param = params?.[id] ?? (def.kind === "tags" ? "tag" : id)
    if (used.has(param)) param = id
    if (RESERVED_PARAMS.has(param) || used.has(param)) param = `f_${id}`
    used.add(param)
    out.set(id, { param, range: def.kind === "range" })
  }
  return out
}

function readFacet(raw: unknown, range: boolean): FacetValue {
  return range ? decodeRange(raw) : new Set(decodeList(raw))
}

function writeFacet(value: FacetValue | undefined): string | undefined {
  if (!value) return undefined
  return value instanceof Set ? encodeList(value) : encodeRange(value)
}

function useUrlFacetStore<TRow>(
  facets: FacetEntry<TRow>[],
  params?: Record<string, string>
): FacetStore {
  const search = useListSearch()
  const write = useSearchWriter()
  const paramsKey = JSON.stringify(params ?? {})
  const map = useMemo(
    () => facetParams(facets, params),
    [facets, paramsKey]
  )
  const mapRef = useRef(map)
  mapRef.current = map

  // Keyed on the text of this list's own params, so the selection keeps its
  // identity while anything else in the URL changes.
  const sig = JSON.stringify(
    [...map.values()].map(({ param }) => search[param] ?? null)
  )
  const state = useMemo(() => {
    const out: FacetState = {}
    for (const [id, { param, range }] of map) {
      const raw = search[param]
      if (raw !== undefined && raw !== null) out[id] = readFacet(raw, range)
    }
    return out
  }, [sig, map])
  const expr = decodeText(search.expr)

  const update = useCallback(
    (id: string, fn: (cur: FacetValue | undefined) => FacetValue) =>
      write((prev) => {
        const m = mapRef.current.get(id)
        if (!m) return prev
        const cur =
          prev[m.param] === undefined
            ? undefined
            : readFacet(prev[m.param], m.range)
        return { ...prev, [m.param]: writeFacet(fn(cur)) }
      }),
    [write]
  )
  const setExpr = useCallback(
    (text: string) =>
      write((prev) => ({ ...prev, expr: text.trim() ? text : undefined })),
    [write]
  )
  const replaceAll = useCallback(
    (next: FacetState, text: string) =>
      write((prev) => {
        const out = { ...prev }
        for (const [id, { param }] of mapRef.current)
          out[param] = writeFacet(next[id])
        out.expr = text.trim() ? text : undefined
        return out
      }),
    [write]
  )
  return { state, expr, update, setExpr, replaceAll }
}

// ─── Hook ──────────────────────────────────────────────────────────────

export interface UseTableFiltersResult<TRow> {
  rail: React.ReactNode
  filteredRows: TRow[]
  /** The columns handed in, with every tags facet wired to the rail - pass
   * THESE to the table so tag chips toggle the filter. */
  columns: ColumnDef<TRow, unknown>[]
  /** Number of active facet filters (for header badges). */
  activeCount: number
  /** Toggle one value in an enum/tags facet from OUTSIDE the rail - e.g. a
   * clickable tag chip inside a table cell. Referentially stable. */
  toggleValue: (id: string, value: string) => void
  /** Current selection of an enum/tags facet (empty set when untouched) -
   * lets cells highlight their active chips. */
  selectedValues: (id: string) => Set<string>
  /** The whole selection as plain JSON, and the way back. This is what makes a
   * *saved view* possible without a per-model filter grammar: the rail is
   * derived from the columns a list renders, so its state describes that list
   * completely, and any list built this way can save and restore one. */
  snapshot: () => FilterSnapshot
  restore: (snapshot: FilterSnapshot | null | undefined) => void
}

/** Facet selections in a form that survives JSON - sets become arrays. The
 * reserved `__expr` key carries the advanced filter expression (a string in
 * the lib/filter-expr grammar), so saved views capture it too. */
export type FilterSnapshot = Record<string, string[] | RangeState | string>

interface RailOpts {
  /** Extra controls at the top of the rail, above the facets - toggles
   * that belong to this table but are not facets (Show available…). */
  railExtras?: React.ReactNode
}

/**
 * Filters for a table embedded in another page (a detail tab, a settings
 * panel): the selection lives in React state. A list page uses
 * {@link useUrlTableFilters} instead, so its filters live in the URL.
 */
export function useTableFilters<TRow>(
  columns: ColumnDef<TRow, unknown>[],
  rows: TRow[],
  // Seed enum facets on first render. Keyed by column.id → the values to
  // preselect.
  initialEnums?: Record<string, string[]>,
  railOpts?: RailOpts
): UseTableFiltersResult<TRow> {
  const facets = useFacetEntries(columns)
  const store = useLocalFacetStore(initialEnums)
  return useFilterEngine(columns, facets, rows, store, railOpts)
}

export interface UrlTableFilterOpts extends RailOpts {
  /** A facet kept under a param other than its id, e.g. a deep-link name a
   * dashboard already links with. Keyed by facet (column) id. */
  params?: Record<string, string>
}

/**
 * Filters for a list page: every facet, and the advanced filter, live in the
 * URL (see lib/url-filters), so reload, Back and a shared link all keep them.
 * `/devices?status=active&tag=core` lands on the filtered list.
 */
export function useUrlTableFilters<TRow>(
  columns: ColumnDef<TRow, unknown>[],
  rows: TRow[],
  opts?: UrlTableFilterOpts
): UseTableFiltersResult<TRow> {
  const facets = useFacetEntries(columns)
  const store = useUrlFacetStore(facets, opts?.params)
  return useFilterEngine(columns, facets, rows, store, opts)
}

function useFilterEngine<TRow>(
  columns: ColumnDef<TRow, unknown>[],
  facets: FacetEntry<TRow>[],
  rows: TRow[],
  store: FacetStore,
  railOpts?: RailOpts
): UseTableFiltersResult<TRow> {
  const { state, expr: exprText, update, setExpr: setExprText } = store

  // The advanced filter: one expression (lib/filter-expr grammar) applied on
  // top of the facets. Kept as text - the single format the builder, the text
  // editor and the saved-view snapshot all share.
  const exprAst = useMemo<Expr | null>(() => {
    try {
      return parse(exprText)
    } catch {
      return null // an invalid committed expression filters nothing
    }
  }, [exprText])

  // Per-facet option lists, rebuilt when rows change.
  const options = useMemo(() => {
    const map: Record<string, FacetOption[]> = {}
    for (const { id, def } of facets) {
      if (def.kind === "enum") {
        const buckets: Record<string, { count: number; sample: TRow }> = {}
        for (const r of rows) {
          const v = def.get(r)
          if (v === null || v === undefined) continue
          if (!buckets[v]) buckets[v] = { count: 0, sample: r }
          buckets[v].count++
        }
        map[id] = Object.entries(buckets)
          .map(([value, { count, sample }]) => {
            const fmt = def.formatValue?.(value, sample)
            return {
              value,
              label: fmt?.label ?? value,
              count,
              color: fmt?.color,
              textColor: fmt?.textColor,
            }
          })
          .sort((a, b) => b.count - a.count || naturalCompare(a.label, b.label))
      } else if (def.kind === "tags") {
        const tags: Record<string, FacetOption> = {}
        for (const r of rows) {
          for (const t of def.get(r)) {
            if (!tags[t.slug]) {
              tags[t.slug] = {
                value: t.slug,
                label: t.name,
                count: 0,
                color: t.color,
                textColor: t.text_color,
                link:
                  t.id !== undefined && t.id !== null
                    ? tagObjectsLink(t.id)
                    : undefined,
              }
            }
            tags[t.slug].count++
          }
        }
        map[id] = Object.values(tags).sort((a, b) => b.count - a.count)
      } else {
        // range: no options list - rendered as min/max inputs.
        map[id] = []
      }
    }
    return map
  }, [rows, facets])

  // The selection the list applies: a value no row carries (a stale link, a
  // hand-typed param) is ignored rather than emptying the table.
  const selection = useMemo(() => {
    const out: FacetState = {}
    for (const { id } of facets) {
      const s = state[id]
      if (!s) continue
      out[id] =
        s instanceof Set
          ? pruneUnknown(
              s,
              rows.length ? (options[id] ?? []).map((o) => o.value) : null
            )
          : s
    }
    return out
  }, [state, facets, options, rows.length])

  const knownRef = useRef<Record<string, string[] | null>>({})
  knownRef.current = Object.fromEntries(
    Object.entries(options).map(([id, opts]) => [
      id,
      rows.length ? opts.map((o) => o.value) : null,
    ])
  )

  const toggleValue = useCallback(
    (id: string, value: string) =>
      update(id, (cur) => {
        const base = cur instanceof Set ? cur : EMPTY_SET
        const next = new Set(pruneUnknown(base, knownRef.current[id]))
        if (next.has(value)) next.delete(value)
        else next.add(value)
        return next
      }),
    [update]
  )
  const setRange = (id: string, next: RangeState) => update(id, () => next)
  const selectedValues = useCallback(
    (id: string) => {
      const s = selection[id]
      return s instanceof Set ? s : EMPTY_SET
    },
    [selection]
  )

  // Apply every active filter.
  const filteredRows = useMemo(() => {
    return rows.filter((row) => {
      if (exprAst && !evaluate(exprAst, row)) return false
      for (const { id, def } of facets) {
        const s = selection[id]
        if (!s) continue

        if (def.kind === "enum") {
          const set = s as Set<string>
          if (set.size === 0) continue
          const v = def.get(row)
          if (v === null || v === undefined || !set.has(v)) return false
        } else if (def.kind === "tags") {
          const set = s as Set<string>
          if (set.size === 0) continue
          const have = def.get(row).map((t) => t.slug)
          if (!have.some((slug) => set.has(slug))) return false
        } else {
          const r = s as RangeState
          const min = r.min === "" ? null : Number(r.min)
          const max = r.max === "" ? null : Number(r.max)
          if (min === null && max === null) continue
          const v = def.get(row)
          if (v === null || v === undefined) return false
          if (min !== null && v < min) return false
          if (max !== null && v > max) return false
        }
      }
      return true
    })
  }, [rows, selection, facets, exprAst])

  // Count of facets with any active selection (for the page header).
  let activeCount = exprAst ? 1 : 0
  for (const { id, def } of facets) {
    const s = selection[id]
    if (!s) continue
    if (def.kind === "enum" || def.kind === "tags") {
      if ((s as Set<string>).size > 0) activeCount++
    } else {
      const r = s as RangeState
      if (r.min !== "" || r.max !== "") activeCount++
    }
  }

  // Render the rail.
  const rail =
    facets.length === 0 && !railOpts?.railExtras ? null : (
      <FilterRail>
        {railOpts?.railExtras}
        <HideableFacet
          id={EXPR_FACET_ID}
          label="Advanced"
          active={exprText.trim() !== ""}
        >
          {(onHide) => (
            <ExpressionFilter
              value={exprText}
              onChange={setExprText}
              rows={rows}
              onHide={onHide}
            />
          )}
        </HideableFacet>
        {facets.map(({ id, def }) => {
          const label = def.label ?? id
          if (def.kind === "range") {
            const cur = (selection[id] as RangeState | undefined) ?? OPEN_RANGE
            return (
              <HideableFacet
                key={id}
                id={id}
                label={label}
                active={cur.min !== "" || cur.max !== ""}
              >
                {(onHide) => (
                  <RangeFacetGroup
                    label={label}
                    value={cur}
                    onChange={(next) => setRange(id, next)}
                    onHide={onHide}
                    min={def.min}
                    max={def.max}
                    unit={def.unit}
                    placeholder={def.placeholder}
                  />
                )}
              </HideableFacet>
            )
          }
          const opts = options[id] ?? []
          // A single-bucket enum filters nothing - drop it rather than spend a
          // rail row on it. (FacetGroup already hides an empty one.)
          if (def.kind === "enum" && def.hideWhenSingle && opts.length < 2)
            return null
          return (
            <FacetGroup
              key={id}
              facetId={id}
              label={label}
              options={opts}
              selected={selectedValues(id)}
              onToggle={(v) => toggleValue(id, v)}
            />
          )
        })}
      </FilterRail>
    )

  const snapshot = useCallback((): FilterSnapshot => {
    const out: FilterSnapshot = {}
    for (const [id, value] of Object.entries(selection)) {
      if (value instanceof Set) {
        if (value.size) out[id] = [...value].sort()
      } else if (value && (value.min !== "" || value.max !== "")) {
        out[id] = value
      }
    }
    if (exprText.trim()) out.__expr = exprText
    return out
  }, [selection, exprText])

  const { replaceAll } = store
  const restore = useCallback(
    (saved: FilterSnapshot | null | undefined) => {
      // Replaces the selection outright rather than merging: applying a saved
      // view must show exactly what it describes, not what it describes plus
      // whatever was already ticked.
      const next: FacetState = {}
      let expr = ""
      for (const [id, value] of Object.entries(saved ?? {})) {
        if (id === "__expr") {
          if (typeof value === "string") expr = value
          continue
        }
        if (typeof value === "string") continue // future reserved keys
        next[id] = Array.isArray(value)
          ? new Set(value)
          : { min: String(value.min ?? ""), max: String(value.max ?? "") }
      }
      replaceAll(next, expr)
    },
    [replaceAll]
  )

  // Facet columns get the rail's selection + toggle wired into their cells:
  // a tag chip toggles its tag, and an enum badge (status, role, family…)
  // toggles its bucket - clicking in the table filters exactly like ticking
  // the rail. A click that lands on a link or button inside the cell is left
  // alone, so FK cells keep navigating.
  const wiredColumns = useMemo(
    () => wireFacetColumns(columns, selectedValues, toggleValue),
    [columns, selectedValues, toggleValue]
  )

  return {
    rail,
    columns: wiredColumns,
    filteredRows,
    activeCount,
    toggleValue,
    selectedValues,
    snapshot,
    restore,
  }
}

// ─── Range facet ───────────────────────────────────────────────────────

function RangeFacetGroup({
  label,
  value,
  onChange,
  onHide,
  min,
  max,
  unit,
  placeholder,
}: {
  label: string
  value: { min: string; max: string }
  onChange: (v: { min: string; max: string }) => void
  onHide?: () => void
  min?: number
  max?: number
  unit?: string
  placeholder?: { min?: string; max?: string }
}) {
  const engaged = value.min !== "" || value.max !== ""
  const header = (
    <FacetHeading
      label={label}
      onHide={onHide}
      onClear={engaged ? () => onChange({ min: "", max: "" }) : undefined}
    />
  )

  // With known bounds the range renders as a dual-thumb slider (utilisation,
  // percentages…). Unbounded ranges keep the min/max inputs.
  if (min !== undefined && max !== undefined) {
    const lo = value.min === "" ? min : Number(value.min)
    const hi = value.max === "" ? max : Number(value.max)
    return (
      <div>
        {header}
        <Slider
          min={min}
          max={max}
          value={[lo, hi]}
          onValueChange={([nextLo, nextHi]) =>
            onChange({
              min: nextLo === min ? "" : String(nextLo),
              max: nextHi === max ? "" : String(nextHi),
            })
          }
          className="py-1"
        />
        <div className="num mt-1 flex justify-between text-[11px] text-muted-foreground">
          <span>
            {lo}
            {unit}
          </span>
          <span>
            {hi}
            {unit}
          </span>
        </div>
      </div>
    )
  }

  return (
    <div>
      {header}
      <div className="flex items-center gap-1.5">
        <Input
          type="number"
          min={min}
          max={max}
          inputMode="numeric"
          placeholder={
            placeholder?.min ?? (min !== undefined ? String(min) : "")
          }
          value={value.min}
          onChange={(e) => onChange({ ...value, min: e.target.value })}
          aria-label={`Minimum ${label}`}
          className="h-7 px-2 text-xs"
        />
        <span className="text-[11px] text-muted-foreground">to</span>
        <Input
          type="number"
          min={min}
          max={max}
          inputMode="numeric"
          placeholder={
            placeholder?.max ?? (max !== undefined ? String(max) : "")
          }
          value={value.max}
          onChange={(e) => onChange({ ...value, max: e.target.value })}
          aria-label={`Maximum ${label}`}
          className="h-7 px-2 text-xs"
        />
        {unit && (
          <span className="text-[11px] text-muted-foreground">{unit}</span>
        )}
      </div>
    </div>
  )
}

/** Wire a column set to a rail's selection: a tags column gets the active
 * slugs + toggle on its meta, and an enum-facet column's cell is wrapped so
 * clicking the badge toggles that bucket. `useTableFilters` returns its input
 * columns wired this way; a list that renders a different column set than the
 * one it derived the rail from (nesting, actions, monitoring extras) wires
 * the render set with this directly. */
export function wireFacetColumns<TRow>(
  columns: ColumnDef<TRow, unknown>[],
  selectedValues: (id: string) => Set<string>,
  toggleValue: (id: string, value: string) => void
): ColumnDef<TRow, unknown>[] {
  return columns.map((col) => {
    const id =
      col.id ?? (typeof col.header === "string" ? col.header : undefined)
    const def = col.meta?.facet
    if (!id || !def) return col
    if (def.kind === "tags")
      return {
        ...col,
        meta: {
          ...col.meta,
          tagFacet: {
            active: selectedValues(id),
            toggle: (slug: string) => toggleValue(id, slug),
          },
        },
      }
    if (def.kind !== "enum" || col.meta?.facetClickable === false) return col
    const inner = col.cell
    return {
      ...col,
      cell: (ctx: CellContext<TRow, unknown>) => {
        const value = def.get(ctx.row.original) ?? null
        return (
          <FacetClickCell value={value} toggle={(v) => toggleValue(id, v)}>
            {inner ? flexRender(inner, ctx) : String(ctx.getValue() ?? "")}
          </FacetClickCell>
        )
      },
    }
  })
}

/** Wraps a facet cell so clicking the badge toggles its bucket. Clicks on a
 * link or button inside the cell fall through untouched. */
export function FacetClickCell({
  value,
  toggle,
  children,
}: {
  value: string | null
  toggle: (value: string) => void
  children: React.ReactNode
}) {
  if (value === null) return <>{children}</>
  return (
    <span
      onClick={(e) => {
        if (
          (e.target as HTMLElement).closest("a, button, input, [role=menuitem]")
        )
          return
        e.stopPropagation()
        toggle(value)
      }}
      // No active-state outline. A ring here drew a box round every cell in
      // a filtered column, which read as the rows having been singled out -
      // the filter rail already says what is filtered.
      className="inline-flex cursor-pointer rounded-md"
    >
      {children}
    </span>
  )
}
