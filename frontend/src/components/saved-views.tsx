import { useEffect, useMemo, useRef, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  Check,
  ListFilter,
  Lock,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Trash2,
  Users,
} from "lucide-react"
import { Link } from "@tanstack/react-router"
import { toast } from "sonner"

import { api, type Paginated } from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { useMe } from "@/lib/use-me"
import type { FilterSnapshot } from "@/components/table-filters"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Loading } from "@/components/loading"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
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
 *
 * A pinned view is the list's default (#523): opened with no filter or search
 * in the URL, the list applies it - yours, else the one an administrator
 * pinned for everyone. A link that carries filters always wins.
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
  /** Your pin: the view this list opens with. */
  is_default?: boolean
  /** The tenant's pin, for everyone without one of their own. */
  is_tenant_default?: boolean
  updated_at?: string
}

export interface SavedViewsFilters {
  snapshot: () => FilterSnapshot
  restore: (snapshot: FilterSnapshot | null | undefined) => void
  activeCount: number
}

export interface SavedViewsProps {
  /** RBAC object slug of this list, e.g. "device". */
  objectType: string
  /** Free-text search - part of the view, so it saves and restores with it. */
  q: string
  onQ: (value: string) => void
  filters: SavedViewsFilters
  /** The list's default view, when the page resolves it itself (a server
   * list holds its first request for it - `useServerList`). Otherwise the
   * menu resolves it. */
  defaultView?: DefaultView
  /** What the empty menu suggests, and the disabled save's tip - "the
   * list" unless the page says otherwise (a floor plan). */
  emptyHint?: string
  filterFirstHint?: string
  /** A map's bar: the bar's h-7 size. */
  compact?: boolean
}

export function savedViewsKey(objectType: string) {
  return ["saved-views", objectType]
}

export function useSavedViews(objectType: string, enabled = true) {
  return useQuery({
    queryKey: savedViewsKey(objectType),
    queryFn: () =>
      api<Paginated<SavedView>>(
        `/api/saved-filters/?object_type=${encodeURIComponent(objectType)}&page_size=100`
      ),
    staleTime: 60_000,
    enabled,
  })
}

/** Yours, else the tenant's. */
export function pinnedView(views: SavedView[] | undefined): SavedView | null {
  const rows = views ?? []
  return (
    rows.find((v) => v.is_default) ??
    rows.find((v) => v.is_tenant_default) ??
    null
  )
}

function emptyQuery(view: SavedView): boolean {
  const facets = view.query.facets ?? {}
  return (
    !(view.query.q ?? "").trim() &&
    Object.values(facets).every((v) =>
      Array.isArray(v)
        ? v.length === 0
        : typeof v === "string"
          ? v === ""
          : !v.min && !v.max
    )
  )
}

export interface DefaultView {
  /** The pinned view (yours, else the tenant's), once the views are in. */
  pinned: SavedView | null
  /** The pinned view this visit opened with; null once shown all. */
  applied: SavedView | null
  /** Still deciding: the list should not fetch yet. */
  holding: boolean
  /** Open the list unfiltered, this once. */
  showAll: () => void
}

/** How long a pinned view may take to reach the URL before the list stops
 * waiting for it (a view whose facets the list no longer has never does). */
const APPLY_TIMEOUT_MS = 1500

/**
 * The list's default view: on a visit that opened with no filter and no
 * search, apply the pinned view once. `q` and `filters` are the list's
 * current state; `holding` is true until it is settled, so a server list
 * does not fetch the unfiltered page first.
 */
export function useDefaultView({
  objectType,
  q,
  onQ,
  filters,
  enabled = true,
}: {
  objectType: string
  q: string
  onQ: (value: string) => void
  filters: SavedViewsFilters
  enabled?: boolean
}): DefaultView {
  const hasState = filters.activeCount > 0 || q.trim() !== ""
  // Decided on the visit's first render: a link with filters beats the pin.
  const openedBare = useRef<boolean | null>(null)
  if (openedBare.current === null) openedBare.current = !hasState
  const [phase, setPhase] = useState<"wait" | "applying" | "done">(() =>
    openedBare.current && enabled ? "wait" : "done"
  )
  const [applied, setApplied] = useState<SavedView | null>(null)
  const views = useSavedViews(objectType, enabled)
  const pinned = pinnedView(views.data?.results)

  useEffect(() => {
    if (!enabled || phase !== "wait") return
    if (views.isError) return setPhase("done")
    if (!views.data) return
    if (!pinned || hasState || emptyQuery(pinned)) return setPhase("done")
    onQ(pinned.query.q ?? "")
    filters.restore(pinned.query.facets)
    setApplied(pinned)
    setPhase("applying")
  }, [enabled, phase, views.data, views.isError, pinned, hasState])

  useEffect(() => {
    if (phase !== "applying") return
    if (hasState) return setPhase("done")
    const t = setTimeout(() => setPhase("done"), APPLY_TIMEOUT_MS)
    return () => clearTimeout(t)
  }, [phase, hasState])

  return {
    pinned,
    applied,
    holding: enabled && phase !== "done",
    showAll: () => {
      onQ("")
      filters.restore(null)
      setApplied(null)
    },
  }
}

function sameQuery(view: SavedView, q: string, snapshot: FilterSnapshot) {
  return (
    JSON.stringify({ q, facets: snapshot }) ===
    JSON.stringify({ q: view.query.q ?? "", facets: view.query.facets ?? {} })
  )
}

export function SavedViews({
  objectType,
  q,
  onQ,
  filters,
  defaultView,
  emptyHint = "No saved views yet. Filter the list, then save it as a view.",
  filterFirstHint = "Filter the list first",
  compact = false,
}: SavedViewsProps) {
  const qc = useQueryClient()
  const { canManage } = useMe()
  const [open, setOpen] = useState(false)
  const [naming, setNaming] = useState(false)
  const [name, setName] = useState("")
  const [shared, setShared] = useState(false)
  const [applied, setApplied] = useState<SavedView | null>(null)

  // The page's own resolution when it has one, else ours.
  const own = useDefaultView({
    objectType,
    q,
    onQ,
    filters,
    enabled: !defaultView,
  })
  const def = defaultView ?? own
  // The pinned view the visit opened with is the applied one.
  useEffect(() => {
    if (def.applied) setApplied(def.applied)
  }, [def.applied])

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
    qc.invalidateQueries({ queryKey: savedViewsKey(objectType) })

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

  const pin = useMutation({
    mutationFn: ({
      view,
      scope,
      on,
    }: {
      view: SavedView
      scope: "me" | "tenant"
      on: boolean
    }) =>
      on
        ? api<SavedView>(`/api/saved-filters/${view.id}/pin/`, {
            method: "POST",
            body: JSON.stringify({ scope }),
          })
        : api<SavedView>(`/api/saved-filters/${view.id}/pin/?scope=${scope}`, {
            method: "DELETE",
          }),
    onSuccess: () => invalidate(),
    onError: (e) => apiErrorToast(e, "Could not change the default view"),
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
  const snapSig = JSON.stringify(filters.snapshot())
  // "Edited" is the honest state when the rail no longer matches the view whose
  // name is on the button - otherwise the label would lie about what you see.
  const edited = useMemo(() => {
    if (!applied) return false
    return !sameQuery(applied, q, JSON.parse(snapSig) as FilterSnapshot)
  }, [applied, q, snapSig])

  // The chip says the list opened filtered by its pin, until it is edited.
  const showChip =
    !!def.applied && applied?.id === def.applied.id && !edited && !def.holding

  return (
    <>
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
            className={cn(
              "max-w-56 justify-start gap-1.5",
              compact && "h-7 px-2 text-xs"
            )}
          >
            <ListFilter className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate">{applied ? applied.name : "Views"}</span>
            {applied && edited && (
              <span className="shrink-0 text-[11px] text-muted-foreground">
                Edited
              </span>
            )}
          </Button>
        </PopoverTrigger>

        {/* Deliberately wide: a view is picked by reading its name and who owns
            it, which a 200px menu cannot show without truncating both. */}
        <PopoverContent align="start" className="w-[22rem] p-0">
          <div className="max-h-80 overflow-y-auto p-1.5">
            {views.isLoading && <Loading className="min-h-16" />}
            {!views.isLoading && rows.length === 0 && (
              <p className="px-2 py-3 text-[13px] text-muted-foreground">
                {emptyHint}
              </p>
            )}

            <ViewGroup
              label="Yours"
              views={mine}
              applied={applied}
              onApply={apply}
              onDelete={(v) => remove.mutate(v)}
              onPin={(view, scope, on) => pin.mutate({ view, scope, on })}
              canPinForEveryone={canManage}
            />
            <ViewGroup
              label="Shared with you"
              views={theirs}
              applied={applied}
              onApply={apply}
              onPin={(view, scope, on) => pin.mutate({ view, scope, on })}
              canPinForEveryone={canManage}
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
                    {save.isPending ? "Saving…" : "Save view"}
                  </Button>
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-1">
                {anythingActive ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="justify-start"
                    onClick={() => setNaming(true)}
                  >
                    Save current filters
                  </Button>
                ) : (
                  // A disabled button takes no pointer: the tip hangs on a
                  // wrapper.
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="inline-flex">
                        <Button
                          size="sm"
                          variant="ghost"
                          className="justify-start"
                          disabled
                        >
                          Save current filters
                        </Button>
                      </span>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" variant="default">
                      {filterFirstHint}
                    </TooltipContent>
                  </Tooltip>
                )}
                {applied && edited && applied.mine && (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={update.isPending}
                    onClick={() => update.mutate(applied)}
                  >
                    {update.isPending ? "Updating…" : "Update"}
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
      {showChip && def.applied && (
        <DefaultViewChip
          name={def.applied.name}
          compact={compact}
          onShowAll={() => {
            def.showAll()
            setApplied(null)
          }}
        />
      )}
    </>
  )
}

/** "This list opened with its pinned view" - and the way out, once. */
function DefaultViewChip({
  name,
  compact,
  onShowAll,
}: {
  name: string
  compact?: boolean
  onShowAll: () => void
}) {
  return (
    <span
      data-testid="default-view-chip"
      className={cn(
        "inline-flex max-w-64 items-center gap-1.5 rounded-md border border-border bg-muted/40 pr-0.5 pl-2 text-xs",
        compact ? "h-7" : "h-8"
      )}
    >
      <Pin className="h-3 w-3 shrink-0 text-muted-foreground" />
      <span className="truncate">{name}</span>
      <Button
        size="sm"
        variant="ghost"
        className="h-6 shrink-0 px-1.5 text-xs text-muted-foreground"
        onClick={onShowAll}
      >
        Show all
      </Button>
    </span>
  )
}

function ViewGroup({
  label,
  views,
  applied,
  onApply,
  onDelete,
  onPin,
  canPinForEveryone,
}: {
  label: string
  views: SavedView[]
  applied: SavedView | null
  onApply: (view: SavedView) => void
  onDelete?: (view: SavedView) => void
  onPin: (view: SavedView, scope: "me" | "tenant", on: boolean) => void
  canPinForEveryone: boolean
}) {
  if (views.length === 0) return null
  return (
    <section className="mb-1 last:mb-0">
      <h4 className="px-2 py-1 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
        {label}
      </h4>
      {views.map((view) => {
        const pinned = !!view.is_default
        const sub = view.is_tenant_default
          ? "Default for everyone"
          : view.description || (!view.mine ? `by ${view.owner}` : "")
        return (
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
              {sub && (
                <span className="truncate text-[11px] text-muted-foreground">
                  {sub}
                </span>
              )}
            </button>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  className={cn(
                    "shrink-0",
                    pinned
                      ? "text-foreground"
                      : "text-muted-foreground opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                  )}
                  aria-label={
                    pinned ? `Unpin “${view.name}”` : `Pin “${view.name}”`
                  }
                  aria-pressed={pinned}
                  onClick={() => onPin(view, "me", !pinned)}
                >
                  {pinned ? (
                    <PinOff className="h-3.5 w-3.5" />
                  ) : (
                    <Pin className="h-3.5 w-3.5" />
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom" variant="default">
                {pinned ? "Unpin" : "Pin as default"}
              </TooltipContent>
            </Tooltip>
            {canPinForEveryone && view.shared && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    className="shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
                    aria-label={`More for “${view.name}”`}
                  >
                    <MoreHorizontal className="h-3.5 w-3.5" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem
                    onSelect={() =>
                      onPin(view, "tenant", !view.is_tenant_default)
                    }
                  >
                    {view.is_tenant_default ? (
                      <PinOff className="h-3.5 w-3.5" />
                    ) : (
                      <Pin className="h-3.5 w-3.5" />
                    )}
                    {view.is_tenant_default
                      ? "Unpin for everyone"
                      : "Pin for everyone"}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            {view.mine && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    asChild
                    className="shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                    aria-label={`Edit “${view.name}”`}
                  >
                    <Link to="/saved-filters" search={{ edit: view.id }}>
                      <Pencil className="h-3.5 w-3.5" />
                    </Link>
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom" variant="default">
                  Edit “{view.name}”
                </TooltipContent>
              </Tooltip>
            )}
            {onDelete && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    className="shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                    aria-label={`Delete “${view.name}”`}
                    onClick={() => onDelete(view)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom" variant="default">
                  Delete “{view.name}”
                </TooltipContent>
              </Tooltip>
            )}
          </div>
        )
      })}
    </section>
  )
}
