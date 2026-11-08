// Walking a paged list endpoint (#447). Its own module, beside api.ts, so a
// test that mocks `api` from "@/lib/api" also answers the pages walked here.
import { api } from "@/lib/api"
import type { Paginated } from "@/lib/api"

/** Rows per request when `apiAll` walks a list. */
export const LIST_CHUNK = 1000
/** The most rows `apiAll` collects - the API's own page-size ceiling, which
 * was what an unsized list request returned before #447. */
export const LIST_MAX = 10000

/** A list endpoint's rows, fetched page by page (#447).
 *
 * A list request without `page_size` answers one small page, so a caller
 * that needs the whole set - a picker, a dropdown, a client-filtered table -
 * comes through here. It asks for `chunk` rows a request and follows `next`
 * until the list ends or `max` rows have arrived, one request at a time so a
 * large list never holds the server in one long response.
 *
 * The answer is shaped like one page: `results` holds every row collected,
 * `count` is the server's total (so a table can still say *N of M* when the
 * list ran past `max`), and `next` is non-null only when rows were left
 * behind. A path that names its own `page_size` is fetched as that one page,
 * and a response that isn't paged ends the walk as it is. */
export async function apiAll<T>(
  path: string,
  { chunk = LIST_CHUNK, max = LIST_MAX }: { chunk?: number; max?: number } = {}
): Promise<Paginated<T>> {
  if (new URL(path, "http://x").searchParams.has("page_size"))
    return api<Paginated<T>>(path)
  // Appended as text: re-serializing the query would re-encode what the
  // caller wrote (`ids=a,b` as `ids=a%2Cb`).
  const size = `page_size=${Math.min(chunk, max)}`
  let url: string | null = path.includes("?")
    ? `${path}${/[?&]$/.test(path) ? "" : "&"}${size}`
    : `${path}?${size}`
  let head: Paginated<T> | null = null
  const results: T[] = []
  let next: string | null = null
  while (url) {
    // Typed loosely: a view that doesn't page answers some other shape.
    type Loose = Partial<Paginated<T>> | null
    const page: Loose = await api<Loose>(url)
    if (!page || !Array.isArray(page.results)) return page as Paginated<T>
    head ??= page as Paginated<T>
    results.push(...page.results)
    next = page.next ?? null
    // `next` is absolute (scheme and host as the server saw them); only its
    // path and query are ours to follow, on this origin.
    url = next && results.length < max ? samePath(next) : null
  }
  const over = results.length > max
  return {
    ...head!,
    count: typeof head?.count === "number" ? head.count : results.length,
    next: over ? (next ?? path) : next,
    previous: null,
    results: over ? results.slice(0, max) : results,
  }
}

function samePath(link: string): string {
  const u = new URL(link, "http://x")
  return u.pathname + u.search
}
