import { Suspense } from "react"
import type { ReactNode } from "react"
import { Link } from "@tanstack/react-router"
import { GripVertical, Plus, X } from "lucide-react"
import {
  Responsive,
  useContainerWidth,
  verticalCompactor,
} from "react-grid-layout"
import "react-grid-layout/css/styles.css"

import type { DashboardData } from "@/lib/api"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  CATALOG,
  CATALOG_BY_ID,
  DEFAULT_GRID_LAYOUT,
  baseWidgetId,
  metaFor,
} from "@/components/dashboard/catalog"
import type { WidgetFit, WidgetId } from "@/components/dashboard/catalog"
import { ROW_HEIGHT, fromRglLayout, toRglLayout } from "@/lib/dashboard-layout"
import type { DashItem } from "@/lib/dashboard-layout"

// The dashboard board - grid, tiles, the count strip and the add menu -
// shared by the home dashboard (/) and named dashboards (/dashboards/$id).
// Each page owns where its layout is loaded from and saved to.

// Layout items may be instances ("floorplan#2"); the catalog is keyed on the
// base id.
export const metaForItem = (id: string) => metaFor(baseWidgetId(id))

export const builtinLayout = (): DashItem[] =>
  DEFAULT_GRID_LAYOUT.map(({ id, x, y, w, h }) => ({ id, x, y, w, h }))

/** A layout with widget ``id`` appended at the bottom - a fresh instance id
 * (floorplan#2) for a widget that may appear more than once. */
export function withWidget(items: DashItem[], id: WidgetId): DashItem[] {
  let itemId: string = id
  if (items.some((x) => x.id === id)) {
    if (!CATALOG.find((w) => w.id === id)?.multi) return items
    let n = 2
    while (items.some((x) => x.id === `${id}#${n}`)) n += 1
    itemId = `${id}#${n}`
  }
  const meta = metaFor(id)
  const bottom = items.reduce((m, x) => Math.max(m, x.y + x.h), 0)
  return [
    ...items,
    { id: itemId, x: 0, y: bottom, w: meta.span.w, h: meta.span.h },
  ]
}

export function AddWidgetMenu({
  items,
  onAdd,
}: {
  items: DashItem[]
  onAdd: (id: WidgetId) => void
}) {
  const available = CATALOG.filter(
    (w) => w.multi || !items.some((x) => baseWidgetId(x.id) === w.id)
  )
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm">
          <Plus className="h-3.5 w-3.5" /> Add widget
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel className="text-[10px] tracking-wider uppercase">
          Widgets
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {available.length === 0 && (
          <div className="px-2 py-3 text-center text-xs text-muted-foreground">
            All widgets added.
          </div>
        )}
        {available.map((w) => (
          <DropdownMenuItem
            key={w.id}
            onClick={() => onAdd(w.id)}
            className="flex flex-col items-start gap-0.5"
          >
            <span className="text-[13px] font-medium">{w.title}</span>
            <span className="text-[11px] text-muted-foreground">
              {w.description}
            </span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** The grid itself - separated so useContainerWidth only runs when data is
 * ready (hooks stay above every early return, per the hook-order guard). */
export function DashboardGrid({
  items,
  editing,
  interacting,
  setInteracting,
  persist,
  remove,
  d,
  scope = "",
}: {
  items: DashItem[]
  editing: boolean
  interacting: boolean
  setInteracting: (v: boolean) => void
  persist: (next: DashItem[]) => void
  remove: (id: string) => void
  d: DashboardData
  /** The board's scope and frame as query params, for widgets that fetch
   * their own data. Empty on the home dashboard. */
  scope?: string
}) {
  const { width, containerRef, mounted } = useContainerWidth()
  // The stop callbacks receive the final layout - one commit point, so a
  // span can never change while widget bodies are mounted (#42 guard).
  const onStop = (
    layout: readonly { i: string; x: number; y: number; w: number; h: number }[]
  ) => {
    setInteracting(false)
    // RGL only reports geometry - per-instance config must survive the move.
    const byId = new Map(items.map((x) => [x.id, x]))
    persist(
      fromRglLayout(layout).map((it) => ({
        ...it,
        config: byId.get(it.id)?.config,
      }))
    )
  }
  return (
    <div ref={containerRef}>
      {mounted && width > 0 && (
        <Responsive
          width={width}
          breakpoints={{ xl: 1100, lg: 800, sm: 520, xs: 0 }}
          cols={{ xl: 6, lg: 4, sm: 2, xs: 1 }}
          rowHeight={ROW_HEIGHT}
          margin={[16, 16]}
          containerPadding={[0, 0]}
          compactor={verticalCompactor}
          layouts={{ xl: toRglLayout(items, metaForItem) }}
          dragConfig={{ enabled: editing, handle: ".dash-drag-handle" }}
          resizeConfig={{
            enabled: editing,
            // The library's default grip is a faint 5px triangle nobody
            // finds. This one is an always-visible corner bracket while in
            // edit mode - see .dash-resize-grip in styles.css.
            handleComponent: (axis, ref) => (
              <span
                ref={ref}
                className={`react-resizable-handle react-resizable-handle-${axis} dash-resize-grip`}
                title="Drag to resize"
              />
            ),
          }}
          onDragStart={() => setInteracting(true)}
          onResizeStart={() => setInteracting(true)}
          onDragStop={onStop}
          onResizeStop={onStop}
        >
          {items.map((it) => {
            const w = CATALOG_BY_ID[baseWidgetId(it.id)]
            if (!w) return null
            return (
              <div key={it.id}>
                <WidgetTile
                  title={w.title}
                  description={w.description}
                  fit={w.fit ?? "scroll"}
                  editing={editing}
                  interacting={interacting}
                  onRemove={() => remove(it.id)}
                >
                  {w.render(d, {
                    config: it.config,
                    editing,
                    scope,
                    setConfig: (c) =>
                      persist(
                        items.map((x) =>
                          x.id === it.id ? { ...x, config: c } : x
                        )
                      ),
                  })}
                </WidgetTile>
              </div>
            )
          })}
        </Responsive>
      )}
    </div>
  )
}

/** One widget card. The grid supplies the height; `fit` says how the body
 * copes - lists scroll, fixed-size charts centre, the map stretches. */
const FIT_CLASS: Record<WidgetFit, string> = {
  scroll: "min-h-0 flex-1 overflow-auto",
  center: "min-h-0 flex-1 flex flex-col justify-center overflow-hidden",
  stretch: "min-h-0 flex-1 overflow-hidden",
}

function WidgetTile({
  title,
  description,
  fit,
  editing,
  interacting,
  onRemove,
  children,
}: {
  title: string
  description: string
  fit: WidgetFit
  editing: boolean
  interacting: boolean
  onRemove: () => void
  children: ReactNode
}) {
  return (
    <div
      className={`flex h-full flex-col overflow-hidden rounded-lg border bg-card p-3.5 ${
        editing ? "border-dashed border-primary/40" : "border-border"
      }`}
    >
      <div className="mb-2 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">{title}</div>
          <div className="truncate text-[11px] text-muted-foreground">
            {description}
          </div>
        </div>
        {editing && (
          <div className="flex shrink-0 items-center gap-0.5">
            <span
              className="dash-drag-handle cursor-grab touch-none rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground active:cursor-grabbing"
              title="Drag to move"
              aria-label="Drag to move"
            >
              <GripVertical className="h-3.5 w-3.5" />
            </span>
            <button
              type="button"
              onClick={onRemove}
              className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
              title="Remove widget"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
      </div>
      {/* While any drag/resize is in flight the body is a static box: no
          ResizeObserver runs, so recharts can't loop into React #185. */}
      {interacting ? (
        <div className="min-h-0 flex-1 rounded-md bg-muted/30" />
      ) : (
        <div className={FIT_CLASS[fit]}>
          <Suspense
            fallback={
              <div className="h-32 animate-pulse rounded-md bg-muted/40" />
            }
          >
            {children}
          </Suspense>
        </div>
      )}
    </div>
  )
}

/** Full-width count + health strip across the top. */
export function StatBand({ d }: { d: DashboardData }) {
  const alerts = (d.alerts_by_severity ?? []).reduce((n, a) => n + a.count, 0)
  const cells: {
    label: string
    value: number | string
    to?: string
    tone?: "ok" | "warn" | "bad"
  }[] = [
    { label: "Sites", value: d.counts.sites ?? 0, to: "/sites" },
    { label: "Prefixes", value: d.counts.prefixes ?? 0, to: "/prefixes" },
    { label: "IP addresses", value: d.counts.ips ?? 0 },
    { label: "VLANs", value: d.counts.vlans ?? 0, to: "/vlans" },
    { label: "Devices", value: d.counts.devices ?? 0, to: "/devices" },
    { label: "Cables", value: d.counts.cables ?? 0, to: "/cables" },
    {
      label: "Reachable",
      value: d.reachable_pct != null ? `${d.reachable_pct}%` : "-",
      tone:
        d.reachable_pct == null
          ? undefined
          : d.reachable_pct >= 95
            ? "ok"
            : d.reachable_pct >= 80
              ? "warn"
              : "bad",
    },
    {
      label: "Firing alerts",
      value: alerts,
      to: "/alerts",
      tone: alerts > 0 ? "bad" : undefined,
    },
  ]
  const tone = {
    ok: "text-emerald-600 dark:text-emerald-400",
    warn: "text-amber-600 dark:text-amber-400",
    bad: "text-red-600 dark:text-red-400",
  }
  return (
    <div className="grid grid-cols-2 divide-x divide-y divide-border overflow-hidden rounded-lg border border-border bg-card sm:grid-cols-4 xl:grid-cols-8">
      {cells.map((c) => {
        const body = (
          <>
            <div className="text-[11px] text-muted-foreground">{c.label}</div>
            <div
              className={`num mt-1 text-2xl font-semibold tracking-tight tabular-nums ${c.tone ? tone[c.tone] : ""}`}
            >
              {typeof c.value === "number" ? c.value.toLocaleString() : c.value}
            </div>
          </>
        )
        return c.to ? (
          <Link
            key={c.label}
            to={c.to}
            className="p-3.5 transition-colors hover:bg-muted/40"
          >
            {body}
          </Link>
        ) : (
          <div key={c.label} className="p-3.5">
            {body}
          </div>
        )
      })}
    </div>
  )
}
