import { useRouter, useRouterState } from "@tanstack/react-router"

/**
 * "Return to where I came from" for edit / create pages.
 *
 * A caller navigates in with `search: { from: <internal href> }` — typically
 * the page's own path+search, from {@link useCurrentHref} — and this hook hands
 * back a `goBack(fallback)` that returns there on save / cancel, or runs the
 * fallback when there's no (safe) `from`. Only same-origin absolute paths are
 * honored, so a crafted `from` can't bounce the user to another site.
 *
 * The page must declare `from` in its `validateSearch` (an unknown search param
 * is otherwise dropped), then pass `Route.useSearch().from` here.
 */
export function useReturnTo(from: string | undefined) {
  const router = useRouter()
  const safe =
    typeof from === "string" && from.startsWith("/") && !from.startsWith("//")
  return (fallback: () => void) => {
    if (safe) router.history.push(from)
    else fallback()
  }
}

/** The current internal href (path + search + hash) — pass as `from` on an
 * edit/create link so the target can send the user back here on save. */
export function useCurrentHref(): string {
  return useRouterState({ select: (s) => s.location.href })
}
