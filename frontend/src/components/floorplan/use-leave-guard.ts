import { useCallback, useEffect } from "react"
import type { RefObject } from "react"
import { useBlocker } from "@tanstack/react-router"
import type { ShouldBlockFn } from "@tanstack/react-router"

/** Same page? Compared loosely so a trailing slash can't read as a move. */
const samePath = (a: string, b: string) =>
  a.replace(/\/+$/, "") === b.replace(/\/+$/, "")

/** The unsaved-edit guard: the router blocker for in-app ways out, and the
 * browser's own leave-site prompt for the rest. */
export function useLeaveGuard(
  isDirty: boolean,
  isDirtyRef: RefObject<boolean>
) {
  // ── Unsaved-edit guard ─────────────────────────────────────────────────
  // One dialog for every in-app way out of a dirty editor: sidebar links,
  // breadcrumbs, browser back/forward, the "leave plan" links on tiles, and the
  // floor switcher (which just navigates, like everything else). The router's
  // blocker is the single decision point - the switcher deliberately has no
  // confirm of its own, because two guards on one action means two dialogs.
  //
  // Same-pathname navigations are let through on purpose: this page drives
  // ?viz=3d and clears ?trace= through the router, and a view toggle is not an
  // exit. Only a different pathname means the edits are about to be dropped.
  //
  // shouldBlockFn is a dependency of the hook's own effect, so it reads the ref
  // and stays referentially stable - an inline closure would tear down and
  // re-register the history blocker on every render.
  const shouldBlockLeave = useCallback<ShouldBlockFn>(
    ({ current, next }) =>
      isDirtyRef.current && !samePath(next.pathname, current.pathname),
    []
  )
  // withResolver hands back proceed/reset, which the shared LeaveGuardDialog
  // at the end of the editor drives - a native window.confirm can't be
  // styled and reads as a browser error. enableBeforeUnload stays off because
  // the blocker is registered whether or not the plan is dirty; the ref-gated
  // listener below owns the browser-level case, which no router blocker can
  // reach.
  const leaveGuard = useBlocker({
    shouldBlockFn: shouldBlockLeave,
    enableBeforeUnload: false,
    withResolver: true,
  })

  // Closing the tab, reloading, or leaving for another origin would drop
  // unsaved tile edits without a word, and those never reach the router - so
  // the browser's own leave-site prompt is the only guard that covers them.
  // In-app navigation is the blocker's job, above. Registered only while dirty,
  // and it reads the ref so a stale closure can never make the guard lie.
  useEffect(() => {
    if (!isDirty) return
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (!isDirtyRef.current) return
      e.preventDefault()
      e.returnValue = ""
    }
    window.addEventListener("beforeunload", onBeforeUnload)
    return () => window.removeEventListener("beforeunload", onBeforeUnload)
  }, [isDirty])

  return leaveGuard
}
