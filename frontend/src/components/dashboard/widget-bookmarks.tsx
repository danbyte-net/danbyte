import { Link } from "@tanstack/react-router"
import { Bookmark as BookmarkIcon, X } from "lucide-react"

import { useBookmarks } from "@/lib/use-bookmarks"

/** Dashboard widget: the signed-in user's saved pages. */
export function BookmarksWidget() {
  const { bookmarks, remove } = useBookmarks()

  if (bookmarks.length === 0) {
    return (
      <p className="px-1 py-6 text-center text-xs text-muted-foreground">
        No bookmarks yet — click the <BookmarkIcon className="inline h-3 w-3" />{" "}
        star in the top bar to save the page you're on.
      </p>
    )
  }

  return (
    <ul className="divide-y divide-border">
      {bookmarks.map((b) => (
        <li
          key={b.id}
          className="group flex items-center gap-2 py-1.5 text-[13px]"
        >
          <BookmarkIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <Link
            to={b.url as never}
            className="shrink-0 font-medium hover:underline"
          >
            {b.label}
          </Link>
          <span className="min-w-0 flex-1 truncate text-right font-mono text-[11px] text-muted-foreground">
            {b.url}
          </span>
          <button
            type="button"
            onClick={() => remove.mutate(b.id)}
            className="text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:text-destructive"
            title="Remove bookmark"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </li>
      ))}
    </ul>
  )
}
