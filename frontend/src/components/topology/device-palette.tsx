import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import type { DragEvent, KeyboardEvent, MouseEvent } from "react"
import { useQuery } from "@tanstack/react-query"
import { Check, ChevronDown, Filter, Search, X } from "lucide-react"

import { api } from "@/lib/api"
import type { DevicePaletteRow, Paginated } from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Combobox } from "@/components/ui/combobox"
import type { ComboboxOption } from "@/components/ui/combobox"
import { InfoTip } from "@/components/ui/info-tip"
import { Input } from "@/components/ui/input"
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
import { ColorBadge } from "@/components/cells/color-badge"
import { DEVICE_PICKER_FILTERS } from "@/components/device-picker"
import type { PickerFilter } from "@/components/object-picker"
import { QueryError } from "@/components/query-error"
import { SegmentedTabs } from "@/components/segmented-tabs"
import { cn } from "@/lib/utils"
import { DEVICE_IDS_MIME } from "./diagram/placement"

// The Diagram's device list: every device the user may see, loaded once
// in its light palette shape and filtered here, grouped by role. Rows drag
// onto the canvas (DEVICE_IDS_MIME); double-click or Enter adds them in
// the middle of the screen. A device already on the map is dimmed and
// ticked, and a click on it finds its card.

export const PALETTE_QUERY_KEY = ["devices-palette"] as const

export const fetchPalette = () =>
  api<Paginated<DevicePaletteRow>>("/api/devices/?picker=palette")

/** The palette's query, shared with the page (it names dropped cards). */
export const paletteQuery = {
  queryKey: PALETTE_QUERY_KEY,
  queryFn: fetchPalette,
  staleTime: 5 * 60_000,
}

/** What the palette narrows by; null or absent = any. */
export interface PaletteFilters {
  site?: string | null
  role?: string | null
  device_type?: string | null
  status?: string | null
  rack?: string | null
  /** A tag slug - answered by the server (rows carry no tags). */
  tag?: string | null
}

type FilterKey = keyof PaletteFilters

/** The filters offered, in order: the device list's own (shared option
 * caches), then the rack, which comes from the rows. */
const SHARED_KEYS: FilterKey[] = [
  "site",
  "role",
  "device_type",
  "status",
  "tag",
]

export type PaletteShow = "all" | "unplaced"

const norm = (s: string | null | undefined) => (s ?? "").toLowerCase()

/**
 * The rows that match the search box, the filters, the tag (the ids the
 * server matched, or null for no tag) and the All / Not placed choice.
 * Pure, for the tests.
 */
export function filterPalette(
  rows: readonly DevicePaletteRow[],
  opts: {
    search?: string
    filters?: PaletteFilters
    tagIds?: ReadonlySet<string> | null
    show?: PaletteShow
    placed?: ReadonlySet<string>
  }
): DevicePaletteRow[] {
  const needle = norm(opts.search).trim()
  const f = opts.filters ?? {}
  return rows.filter((r) => {
    if (opts.show === "unplaced" && opts.placed?.has(r.id)) return false
    if (f.site && r.site?.id !== f.site) return false
    if (f.role && r.role?.id !== f.role) return false
    if (f.device_type && r.device_type?.id !== f.device_type) return false
    if (f.status && r.status?.id !== f.status) return false
    if (f.rack && r.rack?.id !== f.rack) return false
    if (opts.tagIds && !opts.tagIds.has(r.id)) return false
    if (!needle) return true
    return (
      norm(r.name).includes(needle) ||
      norm(r.device_type?.model).includes(needle) ||
      norm(r.device_type?.name).includes(needle) ||
      norm(r.site?.name).includes(needle) ||
      norm(r.rack?.name).includes(needle)
    )
  })
}

export interface PaletteGroup {
  /** The role id, or "" for devices without one. */
  key: string
  role: DevicePaletteRow["role"]
  rows: DevicePaletteRow[]
}

/** Rows grouped by role, in the order they came (the server sorts by role
 * name, then natural name, role-less devices last). */
export function groupPalette(
  rows: readonly DevicePaletteRow[]
): PaletteGroup[] {
  const out: PaletteGroup[] = []
  const byKey = new Map<string, PaletteGroup>()
  for (const r of rows) {
    const key = r.role?.id ?? ""
    let g = byKey.get(key)
    if (!g) {
      g = { key, role: r.role, rows: [] }
      byKey.set(key, g)
      out.push(g)
    }
    g.rows.push(r)
  }
  // Role-less devices always last, whatever order they arrived in.
  const none = out.findIndex((g) => g.key === "")
  if (none >= 0 && none !== out.length - 1) out.push(out.splice(none, 1)[0])
  return out
}

type Item =
  | { kind: "group"; group: PaletteGroup; folded: boolean }
  | { kind: "row"; row: DevicePaletteRow }

const GROUP_H = 28
const ROW_H = 40
/** Longer lists are windowed: only the rows on screen are in the DOM. */
export const WINDOW_OVER = 500
const OVERSCAN = 8

/** Drop previews and drag images name the devices being moved. */
function dragImage(label: string): HTMLElement {
  const el = document.createElement("div")
  el.textContent = label
  el.className =
    "fixed -top-24 left-0 rounded-[5px] bg-primary px-2 py-0.5 text-xs font-medium whitespace-nowrap text-primary-foreground"
  document.body.appendChild(el)
  setTimeout(() => el.remove(), 0)
  return el
}

export interface DevicePaletteProps {
  /** Devices already on the map. */
  placed: ReadonlySet<string>
  /** The map is built by hand: rows drag onto it and Enter adds them. */
  editable: boolean
  /** Patch panels are folded away on this map: they cannot be placed. */
  panelsHidden?: boolean
  /** Add these in the middle of what is on screen. */
  onAdd: (rows: DevicePaletteRow[]) => void
  /** A row already on the map was clicked: show its card. */
  onFocus?: (id: string) => void
  /** Offered on a map that follows its filters. */
  onNewView?: () => void
  onClose: () => void
}

export function DevicePalette({
  placed,
  editable,
  panelsHidden = false,
  onAdd,
  onFocus,
  onNewView,
  onClose,
}: DevicePaletteProps) {
  const q = useQuery(paletteQuery)
  const [search, setSearch] = useState("")
  const needle = useDeferredValue(search)
  const [filters, setFilters] = useState<PaletteFilters>({})
  const [show, setShow] = useState<PaletteShow>("all")
  const [folded, setFolded] = useState<ReadonlySet<string>>(() => new Set())
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set())
  const anchor = useRef<string | null>(null)

  const tag = filters.tag ?? null
  const tagQ = useQuery({
    queryKey: [...PALETTE_QUERY_KEY, "tag", tag],
    queryFn: () =>
      api<Paginated<DevicePaletteRow>>(
        `/api/devices/?picker=palette&tag=${encodeURIComponent(tag ?? "")}`
      ),
    enabled: !!tag,
    staleTime: 60_000,
  })
  const tagIds = useMemo(
    () => (tag ? new Set((tagQ.data?.results ?? []).map((r) => r.id)) : null),
    [tag, tagQ.data]
  )

  const all = useMemo(() => q.data?.results ?? [], [q.data])
  const shown = useMemo(
    () =>
      filterPalette(all, {
        search: needle,
        filters,
        tagIds,
        show,
        placed,
      }),
    [all, needle, filters, tagIds, show, placed]
  )
  const groups = useMemo(() => groupPalette(shown), [shown])
  const items = useMemo<Item[]>(() => {
    const out: Item[] = []
    for (const g of groups) {
      const isFolded = folded.has(g.key)
      out.push({ kind: "group", group: g, folded: isFolded })
      if (!isFolded) for (const row of g.rows) out.push({ kind: "row", row })
    }
    return out
  }, [groups, folded])
  /** The rows in list order, for Shift-click ranges. */
  const order = useMemo(
    () => items.flatMap((it) => (it.kind === "row" ? [it.row] : [])),
    [items]
  )
  const unplacedCount = useMemo(
    () => all.filter((r) => !placed.has(r.id)).length,
    [all, placed]
  )

  const blocked = useCallback(
    (r: DevicePaletteRow) =>
      placed.has(r.id) || (panelsHidden && !!r.role?.is_patch_panel),
    [placed, panelsHidden]
  )
  /** What an add or a drag takes: the selection when `r` is in it (in list
   * order, placed rows left out), else just `r`. */
  const takeFrom = (r: DevicePaletteRow): DevicePaletteRow[] =>
    selected.has(r.id)
      ? order.filter((x) => selected.has(x.id) && !blocked(x))
      : blocked(r)
        ? []
        : [r]

  const onRowClick = (e: MouseEvent, r: DevicePaletteRow) => {
    if (placed.has(r.id)) {
      onFocus?.(r.id)
      return
    }
    if (blocked(r)) return
    if (e.shiftKey && anchor.current) {
      const a = order.findIndex((x) => x.id === anchor.current)
      const b = order.findIndex((x) => x.id === r.id)
      if (a >= 0 && b >= 0) {
        const [lo, hi] = a < b ? [a, b] : [b, a]
        setSelected(
          new Set(
            order
              .slice(lo, hi + 1)
              .filter((x) => !blocked(x))
              .map((x) => x.id)
          )
        )
        return
      }
    }
    anchor.current = r.id
    if (e.ctrlKey || e.metaKey) {
      setSelected((cur) => {
        const next = new Set(cur)
        if (next.has(r.id)) next.delete(r.id)
        else next.add(r.id)
        return next
      })
      return
    }
    setSelected(new Set([r.id]))
  }

  const add = (rows: DevicePaletteRow[]) => {
    if (!editable || !rows.length) return
    onAdd(rows)
    setSelected(new Set())
  }

  const onDragStart = (e: DragEvent, r: DevicePaletteRow) => {
    const rows = takeFrom(r)
    if (!editable || !rows.length) {
      e.preventDefault()
      return
    }
    if (!selected.has(r.id)) {
      anchor.current = r.id
      setSelected(new Set([r.id]))
    }
    e.dataTransfer.effectAllowed = "copy"
    e.dataTransfer.setData(
      DEVICE_IDS_MIME,
      JSON.stringify(rows.map((x) => x.id))
    )
    e.dataTransfer.setDragImage(
      dragImage(rows.length === 1 ? rows[0].name : `${rows.length} devices`),
      0,
      0
    )
  }

  const onRowKey = (e: KeyboardEvent, r: DevicePaletteRow) => {
    if (e.key !== "Enter") return
    e.preventDefault()
    if (placed.has(r.id)) onFocus?.(r.id)
    else add(takeFrom(r))
  }

  // The selection only holds rows that are still listed and placeable.
  useEffect(() => {
    setSelected((cur) => {
      if (!cur.size) return cur
      const keep = new Set(
        order.filter((r) => cur.has(r.id) && !blocked(r)).map((r) => r.id)
      )
      return keep.size === cur.size ? cur : keep
    })
  }, [order, blocked])

  // ── windowing ──
  const scroller = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewH, setViewH] = useState(600)
  useEffect(() => {
    const el = scroller.current
    if (!el) return
    const measure = () => setViewH(el.clientHeight || 600)
    measure()
    if (typeof ResizeObserver === "undefined") return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const offsets = useMemo(() => {
    const out = new Array<number>(items.length + 1)
    out[0] = 0
    items.forEach((it, i) => {
      out[i + 1] = out[i] + (it.kind === "group" ? GROUP_H : ROW_H)
    })
    return out
  }, [items])
  const windowed = items.length > WINDOW_OVER
  let first = 0
  let last = items.length
  if (windowed) {
    // Binary search for the first item that reaches into view.
    let lo = 0
    let hi = items.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (offsets[mid + 1] <= scrollTop) lo = mid + 1
      else hi = mid
    }
    first = Math.max(0, lo - OVERSCAN)
    last = first
    while (last < items.length && offsets[last] < scrollTop + viewH) last++
    last = Math.min(items.length, last + OVERSCAN)
  }

  const activeFilters = Object.values(filters).filter(Boolean).length

  return (
    <aside
      className="flex w-64 shrink-0 flex-col border-r border-border bg-background"
      aria-label="Devices"
    >
      <div className="flex items-center justify-between px-3 pt-3 pb-1">
        <span className="text-[11px] font-medium tracking-[0.08em] text-muted-foreground uppercase">
          Devices
        </span>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-1.5"
          onClick={onClose}
          aria-label="Close devices"
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
      {!editable && (
        <div className="mx-2 mb-1 flex items-center gap-2 rounded-md border border-border px-2 py-1.5">
          <span className="text-[11px] whitespace-nowrap text-muted-foreground">
            Filtered map
          </span>
          <InfoTip>
            A filtered map shows what its filters match. Devices are placed on a
            view built by hand - start one with New view.
          </InfoTip>
          {onNewView && (
            <Button
              variant="outline"
              size="sm"
              className="ml-auto h-6 px-2 text-[11px]"
              onClick={onNewView}
            >
              New view…
            </Button>
          )}
        </div>
      )}
      <div className="flex items-center gap-1.5 px-2 pb-1.5">
        <div className="relative min-w-0 flex-1">
          <Search className="absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search devices…"
            aria-label="Search devices"
            className="h-8 pl-7 text-[13px]"
          />
        </div>
        <PaletteFilterPopover
          rows={all}
          filters={filters}
          onChange={setFilters}
          active={activeFilters}
        />
      </div>
      <div className="px-2 pb-1">
        <SegmentedTabs<PaletteShow>
          value={show}
          onValueChange={setShow}
          items={[
            { value: "all", label: "All", count: all.length || null },
            {
              value: "unplaced",
              label: "Not placed",
              count: unplacedCount || null,
            },
          ]}
        />
      </div>
      <div
        ref={scroller}
        role="listbox"
        aria-multiselectable
        aria-label="Devices to place"
        className="relative min-h-0 flex-1 overflow-y-auto px-2 pb-2"
        onScroll={
          windowed
            ? (e) => setScrollTop((e.target as HTMLDivElement).scrollTop)
            : undefined
        }
      >
        {q.isLoading && (
          <p className="px-1 py-2 text-xs text-muted-foreground">Loading...</p>
        )}
        {q.isError && <QueryError error={q.error} />}
        {q.data && !all.length && (
          <p className="px-1 py-2 text-xs text-muted-foreground">
            No devices yet.
          </p>
        )}
        {q.data && all.length > 0 && !shown.length && (
          <p className="px-1 py-2 text-xs text-muted-foreground">
            {show === "unplaced" && !needle && !activeFilters
              ? "Every device is on the map."
              : "No matches."}
          </p>
        )}
        {windowed && <div style={{ height: offsets[first] }} />}
        {items.slice(first, last).map((it) =>
          it.kind === "group" ? (
            <GroupHeader
              key={`g:${it.group.key}`}
              group={it.group}
              folded={it.folded}
              onToggle={() =>
                setFolded((cur) => {
                  const next = new Set(cur)
                  if (next.has(it.group.key)) next.delete(it.group.key)
                  else next.add(it.group.key)
                  return next
                })
              }
            />
          ) : (
            <PaletteRow
              key={it.row.id}
              row={it.row}
              selected={selected.has(it.row.id)}
              placed={placed.has(it.row.id)}
              panelHidden={
                panelsHidden &&
                !!it.row.role?.is_patch_panel &&
                !placed.has(it.row.id)
              }
              draggable={editable && !blocked(it.row)}
              onClick={(e) => onRowClick(e, it.row)}
              onDoubleClick={() => {
                if (!placed.has(it.row.id)) add(takeFrom(it.row))
              }}
              onKeyDown={(e) => onRowKey(e, it.row)}
              onDragStart={(e) => onDragStart(e, it.row)}
            />
          )
        )}
        {windowed && (
          <div style={{ height: offsets[items.length] - offsets[last] }} />
        )}
      </div>
      {editable && selected.size > 0 && (
        <div className="flex items-center gap-2 border-t border-border px-3 py-2">
          <span className="text-[11px] whitespace-nowrap text-muted-foreground">
            <span className="num">{selected.size}</span> selected
          </span>
          <Button
            size="sm"
            className="ml-auto h-6 px-2 text-[11px]"
            onClick={() =>
              add(order.filter((r) => selected.has(r.id) && !blocked(r)))
            }
          >
            Add
          </Button>
        </div>
      )}
    </aside>
  )
}

function GroupHeader({
  group,
  folded,
  onToggle,
}: {
  group: PaletteGroup
  folded: boolean
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={!folded}
      className="flex w-full items-center gap-1.5 rounded px-1 text-left hover:bg-muted/60"
      style={{ height: GROUP_H }}
      data-group={group.key || "none"}
    >
      <ChevronDown
        className={cn(
          "size-3 shrink-0 text-muted-foreground transition-transform",
          folded && "-rotate-90"
        )}
      />
      {group.role ? (
        <ColorBadge
          name={group.role.name}
          color={group.role.color || undefined}
          className="max-w-44"
        />
      ) : (
        <Badge variant="secondary">No role</Badge>
      )}
      <span className="num ml-auto text-[11px] text-muted-foreground/70">
        {group.rows.length}
      </span>
    </button>
  )
}

function PaletteRow({
  row,
  selected,
  placed,
  panelHidden,
  draggable,
  onClick,
  onDoubleClick,
  onKeyDown,
  onDragStart,
}: {
  row: DevicePaletteRow
  selected: boolean
  placed: boolean
  /** A patch panel on a map that folds them away. */
  panelHidden: boolean
  draggable: boolean
  onClick: (e: MouseEvent) => void
  onDoubleClick: () => void
  onKeyDown: (e: KeyboardEvent) => void
  onDragStart: (e: DragEvent) => void
}) {
  const where = [
    row.device_type?.model || row.device_type?.name,
    row.site?.name,
  ]
    .filter(Boolean)
    .join(" · ")
  const body = (
    <div
      role="option"
      aria-selected={selected}
      aria-disabled={panelHidden || undefined}
      tabIndex={0}
      draggable={draggable}
      data-device={row.id}
      data-placed={placed || undefined}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onKeyDown={onKeyDown}
      onDragStart={onDragStart}
      className={cn(
        "flex cursor-default items-center gap-2 rounded-md px-2 outline-none select-none focus-visible:ring-2 focus-visible:ring-ring/50",
        draggable && "cursor-grab active:cursor-grabbing",
        selected ? "bg-muted ring-1 ring-foreground/15" : "hover:bg-muted/60",
        (placed || panelHidden) && "text-muted-foreground/60"
      )}
      style={{ height: ROW_H }}
    >
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] leading-4 font-medium">
          {row.name}
        </div>
        {where && (
          <div
            className={cn(
              "truncate text-[11px] leading-4",
              placed || panelHidden
                ? "text-muted-foreground/50"
                : "text-muted-foreground"
            )}
          >
            {where}
          </div>
        )}
      </div>
      {placed && (
        <Check className="size-3.5 shrink-0" aria-label="On the map" />
      )}
    </div>
  )
  if (!panelHidden) return body
  return (
    <Tooltip>
      <TooltipTrigger asChild>{body}</TooltipTrigger>
      <TooltipContent side="right" variant="default">
        Turn on Show patch panels to place it
      </TooltipContent>
    </Tooltip>
  )
}

/** Options from one of the device list's shared picker caches. */
function useFilterOptions(
  filter: PickerFilter | undefined,
  enabled: boolean
): ComboboxOption[] {
  const q = useQuery({
    queryKey: [filter?.queryKey ?? filter?.key ?? "none"],
    queryFn: () =>
      api<Paginated<{ id: string; name: string; color?: string | null }>>(
        filter?.endpoint ?? ""
      ),
    enabled: enabled && !!filter?.endpoint,
    staleTime: 10 * 60_000,
  })
  return useMemo(
    () =>
      (q.data?.results ?? []).map((o) => ({
        value: filter?.paramOf ? filter.paramOf(o as never) : o.id,
        label: o.name,
        // Roles and statuses read as their pills here too.
        ...(filter?.key === "role" || filter?.key === "status"
          ? { color: o.color || null }
          : {}),
      })),
    [q.data, filter]
  )
}

const LABELS: Record<FilterKey, string> = {
  site: "Site",
  role: "Role",
  device_type: "Type",
  status: "Status",
  tag: "Tag",
  rack: "Rack",
}

function PaletteFilterPopover({
  rows,
  filters,
  onChange,
  active,
}: {
  rows: readonly DevicePaletteRow[]
  filters: PaletteFilters
  onChange: (next: PaletteFilters) => void
  active: number
}) {
  const [open, setOpen] = useState(false)
  const shared = useMemo(
    () =>
      new Map(
        DEVICE_PICKER_FILTERS.filter((f) =>
          SHARED_KEYS.includes(f.key as FilterKey)
        ).map((f) => [f.key as FilterKey, f])
      ),
    []
  )
  const site = useFilterOptions(shared.get("site"), open)
  const role = useFilterOptions(shared.get("role"), open)
  const type = useFilterOptions(shared.get("device_type"), open)
  const status = useFilterOptions(shared.get("status"), open)
  const tag = useFilterOptions(shared.get("tag"), open)
  // Racks come from the devices themselves, narrowed to the chosen site.
  const rack = useMemo(() => {
    const seen = new Map<string, ComboboxOption>()
    for (const r of rows) {
      if (!r.rack || seen.has(r.rack.id)) continue
      if (filters.site && r.site?.id !== filters.site) continue
      seen.set(r.rack.id, {
        value: r.rack.id,
        label: r.rack.name,
        ...(!filters.site && r.site ? { hint: r.site.name } : {}),
      })
    }
    return [...seen.values()].sort((a, b) =>
      a.label.localeCompare(b.label, undefined, { numeric: true })
    )
  }, [rows, filters.site])
  const options: Record<FilterKey, ComboboxOption[]> = {
    site,
    role,
    device_type: type,
    status,
    tag,
    rack,
  }
  const set = (key: FilterKey, v: string | null) => {
    const next = { ...filters, [key]: v }
    // A rack belongs to one site: a new site drops a rack elsewhere.
    if (key === "site") next.rack = null
    onChange(next)
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="h-8 shrink-0 gap-1 px-2 text-xs"
          aria-label="Filter devices"
        >
          <Filter className="h-3.5 w-3.5" />
          {active > 0 && (
            <Badge variant="secondary" className="h-4 px-1 text-[10px]">
              {active}
            </Badge>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" side="right" className="w-64 space-y-3 p-3">
        {(Object.keys(LABELS) as FilterKey[]).map((key) => (
          <div key={key} className="space-y-1">
            <span className="text-[11px] font-medium tracking-[0.04em] whitespace-nowrap text-muted-foreground uppercase">
              {LABELS[key]}
            </span>
            <Combobox
              value={filters[key] ?? null}
              onChange={(v) => set(key, v)}
              options={options[key]}
              noneLabel={`Any ${LABELS[key].toLowerCase()}`}
              placeholder={`Any ${LABELS[key].toLowerCase()}`}
              className="h-8 w-full text-xs"
            />
          </div>
        ))}
        {active > 0 && (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-full text-xs"
            onClick={() => onChange({})}
          >
            Clear filters
          </Button>
        )}
      </PopoverContent>
    </Popover>
  )
}
