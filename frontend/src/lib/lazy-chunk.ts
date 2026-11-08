import { lazy } from "react"
import type { ComponentType } from "react"

const KEY = "danbyte:last-chunk-reload"

/** Reload once to pick up a new build after a deploy replaced the hashed
 *  chunk files. A second failure within 10 s is left to the error boundary,
 *  so a chunk that is really missing can't loop. Returns true when a reload
 *  was started. */
export function reloadForNewBuild(): boolean {
  if (typeof window === "undefined") return false
  const now = Date.now()
  let last = 0
  try {
    last = Number(sessionStorage.getItem(KEY) || 0)
  } catch {
    // Storage blocked: fall through and reload once anyway.
  }
  if (now - last < 10_000) return false
  try {
    sessionStorage.setItem(KEY, String(now))
  } catch {
    // ignore
  }
  window.location.reload()
  return true
}

/** True for the browser's "this chunk no longer exists" import failure. */
export function isStaleChunkError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /dynamically imported module|Importing a module script failed|error loading dynamically imported module/i.test(
    msg
  )
}

/** `React.lazy` that recovers from a chunk deleted by a redeploy: the first
 *  stale-chunk failure reloads the page instead of showing an error. */
export function lazyChunk<T extends ComponentType<any>>( // eslint-disable-line @typescript-eslint/no-explicit-any
  factory: () => Promise<{ default: T }>
) {
  return lazy(() =>
    factory().catch((err: unknown) => {
      if (isStaleChunkError(err) && reloadForNewBuild()) {
        // Keep Suspense waiting while the page reloads.
        return new Promise<{ default: T }>(() => {})
      }
      throw err
    })
  )
}
