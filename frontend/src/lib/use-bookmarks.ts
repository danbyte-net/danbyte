import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"

import { api, type Bookmark, type BookmarkFolder, type Paginated } from "@/lib/api"

/** Per-user page bookmarks, backed by /api/bookmarks/. */
export function useBookmarks() {
  const qc = useQueryClient()
  const q = useQuery({
    queryKey: ["bookmarks"],
    queryFn: () => api<Paginated<Bookmark>>("/api/bookmarks/"),
    staleTime: 60_000,
  })
  const folders = useQuery({
    queryKey: ["bookmark-folders"],
    queryFn: () => api<Paginated<BookmarkFolder>>("/api/bookmark-folders/"),
    staleTime: 60_000,
  })
  const invalidate = () => qc.invalidateQueries({ queryKey: ["bookmarks"] })
  const invalidateFolders = () =>
    qc.invalidateQueries({ queryKey: ["bookmark-folders"] })

  const add = useMutation({
    mutationFn: (b: { label: string; url: string; folder?: string | null }) =>
      api<Bookmark>("/api/bookmarks/", {
        method: "POST",
        body: JSON.stringify(b),
      }),
    onSuccess: invalidate,
  })
  const update = useMutation({
    mutationFn: (b: Partial<Bookmark> & { id: string }) =>
      api<Bookmark>(`/api/bookmarks/${b.id}/`, {
        method: "PATCH",
        body: JSON.stringify(b),
      }),
    onSuccess: invalidate,
  })
  const remove = useMutation({
    mutationFn: (id: string) =>
      api(`/api/bookmarks/${id}/`, { method: "DELETE" }),
    onSuccess: invalidate,
  })
  const addFolder = useMutation({
    mutationFn: (f: { name: string; parent?: string | null }) =>
      api<BookmarkFolder>("/api/bookmark-folders/", {
        method: "POST",
        body: JSON.stringify(f),
      }),
    onSuccess: invalidateFolders,
  })
  const updateFolder = useMutation({
    mutationFn: (f: Partial<BookmarkFolder> & { id: string }) =>
      api<BookmarkFolder>(`/api/bookmark-folders/${f.id}/`, {
        method: "PATCH",
        body: JSON.stringify(f),
      }),
    onSuccess: invalidateFolders,
  })
  const removeFolder = useMutation({
    mutationFn: (id: string) =>
      api(`/api/bookmark-folders/${id}/`, { method: "DELETE" }),
    onSuccess: () => {
      invalidateFolders()
      invalidate()
    },
  })

  return {
    bookmarks: q.data?.results ?? [],
    folders: folders.data?.results ?? [],
    isLoading: q.isLoading || folders.isLoading,
    add,
    update,
    remove,
    addFolder,
    updateFolder,
    removeFolder,
  }
}

function humanize(seg: string): string {
  return seg.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
}

/** Best-effort human label for a SPA path (no per-page wiring needed).
 *  "/prefixes" → "Prefixes"; "/ips/06acdfd1-…" → "Ips · 06acdfd1". */
export function labelForPath(pathname: string): string {
  const parts = pathname.split("/").filter(Boolean)
  if (parts.length === 0) return "Dashboard"
  const base = humanize(parts[0])
  if (parts.length > 1) {
    const id = parts[parts.length - 1]
    const short = id.length > 10 ? id.slice(0, 8) : humanize(id)
    return `${base} · ${short}`
  }
  return base
}
