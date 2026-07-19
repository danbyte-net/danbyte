import { type ColumnDef, type RowData } from "@tanstack/react-table"
import { useCallback, useMemo, useState } from "react"

import { Input } from "@/components/ui/input"
import { Slider } from "@/components/ui/slider"
import {
  FacetGroup,
  FilterRail,
  toggleInSet,
  type FacetOption,
} from "@/components/filter-rail"

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
  /** Optional renderer for a bucket — sample row helps pull display info
   * (a name + color) from a nested object whose key is the bucket id. */
  formatValue?: (
    value: string,
    sampleRow: TRow
  ) => { label: string; color?: string; textColor?: string }
}

interface TagsFacet<TRow> {
  kind: "tags"
  label?: string
  get: (row: TRow) => Array<{
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
  }
}

// ─── Internal state shapes ─────────────────────────────────────────────

type EnumState = Set<string>
type TagsState = Set<string>
type RangeState = { min: string; max: string }

const EMPTY_SET: Set<string> = new Set()

interface FacetEntry<TRow> {
  id: string
  def: FacetDef<TRow>
}

// ─── Hook ──────────────────────────────────────────────────────────────

export interface UseTableFiltersResult<TRow> {
  rail: React.ReactNode
  filteredRows: TRow[]
  /** Number of active facet filters (for header badges). */
  activeCount: number
  /** Toggle one value in an enum/tags facet from OUTSIDE the rail — e.g. a
   * clickable tag chip inside a table cell. Referentially stable. */
  toggleValue: (id: string, value: string) => void
  /** Current selection of an enum/tags facet (empty set when untouched) —
   * lets cells highlight their active chips. */
  selectedValues: (id: string) => Set<string>
}

export function useTableFilters<TRow>(
  columns: ColumnDef<TRow, unknown>[],
  rows: TRow[],
  // Seed enum facets on first render, e.g. from a URL search param so a link
  // like `/devices?type=<id>` lands on the pre-filtered table (NetBox-style
  // cross-object linkage). Keyed by column.id → the values to preselect.
  initialEnums?: Record<string, string[]>
): UseTableFiltersResult<TRow> {
  // Memoize: a new facets array reference every render would cascade
  // through every downstream useMemo and trigger an infinite update loop
  // when the parent's selection / data changes.
  const facets = useMemo<FacetEntry<TRow>[]>(() => {
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

  // Single state object keyed by column.id. Stable across renders.
  // Lazy initializer so the seed only applies on mount — later user toggles
  // own the state and aren't clobbered on re-render.
  const [state, setState] = useState<
    Record<string, EnumState | TagsState | RangeState>
  >(() => {
    if (!initialEnums) return {}
    const seed: Record<string, EnumState> = {}
    for (const [id, values] of Object.entries(initialEnums)) {
      if (values.length) seed[id] = new Set(values)
    }
    return seed
  })

  const setEnum = (id: string, next: Set<string>) =>
    setState((s) => ({ ...s, [id]: next }))
  const setRange = (id: string, next: RangeState) =>
    setState((s) => ({ ...s, [id]: next }))

  const toggleValue = useCallback((id: string, value: string) => {
    setState((s) => {
      const next = new Set((s[id] as Set<string> | undefined) ?? [])
      if (next.has(value)) next.delete(value)
      else next.add(value)
      return { ...s, [id]: next }
    })
  }, [])
  const selectedValues = useCallback(
    (id: string) => (state[id] as Set<string> | undefined) ?? EMPTY_SET,
    [state]
  )

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
          .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
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
              }
            }
            tags[t.slug].count++
          }
        }
        map[id] = Object.values(tags).sort((a, b) => b.count - a.count)
      } else {
        // range: no options list — rendered as min/max inputs.
        map[id] = []
      }
    }
    return map
  }, [rows, facets])

  // Apply every active filter.
  const filteredRows = useMemo(() => {
    return rows.filter((row) => {
      for (const { id, def } of facets) {
        const s = state[id]
        if (!s) continue

        if (def.kind === "enum") {
          const set = s as EnumState
          if (set.size === 0) continue
          const v = def.get(row)
          if (v === null || v === undefined || !set.has(v)) return false
        } else if (def.kind === "tags") {
          const set = s as TagsState
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
  }, [rows, state, facets])

  // Count of facets with any active selection (for the page header).
  let activeCount = 0
  for (const { id, def } of facets) {
    const s = state[id]
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
    facets.length === 0 ? null : (
      <FilterRail>
        {facets.map(({ id, def }) => {
          const label = def.label ?? id
          if (def.kind === "range") {
            const cur = (state[id] as RangeState) ?? { min: "", max: "" }
            return (
              <RangeFacetGroup
                key={id}
                label={label}
                value={cur}
                onChange={(next) => setRange(id, next)}
                min={def.min}
                max={def.max}
                unit={def.unit}
                placeholder={def.placeholder}
              />
            )
          }
          const cur = (state[id] as Set<string>) ?? new Set<string>()
          return (
            <FacetGroup
              key={id}
              label={label}
              options={options[id] ?? []}
              selected={cur}
              onToggle={(v) => toggleInSet(cur, v, (next) => setEnum(id, next))}
            />
          )
        })}
      </FilterRail>
    )

  return { rail, filteredRows, activeCount, toggleValue, selectedValues }
}

// ─── Range facet ───────────────────────────────────────────────────────

function RangeFacetGroup({
  label,
  value,
  onChange,
  min,
  max,
  unit,
  placeholder,
}: {
  label: string
  value: { min: string; max: string }
  onChange: (v: { min: string; max: string }) => void
  min?: number
  max?: number
  unit?: string
  placeholder?: { min?: string; max?: string }
}) {
  const engaged = value.min !== "" || value.max !== ""
  const header = (
    <div className="mb-1.5 flex items-center justify-between">
      <h3 className="text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
        {label}
      </h3>
      {engaged && (
        <button
          type="button"
          onClick={() => onChange({ min: "", max: "" })}
          className="text-[10px] text-muted-foreground hover:text-foreground"
        >
          clear
        </button>
      )}
    </div>
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
          className="h-7 px-2 text-xs"
        />
        {unit && (
          <span className="text-[11px] text-muted-foreground">{unit}</span>
        )}
      </div>
    </div>
  )
}
