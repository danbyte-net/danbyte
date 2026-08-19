import { useMemo, useState } from "react"

import {
  FacetGroup,
  FilterRail,
  type FacetOption,
  toggleInSet,
} from "@/components/filter-rail"

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
 */
export function useFacetRail<T>(
  rows: T[],
  specs: FacetSpec<T>[]
): { rail: React.ReactNode | null; filtered: T[] } {
  const [selected, setSelected] = useState<Record<string, Set<string>>>({})

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
        .sort((a, b) => a.label.localeCompare(b.label))
    }
    return out
  }, [rows, specs])

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
            onToggle={(v) =>
              toggleInSet(selected[spec.key] ?? EMPTY, v, (next) =>
                setSelected((s) => ({ ...s, [spec.key]: next }))
              )
            }
          />
        ) : null
      )}
    </FilterRail>
  ) : null

  return { rail, filtered }
}

const EMPTY: Set<string> = new Set()
