import { useMemo, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Check, ListFilter, Lock, Pencil, Trash2, Users } from "lucide-react"
import { Link } from "@tanstack/react-router"
import { useEffect } from "react"
import { toast } from "sonner"

import { api, type Paginated } from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import type { FilterSnapshot } from "@/components/table-filters"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { cn } from "@/lib/utils"

/**
 * Saved views - a named search plus a set of rail filters, per list.
 *
 * The filter rail is derived from the columns a list renders, so its selection
 * describes that list completely (see `useTableFilters`). A saved view is just
 * that selection under a name, which is why one component serves every list
 * instead of each model needing its own stored-query grammar.
 *
 * Yours are private until you share them into the tenant. Applying someone
 * else's shared view re-runs *your* list request, so it can only ever show you
 * rows you could already see.
 */

export interface SavedView {
  id: string
  object_type: string
  name: string
  description: string
  query: { q?: string; facets?: FilterSnapshot }
  shared: boolean
  owner: string
  mine: boolean
  updated_at?: string
}

export interface SavedViewsProps {
  /** RBAC object slug of this list, e.g. "device". */
  objectType: string
  /** Free-text search - part of the view, so it saves and restores with it. */
  q: string
  onQ: (value: string) => void
  filters: {
    snapshot: () => FilterSnapshot
    restore: (snapshot: FilterSnapshot | null | undefined) => void
    activeCount: number
  }
}

function useSavedViews(objectType: string) {
  return useQuery({
    queryKey: ["saved-views", objectType],
    queryFn: () =>
      api<Paginated<SavedView>>(
        `/api/saved-filters/?object_type=${objectType}&page_size=100`
      ),
    staleTime: 60_000,
  })
}

export function SavedViews({ objectType, q, onQ, filters }: SavedViewsProps) {
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const [naming, setNaming] = useState(false)
  const [name, setName] = useState("")
  const [shared, setShared] = useState(false)
  const [applied, setApplied] = useState<SavedView | null>(null)

  // The advanced-filter dialog's "Apply & save as view" lands here: same
  // page, different subtree, so a window event is the whole bridge.
  useEffect(() => {
    const onSave = () => {
      setOpen(true)
      setNaming(true)
    }
    window.addEventListener("danbyte:save-view", onSave)
    return () => window.removeEventListener("danbyte:save-view", onSave)
  }, [])

  const views = useSavedViews(objectType)
  const rows = views.data?.results ?? []
  const mine = rows.filter((v) => v.mine)
  const theirs = rows.filter((v) => !v.mine)

  const invalidate = () =>
    qc.invalidateQueries({ queryKey: ["saved-views", objectType] })

  const save = useMutation({
    mutationFn: (body: Partial<SavedView>) =>
      api<SavedView>("/api/saved-filters/", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: (view) => {
      setApplied(view)
      setNaming(false)
      setName("")
      setShared(false)
      setOpen(false)
      invalidate()
      toast.success(`Saved “${view.name}”`)
    },
    onError: (e) => apiErrorToast(e, "Could not save this view"),
  })

  const update = useMutation({
    mutationFn: (view: SavedView) =>
      api<SavedView>(`/api/saved-filters/${view.id}/`, {
        method: "PATCH",
        body: JSON.stringify({ query: currentQuery() }),
      }),
    onSuccess: (view) => {
      setApplied(view)
      invalidate()
      toast.success(`Updated “${view.name}”`)
    },
    onError: (e) => apiErrorToast(e, "Could not update this view"),
  })

  const remove = useMutation({
    mutationFn: (view: SavedView) =>
      api(`/api/saved-filters/${view.id}/`, { method: "DELETE" }),
    onSuccess: (_data, view) => {
      if (applied?.id === view.id) setApplied(null)
      invalidate()
    },
    onError: (e) => apiErrorToast(e, "Could not delete this view"),
  })

  const currentQuery = () => ({ q, facets: filters.snapshot() })

  const apply = (view: SavedView) => {
    onQ(view.query.q ?? "")
    filters.restore(view.query.facets)
    setApplied(view)
    setOpen(false)
  }

  const clear = () => {
    onQ("")
    filters.restore(null)
    setApplied(null)
    setOpen(false)
  }

  const anythingActive = filters.activeCount > 0 || q.trim() !== ""
  // "Edited" is the honest state when the rail no longer matches the view whose
  // name is on the button - otherwise the label would lie about what you see.
  const edited = useMemo(() => {
    if (!applied) return false
    return (
      JSON.stringify(currentQuery()) !==
      JSON.stringify({
        q: applied.query.q ?? "",
        facets: applied.query.facets ?? {},
      })
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [applied, q, filters.activeCount, JSON.stringify(filters.snapshot())])

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) setNaming(false)
      }}
    >
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="max-w-56 justify-start gap-1.5"
          title="Saved views for this list"
        >
          <ListFilter className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate">{applied ? applied.name : "Views"}</span>
          {applied && edited && (
            <span className="shrink-0 text-[11px] text-muted-foreground">
              edited
            </span>
          )}
        </Button>
      </PopoverTrigger>

      {/* Deliberately wide: a view is picked by reading its name and who owns
          it, which a 200px menu cannot show without truncating both. */}
      <PopoverContent align="start" className="w-[22rem] p-0">
        <div className="max-h-80 overflow-y-auto p-1.5">
          {views.isLoading && (
            <p className="px-2 py-3 text-xs text-muted-foreground">
              Loading...
            </p>
          )}
          {!views.isLoading && rows.length === 0 && (
            <p className="px-2 py-3 text-[13px] text-muted-foreground">
              No saved views yet. Filter the list, then save it as a view.
            </p>
          )}

          <ViewGroup
            label="Yours"
            views={mine}
            applied={applied}
            onApply={apply}
            onDelete={(v) => remove.mutate(v)}
          />
          <ViewGroup
            label="Shared with you"
            views={theirs}
            applied={applied}
            onApply={apply}
          />
        </div>

        <div className="border-t border-border p-1.5">
          {naming ? (
            <div className="space-y-2 p-1">
              <Input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && name.trim()) {
                    save.mutate({
                      object_type: objectType,
                      name: name.trim(),
                      shared,
                      query: currentQuery(),
                    })
                  }
                  if (e.key === "Escape") setNaming(false)
                }}
                placeholder="Name this view"
                className="h-8"
              />
              <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
                <Checkbox
                  checked={shared}
                  onCheckedChange={(v) => setShared(!!v)}
                />
                Share with everyone in this tenant
              </label>
              <div className="flex justify-end gap-2">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setNaming(false)}
                >
                  Cancel
                </Button>
                <Button
                  size="sm"
                  disabled={!name.trim() || save.isPending}
                  onClick={() =>
                    save.mutate({
                      object_type: objectType,
                      name: name.trim(),
                      shared,
                      query: currentQuery(),
                    })
                  }
                >
                  {save.isPending ? "Saving..." : "Save view"}
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-1">
              <Button
                size="sm"
                variant="ghost"
                className="justify-start"
                disabled={!anythingActive}
                title={
                  anythingActive
                    ? "Save the current search and filters as a view"
                    : "Filter the list first"
                }
                onClick={() => setNaming(true)}
              >
                Save current filters
              </Button>
              {applied && edited && applied.mine && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={update.isPending}
                  onClick={() => update.mutate(applied)}
                >
                  {update.isPending ? "Updating..." : "Update"}
                </Button>
              )}
              {anythingActive && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="ml-auto text-muted-foreground"
                  onClick={clear}
                >
                  Clear
                </Button>
              )}
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}

function ViewGroup({
  label,
  views,
  applied,
  onApply,
  onDelete,
}: {
  label: string
  views: SavedView[]
  applied: SavedView | null
  onApply: (view: SavedView) => void
  onDelete?: (view: SavedView) => void
}) {
  if (views.length === 0) return null
  return (
    <section className="mb-1 last:mb-0">
      <h4 className="px-2 py-1 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
        {label}
      </h4>
      {views.map((view) => (
        <div
          key={view.id}
          className={cn(
            "group flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-accent",
            applied?.id === view.id && "bg-accent"
          )}
        >
          <button
            type="button"
            className="flex min-w-0 flex-1 flex-col items-start text-left"
            onClick={() => onApply(view)}
          >
            <span className="flex w-full items-center gap-1.5">
              <span className="truncate text-[13px]">{view.name}</span>
              {view.shared ? (
                <Users className="h-3 w-3 shrink-0 text-muted-foreground" />
              ) : (
                <Lock className="h-3 w-3 shrink-0 text-muted-foreground" />
              )}
              {applied?.id === view.id && (
                <Check className="ml-auto h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              )}
            </span>
            {(view.description || !view.mine) && (
              <span className="truncate text-[11px] text-muted-foreground">
                {view.description || `by ${view.owner}`}
              </span>
            )}
          </button>
          {view.mine && (
            <Button
              size="icon-sm"
              variant="ghost"
              asChild
              className="shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
              title={`Edit “${view.name}”`}
            >
              <Link to="/saved-filters" search={{ edit: view.id }}>
                <Pencil className="h-3.5 w-3.5" />
              </Link>
            </Button>
          )}
          {onDelete && (
            <Button
              size="icon-sm"
              variant="ghost"
              className="shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
              title={`Delete “${view.name}”`}
              onClick={() => onDelete(view)}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      ))}
    </section>
  )
}
