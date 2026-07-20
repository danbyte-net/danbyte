import { useEffect, useMemo, useState } from "react"
import { keepPreviousData, useQuery } from "@tanstack/react-query"
import { SlidersHorizontal } from "lucide-react"

import { api, type Paginated } from "@/lib/api"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Combobox } from "@/components/ui/combobox"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Field } from "@/components/forms/field"
import { FormSelect, type SelectOption } from "@/components/forms/select"

const PAGE_SIZE = 250

/** One dropdown in the advanced-search modal, mapped to a list query param. */
export interface PickerFilter {
  /** Query param sent to the object list endpoint (e.g. "site", "tag"). */
  key: string
  label: string
  /** Options list endpoint (usually a ?picker=1 shape). */
  endpoint: string
  /** Shared react-query key — reuse the app-wide one for this endpoint. */
  queryKey: string
  /** Param value for an option (default: its id). Tags use the slug. */
  paramOf?: (o: never) => string
  /** Display label for an option (default: its name). */
  textOf?: (o: never) => string
}

export interface PickerColumn<T> {
  header: string
  cell: (row: T) => React.ReactNode
}

/** Everything type-specific about a picker — endpoints, filters, columns.
 * The generic core handles the combobox, the modal, paging, debouncing,
 * exclusion, and selected-value hydration. */
export interface ObjectPickerSpec<
  T extends { id: string },
  O extends { id: string } = { id: string; name: string },
> {
  /** Noun for labels/placeholders ("device", "rack", "VLAN"). */
  noun: string
  /** Compact combobox option list (the ?picker=1 shape). */
  pickerEndpoint: string
  /** Shared react-query key for the compact list. */
  pickerQueryKey: readonly unknown[]
  /** Option → combobox label (default: o.name). */
  optionLabel?: (o: O) => string
  /** Option → extra combobox state (ghosting: disabled + trailing hint). */
  optionState?: (o: O) => { disabled?: boolean; hint?: string }
  /** Detail endpoint for hydrating a selected id the compact list lacks. */
  detailEndpoint: (id: string) => string
  detailQueryKey: (id: string) => readonly unknown[]
  detailLabel?: (row: T) => string
  /** Full list endpoint the modal queries (server-side filtering). */
  listEndpoint: string
  /** Placeholder for the modal's free-text search. */
  searchHint?: string
  filters: PickerFilter[]
  columns: PickerColumn<T>[]
  /** Modal row → disabled state + note (e.g. "in <stack>"). */
  rowState?: (row: T) => { disabled?: boolean; note?: string }
}

export interface ObjectPickerProps {
  value: string | null
  onChange: (v: string | null) => void
  label: string
  hint?: string
  error?: string
  disabled?: boolean
  /** Clear-to-null row label in the combobox (e.g. "No device"). */
  noneLabel?: string
  placeholder?: string
  searchPlaceholder?: string
  emptyText?: string
  /** Optional trailing control — e.g. a QuickAdd "+" button. */
  quickAdd?: React.ReactNode
  /** Ids hidden from both the combobox and the modal table. */
  excludeIds?: string[]
  /** Custom-field definition whose scope should restrict picker results. */
  customFieldId?: string
  /** Pre-seed the advanced dialog's filters (e.g. {role: "<id>"}), so a
   * context-aware caller (a CCTV floor tile) opens it already narrowed. */
  initialFilters?: Record<string, string>
  /** Query fragment (e.g. "role=<id>") whose matches sort FIRST in the
   * combobox — context-relevant options float to the top, everything else
   * stays reachable below. */
  preferQuery?: string
}

/**
 * Generic object selector: a searchable combobox (compact ?picker=1 list)
 * plus a sliders button opening an advanced-search modal with server-side
 * filters and a paginated result table. Field-wrapper contract matches
 * FormCombobox, so call sites swap 1:1. Concrete pickers (DevicePicker,
 * RackPicker, VLANPicker, …) are thin specs over this core.
 */
export function ObjectPicker<
  T extends { id: string },
  O extends { id: string } = { id: string; name: string },
>({
  spec,
  value,
  onChange,
  label,
  hint,
  error,
  disabled,
  noneLabel,
  placeholder,
  searchPlaceholder,
  emptyText,
  quickAdd,
  excludeIds,
  customFieldId,
  initialFilters,
  preferQuery,
}: ObjectPickerProps & { spec: ObjectPickerSpec<T, O> }) {
  const [advancedOpen, setAdvancedOpen] = useState(false)

  const compact = useQuery({
    queryKey: [...spec.pickerQueryKey, customFieldId ?? ""],
    queryFn: () =>
      api<Paginated<O>>(withCustomField(spec.pickerEndpoint, customFieldId)),
    staleTime: 10 * 60_000,
  })
  // Context-relevant subset (e.g. devices with the floor tile's role) — its
  // ids float to the top of the combobox.
  const sep = spec.pickerEndpoint.includes("?") ? "&" : "?"
  const preferred = useQuery({
    queryKey: [...spec.pickerQueryKey, "prefer", preferQuery ?? ""],
    queryFn: () =>
      api<Paginated<{ id: string }>>(
        `${spec.pickerEndpoint}${sep}${preferQuery}`
      ),
    enabled: !!preferQuery,
    staleTime: 10 * 60_000,
  })
  const preferredIds = useMemo(
    () => new Set((preferred.data?.results ?? []).map((o) => o.id)),
    [preferred.data]
  )

  const exclude = useMemo(() => new Set(excludeIds ?? []), [excludeIds])
  const options = useMemo(() => {
    const all = (compact.data?.results ?? [])
      .filter((o) => !exclude.has(o.id))
      .map((o) => ({
        value: o.id,
        // Objects without a `name` (IPs, prefixes) must set optionLabel.
        label: spec.optionLabel
          ? spec.optionLabel(o)
          : ((o as { name?: string }).name ?? o.id),
        ...(spec.optionState ? spec.optionState(o) : {}),
      }))
    if (preferredIds.size === 0) return all
    // Stable partition: preferred first, original order kept within each half.
    return [
      ...all.filter((o) => preferredIds.has(o.value)),
      ...all.filter((o) => !preferredIds.has(o.value)),
    ]
  }, [compact.data, exclude, spec, preferredIds])

  // The compact list is only the first page — hydrate a selected id it lacks
  // (covers values picked via the modal or preloaded by the form).
  const missingSelected = !!value && !options.some((o) => o.value === value)
  const selected = useQuery({
    queryKey: spec.detailQueryKey(value ?? ""),
    queryFn: () => api<T>(spec.detailEndpoint(value!)),
    enabled: missingSelected,
    staleTime: 10 * 60_000,
  })
  const mergedOptions = useMemo(() => {
    if (!missingSelected || !selected.data) return options
    const row = selected.data
    const lbl = spec.detailLabel
      ? spec.detailLabel(row)
      : ((row as unknown as { name?: string }).name ?? row.id)
    return [{ value: row.id, label: lbl }, ...options]
  }, [options, missingSelected, selected.data, spec])

  return (
    <Field label={label} hint={hint} error={error}>
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <Combobox
            value={value}
            onChange={onChange}
            options={mergedOptions}
            noneLabel={noneLabel}
            placeholder={placeholder ?? `Pick a ${spec.noun}`}
            searchPlaceholder={searchPlaceholder ?? `Search ${spec.noun}s…`}
            emptyText={emptyText ?? `No ${spec.noun}s.`}
            disabled={disabled}
          />
        </div>
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="shrink-0"
          disabled={disabled}
          aria-label={`Advanced ${spec.noun} search`}
          title="Advanced search…"
          onClick={() => setAdvancedOpen(true)}
        >
          <SlidersHorizontal />
        </Button>
        {quickAdd}
      </div>
      <ObjectSearchDialog<T>
        spec={spec as unknown as ObjectPickerSpec<T>}
        open={advancedOpen}
        onOpenChange={setAdvancedOpen}
        exclude={exclude}
        customFieldId={customFieldId}
        initialFilters={initialFilters}
        onSelect={(id) => {
          onChange(id)
          setAdvancedOpen(false)
        }}
      />
    </Field>
  )
}

function withCustomField(url: string, customFieldId?: string): string {
  if (!customFieldId) return url
  return `${url}${url.includes("?") ? "&" : "?"}custom_field=${encodeURIComponent(customFieldId)}`
}

// ─── Advanced search modal ──────────────────────────────────────────────────

function usePickerOptions(key: string, url: string, enabled: boolean) {
  return useQuery({
    queryKey: [key],
    queryFn: () => api<Paginated<{ id: string; name: string }>>(url),
    enabled,
    staleTime: 10 * 60_000,
  })
}

/** One filter dropdown — its options come from the shared picker caches. */
function FilterSelect({
  filter,
  value,
  onChange,
  open,
}: {
  filter: PickerFilter
  value: string | null
  onChange: (v: string | null) => void
  open: boolean
}) {
  const q = usePickerOptions(filter.queryKey, filter.endpoint, open)
  const options = (q.data?.results ?? []).map((o): SelectOption => {
    const raw = o as never
    return {
      value: filter.paramOf ? filter.paramOf(raw) : o.id,
      label: filter.textOf ? filter.textOf(raw) : o.name,
    }
  })
  return (
    <FormSelect
      label={filter.label}
      value={value}
      onChange={onChange}
      noneLabel={`Any ${filter.label.toLowerCase()}`}
      placeholder={`Any ${filter.label.toLowerCase()}`}
      options={options}
    />
  )
}

function ObjectSearchDialog<T extends { id: string }>({
  spec,
  open,
  onOpenChange,
  onSelect,
  exclude,
  customFieldId,
  initialFilters,
}: {
  spec: ObjectPickerSpec<T>
  open: boolean
  onOpenChange: (v: boolean) => void
  onSelect: (id: string) => void
  exclude: Set<string>
  customFieldId?: string
  initialFilters?: Record<string, string>
}) {
  const [search, setSearch] = useState("")
  const [debounced, setDebounced] = useState("")
  const [filters, setFilters] = useState<Record<string, string | null>>(
    initialFilters ?? {}
  )
  const [page, setPage] = useState(1)
  // Re-seed when the context changes (a different tile role) — the dialog is
  // mounted once per picker, so initial state alone would go stale. Keyed by
  // VALUE (not object identity — callers pass fresh literals every render,
  // which would clobber the user's in-dialog filter edits).
  const initialKey = JSON.stringify(initialFilters ?? {})
  useEffect(() => {
    setFilters(JSON.parse(initialKey))
  }, [initialKey])

  // Debounce the free-text box so we don't fire a request per keystroke.
  useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim()), 300)
    return () => clearTimeout(t)
  }, [search])

  // Any filter change resets to the first page.
  useEffect(() => {
    setPage(1)
  }, [debounced, filters])

  const query = useMemo(() => {
    const p = new URLSearchParams()
    if (debounced) p.set("search", debounced)
    if (customFieldId) p.set("custom_field", customFieldId)
    for (const f of spec.filters) {
      const v = filters[f.key]
      if (v) p.set(f.key, v)
    }
    p.set("page", String(page))
    p.set("page_size", String(PAGE_SIZE))
    return p.toString()
  }, [customFieldId, debounced, filters, page, spec.filters])

  // The richer result columns need the standard list serializer, so this
  // deliberately does NOT pass ?picker=1 (that shape is only {id, name}).
  const results = useQuery({
    queryKey: [`${spec.noun}-picker-advanced`, query],
    queryFn: () =>
      api<Paginated<T>>(
        `${spec.listEndpoint}${spec.listEndpoint.includes("?") ? "&" : "?"}${query}`
      ),
    enabled: open,
    placeholderData: keepPreviousData,
  })

  const rows = (results.data?.results ?? []).filter((r) => !exclude.has(r.id))
  const count = results.data?.count ?? 0
  const hasPrev = !!results.data?.previous
  const hasNext = !!results.data?.next

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Inset to the page view (right of the fixed w-60 sidebar) on lg+ so
          the modal and its backdrop don't cover the sidebar. */}
      <DialogContent
        overlayClassName="lg:left-60"
        className="flex max-h-[85vh] w-full flex-col gap-4 overflow-hidden sm:max-w-3xl lg:left-[calc(50%+7.5rem)]"
      >
        <DialogHeader>
          <DialogTitle>Find a {spec.noun}</DialogTitle>
        </DialogHeader>

        <Input
          autoFocus
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={spec.searchHint ?? "Search…"}
        />

        {spec.filters.length > 0 && (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {spec.filters.map((f) => (
              <FilterSelect
                key={f.key}
                filter={f}
                value={filters[f.key] ?? null}
                onChange={(v) =>
                  setFilters((prev) => ({ ...prev, [f.key]: v }))
                }
                open={open}
              />
            ))}
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-auto rounded-lg border">
          <Table>
            <TableHeader className="sticky top-0 bg-muted">
              <TableRow>
                {spec.columns.map((c) => (
                  <TableHead key={c.header}>{c.header}</TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => {
                const state = spec.rowState?.(row) ?? {}
                return (
                  <TableRow
                    key={row.id}
                    aria-disabled={state.disabled || undefined}
                    className={
                      state.disabled
                        ? "cursor-not-allowed opacity-50"
                        : "cursor-pointer"
                    }
                    onClick={() => !state.disabled && onSelect(row.id)}
                  >
                    {spec.columns.map((c, i) => (
                      <TableCell
                        key={c.header}
                        className={i === 0 ? "font-medium" : undefined}
                      >
                        {c.cell(row)}
                        {i === 0 && state.note && (
                          <span className="ml-1.5 text-[11px] font-normal text-muted-foreground">
                            {state.note}
                          </span>
                        )}
                      </TableCell>
                    ))}
                  </TableRow>
                )
              })}
              {!rows.length && (
                <TableRow>
                  <TableCell
                    colSpan={spec.columns.length}
                    className="py-8 text-center text-muted-foreground"
                  >
                    {results.isLoading ? "Loading…" : `No ${spec.noun}s match.`}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>

        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span className={cn("num", results.isFetching && "opacity-60")}>
            {count} {spec.noun}
            {count === 1 ? "" : "s"}
          </span>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!hasPrev}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              Previous
            </Button>
            <span className="num">Page {page}</span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!hasNext}
              onClick={() => setPage((p) => p + 1)}
            >
              Next
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
