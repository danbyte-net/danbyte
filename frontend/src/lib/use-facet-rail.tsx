import { useMemo } from "react"

import {
  FacetGroup,
  FilterRail,
  type FacetOption,
} from "@/components/filter-rail"
import { naturalCompare } from "@/lib/natural-sort"
import {
  decodeList,
  encodeList,
  pruneUnknown,
  useListSearch,
  useSearchWriter,
} from "@/lib/url-filters"

/** One facet: a labelled group whose options are derived from the rows. `get`
 * returns the row's value(s) for this facet (null = excluded from the facet). */
export interface FacetSpec<T> {
  key: string
  label: string
  get: (row: T) => { value: string; label: string } | null
}

/**
 * Client-side faceted filtering for a list page - the shared version of the
 * inline pattern used across the app. Give it the fetched rows and a few facet
 * specs; get back a ready `rail` (or null when there's nothing to filter) and
 * the `filtered` rows. Groups AND together; options within a group OR.
 *
 * The selection lives in the URL, one param per facet named after its `key`
 * (lib/url-filters), so a reload or Back keeps it.
 */
export function useFacetRail<T>(
  rows: T[],
  specs: FacetSpec<T>[]
): { rail: React.ReactNode | null; filtered: T[] } {
  const search = useListSearch()
  const write = useSearchWriter()
  const sig = JSON.stringify(specs.map((s) => search[s.key] ?? null))
  const raw = useMemo(() => {
    const out: Record<string, Set<string>> = {}
    for (const spec of specs)
      out[spec.key] = new Set(decodeList(search[spec.key]))
    return out
  }, [sig])

  const options = useMemo(() => {
    const out: Record<string, FacetOption[]> = {}
    for (const spec of specs) {
      const counts = new Map<string, { label: string; count: number }>()
      for (const row of rows) {
        const v = spec.get(row)
        if (!v) continue
        const cur = counts.get(v.value)
        if (cur) cur.count++
        else counts.set(v.value, { label: v.label, count: 1 })
      }
      out[spec.key] = [...counts.entries()]
        .map(([value, e]) => ({ value, label: e.label, count: e.count }))
        .sort((a, b) => naturalCompare(a.label, b.label))
    }
    return out
  }, [rows, specs])

  // A value no row carries (a stale link) is ignored, not an empty table.
  const selected = useMemo(() => {
    const out: Record<string, Set<string>> = {}
    for (const [key, set] of Object.entries(raw))
      out[key] = pruneUnknown(
        set,
        rows.length ? (options[key] ?? []).map((o) => o.value) : null
      )
    return out
  }, [raw, options, rows.length])

  const toggle = (key: string, value: string) =>
    write((prev) => {
      const next = new Set(
        pruneUnknown(
          new Set(decodeList(prev[key])),
          rows.length ? (options[key] ?? []).map((o) => o.value) : null
        )
      )
      if (next.has(value)) next.delete(value)
      else next.add(value)
      return { ...prev, [key]: encodeList(next) }
    })

  const filtered = useMemo(() => {
    return rows.filter((row) =>
      specs.every((spec) => {
        const sel = selected[spec.key]
        if (!sel || sel.size === 0) return true
        const v = spec.get(row)
        return v ? sel.has(v.value) : false
      })
    )
  }, [rows, specs, selected])

  const hasAny = specs.some((s) => (options[s.key] ?? []).length > 0)
  const rail = hasAny ? (
    <FilterRail>
      {specs.map((spec) =>
        (options[spec.key] ?? []).length > 0 ? (
          <FacetGroup
            key={spec.key}
            label={spec.label}
            options={options[spec.key]}
            selected={selected[spec.key] ?? EMPTY}
            onToggle={(v) => toggle(spec.key, v)}
          />
        ) : null
      )}
    </FilterRail>
  ) : null

  return { rail, filtered }
}

const EMPTY: Set<string> = new Set()
