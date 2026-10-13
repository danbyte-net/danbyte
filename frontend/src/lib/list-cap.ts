import { createContext, useContext } from "react"

// ─── A list page holding one capped page of a longer list ────────────────
//
// List pages fetch their rows in one request and filter them in the browser.
// The request is capped (10,000 by default, 1,000 for IP addresses), so a
// bigger tenant got the first rows only, and the count badge, the facet
// counts and the Download all read as if that were everything (#412).
// `ListPageShell` takes the server's page (`page={query.data}`) and provides
// this context, so the badge, the rail and the table's Download each say so.

export interface ListCap {
  /** Rows the page loaded. */
  loaded: number
  /** Rows the server holds for the request. */
  total: number
}

/** The cap, or null when the page holds every row. */
export function listCap(
  page: { count?: number; results?: unknown[] } | undefined
): ListCap | null {
  if (!page || !Array.isArray(page.results)) return null
  const total = page.count
  if (typeof total !== "number" || !Number.isFinite(total)) return null
  const loaded = page.results.length
  return total > loaded ? { loaded, total } : null
}

const n = (v: number) => v.toLocaleString()

/** The notice over a capped list page. Search is the way through: it runs on
 * the server, where the facets only refine the rows that arrived. */
export function listCapNotice(cap: ListCap): string {
  return `Showing the first ${n(cap.loaded)} of ${n(cap.total)} - search to narrow the list.`
}

/** The count chip: `shown of total`. */
export function listCapCount(shown: number, cap: ListCap): string {
  return `${n(shown)} of ${n(cap.total)}`
}

/** The rail's note: facet counts cover the loaded rows only. */
export function listCapFacetNote(cap: ListCap): string {
  return `Counts cover the first ${n(cap.loaded)} of ${n(cap.total)}.`
}

/** The Download menu's note: it exports what was loaded. */
export function listCapExportNote(cap: ListCap): string {
  return `First ${n(cap.loaded)} of ${n(cap.total)} rows`
}

export const ListCapContext = createContext<ListCap | null>(null)

export function useListCap(): ListCap | null {
  return useContext(ListCapContext)
}
