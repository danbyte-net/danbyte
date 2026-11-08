import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { keepPreviousData, useQuery } from "@tanstack/react-query"
import type { ColumnDef, SortingState } from "@tanstack/react-table"

import { api } from "@/lib/api"
import type { Paginated } from "@/lib/api"
import { decodeText, useListSearch, useSearchWriter } from "@/lib/url-filters"
import { useUserPrefs } from "@/lib/use-user-prefs"
import { useServerTableFilters } from "@/components/table-filters"
import type { ServerFacetExtra, ServerFacets } from "@/components/table-filters"

// ─── A list paged, sorted and filtered on the server (#482, #487) ────────
//
// The Devices, Interfaces, Cables and Virtual machines lists fetch one page
// at a time instead of walking the whole list with apiAll (which stopped at
// 10,000 rows and took seconds): the page, its sort, the search box and the
// rail's selection all go to the API (api/list_table.py), which answers the
// page in the slim `view=table` row. The rail's counts come from
// `<list>/facets/`, over every row the other filters leave. Everything lives
// in the URL as on any list page: `?page=3&ordering=-site&status=…&q=…`.
//
//   const list = useServerList({ endpoint: "/api/devices/", queryKey: "devices",
//     columns, facets: ["status", "role", "site", "tags"] })
//   <ListPageShell count={list.total} rail={list.rail} query={list.query} …>
//     <DataTable data={list.rows} columns={list.columns} {...list.tableProps} />

/** Rows per request when a download or "Select all" walks the list. */
const WALK_CHUNK = 1000
/** The largest page a list asks for (the API's large-page threshold). */
const MAX_PAGE = 1000

export interface FacetCounts {
  facets: ServerFacets
  sortable: string[]
}

export interface ServerListOpts<T> {
  /** The list endpoint, with its trailing slash: `/api/devices/`. */
  endpoint: string
  /** First element of every query key - what a write invalidates
   * (`["devices"]`). */
  queryKey: string
  columns: ColumnDef<T, unknown>[]
  /** The facets the server counts (api/list_specs.py), by column id. */
  facets: string[]
  /** Server facets no column carries. */
  extraFacets?: ServerFacetExtra[]
  /** A facet kept under another URL param (a legacy deep-link name). */
  facetParams?: Record<string, string>
  /** Params every request carries, e.g. the VM list's `device`. */
  params?: Record<string, string | undefined>
  /** The search box's URL param. */
  searchKey?: string
}

const str = (v: unknown) => decodeText(v)

/** `ordering` ↔ the table's sort state: the column id, `-` for descending. */
export function orderingToSorting(ordering: string): SortingState {
  if (!ordering) return []
  const desc = ordering.startsWith("-")
  return [{ id: desc ? ordering.slice(1) : ordering, desc }]
}

export function sortingToOrdering(s: SortingState): string | undefined {
  const first = s.at(0)
  return first ? `${first.desc ? "-" : ""}${first.id}` : undefined
}

/** The top-level row fields catalog columns read (`site.region` → `site`);
 * custom fields ride every slim row already. */
export function includeFields(columnIds: string[]): string[] {
  const out = new Set<string>()
  for (const id of columnIds) {
    if (id.startsWith("cf_") || id.startsWith("custom_fields")) continue
    out.add(id.split(".")[0])
  }
  return [...out].sort()
}

export function useServerList<T extends { id: string }>(
  opts: ServerListOpts<T>
) {
  const { endpoint, queryKey } = opts
  const search = useListSearch()
  const write = useSearchWriter()
  const q = str(search[opts.searchKey ?? "q"]).trim()
  const page = Math.max(1, Math.floor(Number(str(search.page)) || 1))
  const ordering = str(search.ordering)

  const { values: prefs, setPref } = useUserPrefs()
  const prefSize = Number(prefs.page_size) || 25
  const pageSize = prefSize > 0 ? Math.min(prefSize, MAX_PAGE) : MAX_PAGE

  const fixed = useMemo(() => {
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(opts.params ?? {}))
      if (v !== undefined && v !== "") out[k] = v
    return out
  }, [JSON.stringify(opts.params ?? {})])

  // The page's rows feed the rail's wording and the advanced filter's field
  // list; the rail's selection feeds the page's request.
  const [rows, setRows] = useState<T[]>([])
  const [counts, setCounts] = useState<FacetCounts | undefined>()
  const filters = useServerTableFilters(opts.columns, rows, {
    facets: opts.facets,
    extra: opts.extraFacets,
    params: opts.facetParams,
    counts: counts?.facets,
  })

  // Search, the rail and the fixed params: what the rows answer to.
  const filterParams = useMemo(() => {
    const p = new URLSearchParams(fixed)
    if (q) p.set("search", q)
    for (const [k, v] of Object.entries(filters.apiParams)) p.set(k, v)
    return p.toString()
  }, [fixed, q, filters.apiParams])

  const facetsQuery = useQuery({
    queryKey: [queryKey, "facets", filterParams],
    queryFn: () =>
      api<FacetCounts>(
        `${endpoint}facets/${filterParams ? `?${filterParams}` : ""}`
      ),
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  })
  useEffect(() => setCounts(facetsQuery.data), [facetsQuery.data])

  const sortableSig = (facetsQuery.data?.sortable ?? []).join(" ")
  const sortable = useMemo(() => {
    const set = new Set(sortableSig.split(" "))
    // Custom fields sort by their key; the server takes any of them.
    return (id: string) => set.has(id) || id.startsWith("cf_")
  }, [sortableSig])
  // A sort the server cannot do (an old link, a column since removed) is
  // dropped rather than failing the page.
  const effectiveOrdering =
    ordering && facetsQuery.data && !sortable(ordering.replace(/^-/, ""))
      ? ""
      : ordering

  const [include, setInclude] = useState<string[]>([])
  const onAutoFieldsChange = useCallback((ids: string[]) => {
    const next = includeFields(ids)
    setInclude((prev) => (prev.join(",") === next.join(",") ? prev : next))
  }, [])

  const pageUrl = useCallback(
    (n: number, size: number) => {
      const p = new URLSearchParams(filterParams)
      p.set("view", "table")
      p.set("page", String(n))
      p.set("page_size", String(size))
      if (effectiveOrdering) p.set("ordering", effectiveOrdering)
      if (include.length) p.set("include", include.join(","))
      return `${endpoint}?${p.toString()}`
    },
    [endpoint, filterParams, effectiveOrdering, include]
  )

  const query = useQuery({
    queryKey: [queryKey, "page", pageUrl(page, pageSize)],
    queryFn: () => api<Paginated<T>>(pageUrl(page, pageSize)),
    placeholderData: keepPreviousData,
  })
  const data = query.data
  useEffect(() => setRows(data?.results ?? []), [data])
  const total = data?.count ?? 0
  const pageCount = Math.max(1, Math.ceil(total / pageSize))

  // A filter or sort change starts over on page one; a page past the end
  // (rows deleted, a shorter list) steps back to the last.
  const scope = `${filterParams}|${effectiveOrdering}`
  const lastScope = useRef(scope)
  useEffect(() => {
    if (lastScope.current === scope) return
    lastScope.current = scope
    if (page !== 1) write((prev) => ({ ...prev, page: undefined }))
  }, [scope])
  useEffect(() => {
    if (data && !query.isPlaceholderData && page > pageCount)
      write((prev) => ({
        ...prev,
        page: pageCount > 1 ? String(pageCount) : undefined,
      }))
  }, [data, page, pageCount])

  const setPage = useCallback(
    (n: number) =>
      write((prev) => ({ ...prev, page: n > 1 ? String(n) : undefined })),
    [write]
  )

  /** Every row the filters match, a chunk at a time - the Download. */
  const exportAll = useCallback(async () => {
    const out: T[] = []
    for (let n = 1; ; n++) {
      const r = await api<Paginated<T>>(pageUrl(n, WALK_CHUNK))
      out.push(...r.results)
      if (!r.next || r.results.length === 0) break
    }
    return out
  }, [pageUrl])

  /** Every id the filters match, in the list's order - "Select all",
   * the SBOM and the PDF report of the filtered list. */
  const allIds = useCallback(async () => {
    const p = new URLSearchParams(filterParams)
    if (effectiveOrdering) p.set("ordering", effectiveOrdering)
    const r = await api<{ results: string[] }>(
      `${endpoint}table-ids/?${p.toString()}`
    )
    return r.results
  }, [endpoint, filterParams, effectiveOrdering])

  const tableProps = {
    serverPagination: {
      page,
      pageCount,
      totalRows: total,
      onPageChange: setPage,
      pageSize,
      onPageSizeChange: (n: number) => {
        setPref("page_size", n)
        setPage(1)
      },
      selectAll: allIds,
      selectionScope: filterParams,
    },
    serverSorting: {
      sorting: orderingToSorting(effectiveOrdering),
      onSortingChange: (s: SortingState) =>
        write((prev) => ({
          ...prev,
          ordering: sortingToOrdering(s),
          page: undefined,
        })),
      sortable,
    },
    onAutoFieldsChange,
    exportAll,
  }

  return {
    rows: data?.results ?? [],
    query,
    facetsQuery,
    total,
    search: q,
    filterParams,
    allIds,
    exportAll,
    tableProps,
    rail: filters.rail,
    /** `columns` with the rail wired into their facet cells. */
    columns: filters.columns,
    /** Wire another column set (one built from the page's rows) to the rail
     * - see `wireFacetColumns`. */
    selectedValues: filters.selectedValues,
    toggleValue: filters.toggleValue,
    snapshot: filters.snapshot,
    restore: filters.restore,
    activeCount: filters.activeCount,
  }
}
