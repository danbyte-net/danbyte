import { useLocation } from "@tanstack/react-router"
import { Star } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { useBookmarks, labelForPath } from "@/lib/use-bookmarks"

/**
 * Topbar star — bookmarks the current page (path + query string) for the
 * signed-in user, or removes it if already bookmarked. Bookmarks surface in the
 * dashboard's Bookmarks widget.
 */
export function BookmarkButton() {
  const loc = useLocation()
  const url = loc.pathname + (loc.searchStr || "")
  const { bookmarks, add, remove } = useBookmarks()
  const existing = bookmarks.find((b) => b.url === url)

  const toggle = () => {
    if (existing) {
      remove.mutate(existing.id, {
        onSuccess: () => toast.success("Bookmark removed"),
      })
    } else {
      const label = labelForPath(loc.pathname)
      add.mutate(
        { label, url },
        { onSuccess: () => toast.success(`Bookmarked “${label}”`) }
      )
    }
  }

  return (
    <Button
      variant="ghost"
      size="icon"
      className="h-8 w-8"
      onClick={toggle}
      disabled={add.isPending || remove.isPending}
      title={existing ? "Remove bookmark" : "Bookmark this page"}
      aria-pressed={!!existing}
    >
      <Star
        className={
          "h-4 w-4 " +
          (existing ? "fill-amber-400 text-amber-400" : "text-muted-foreground")
        }
      />
      <span className="sr-only">
        {existing ? "Remove bookmark" : "Bookmark this page"}
      </span>
    </Button>
  )
}
