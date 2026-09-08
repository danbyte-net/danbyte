import type { SearchHit } from "@/lib/api"

/** Recent searches and opened hits, per browser - the palette's empty state. */
export interface RecentSearch {
  q: string
  at: number
}

export interface RecentHit {
  type: string
  type_label: string
  title: string
  subtitle: string
  url: string
  context?: SearchHit["context"]
  at: number
}

const QUERIES_KEY = "danbyte-search-recent-queries"
const HITS_KEY = "danbyte-search-recent-hits"
const MAX = 8

function read<T>(key: string): T[] {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T[]) : []
  } catch {
    return []
  }
}

function write<T>(key: string, items: T[]) {
  try {
    localStorage.setItem(key, JSON.stringify(items.slice(0, MAX)))
  } catch {
    /* private mode etc. */
  }
}

export function recentQueries(): RecentSearch[] {
  return read<RecentSearch>(QUERIES_KEY)
}

export function rememberQuery(q: string) {
  const term = q.trim()
  if (!term) return
  const rest = recentQueries().filter((r) => r.q !== term)
  write(QUERIES_KEY, [{ q: term, at: Date.now() }, ...rest])
}

export function recentHits(): RecentHit[] {
  return read<RecentHit>(HITS_KEY)
}

export function rememberHit(h: Omit<RecentHit, "at">) {
  const rest = recentHits().filter((r) => r.url !== h.url)
  write(HITS_KEY, [{ ...h, at: Date.now() }, ...rest])
}

export function clearRecents() {
  write(QUERIES_KEY, [])
  write(HITS_KEY, [])
}
