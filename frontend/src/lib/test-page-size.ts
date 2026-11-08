// apiAll's LIST_CHUNK, written out: importing api-all here would load the
// "@/lib/api" a test is in the middle of mocking (api-all.test checks it).
export const APPENDED_PAGE_SIZE = 1000

/** Test helper: a list path as the component wrote it, without the
 * `page_size` that `apiAll` appends (#447), so a mocked `api` keeps matching
 * the paths a test names. A page size the component wrote itself stays. */
export function withoutPageSize(path: string): string {
  return path.replace(new RegExp(`[?&]page_size=${APPENDED_PAGE_SIZE}$`), "")
}

/** Wraps a test's `api` mock so it sees paths without `page_size`. */
export function stripPageSize<TArgs extends unknown[], TResult>(
  mock: (path: string, ...rest: TArgs) => TResult
) {
  return (path: string, ...rest: TArgs): TResult =>
    mock(withoutPageSize(path), ...rest)
}
