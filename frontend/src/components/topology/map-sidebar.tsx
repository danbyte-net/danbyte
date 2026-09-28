import { useMemo, useState } from "react"
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core"
import type { DragEndEvent } from "@dnd-kit/core"
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import { GripVertical, Layers } from "lucide-react"

import type {
  BulkStatusEntry,
  TopoEdge,
  TopoNode,
  TopologyGraph,
} from "@/lib/api"
import { Input } from "@/components/ui/input"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { ColorBadge } from "@/components/cells/color-badge"
import {
  CheckCountBadge,
  FoldableGroup,
  RowCheckBadge,
  VisibilityToggle,
} from "@/components/foldable-group"
import { hiddenCount, setHidden } from "@/components/hidden-objects"
import {
  ObjectsEmpty,
  ObjectsPanel,
  ObjectsSection,
  checkCounts,
} from "@/components/objects-panel"
import type { CheckFilter } from "@/components/objects-panel"
import { SegmentedTabs } from "@/components/segmented-tabs"
import type { TopoGroupData } from "./group-node"
import {
  BGP_SESSIONS,
  DISCOVERED,
  NO_LOCATION,
  NO_ROLE,
  NO_SITE,
  NO_TOPO_HIDDEN,
  UNTYPED,
  edgeHidden,
  familyLabel,
  linkFamily,
  nodeHidden,
} from "./hidden"
import type { TopoHidden } from "./hidden"
import { LazyRows } from "./lazy-rows"
import { typeColor } from "./topology-canvas"
import { ZONE_COLORS } from "./view-positions"
import type { Zone } from "./view-positions"
import { isRow, isSide } from "./diagram/bands"
import { bandLook } from "./diagram/band-node"

// The topology page's Objects sidebar - the site map's, with the graph's own
// objects: device cards grouped by role, site or location, the
// site/location aggregates when the map is grouped, the links by media
// type, and the bands and zones drawn behind the cards. Click flies to and
// selects, like clicking the card; a band or zone row pans to the box and
// renames it on double-click, like the box itself, and the layer bands
// reorder by dragging (cards and all). The eyes are the site map's: a group
// header hides its key (the role, the site, the media type), a row hides
// that one card. Hidden objects stay listed, dimmed, so "where did my core
// switch go" answers itself.

export type GroupMode = "role" | "site" | "location"
const GROUP_MODES: [GroupMode, string][] = [
  ["role", "Role"],
  ["site", "Site"],
  ["location", "Location"],
]
const GROUP_MODE_KEY = "topology:sidebar-group"
const FOLDS = "topology:groups"

export function readGroupMode(): GroupMode {
  try {
    const v = localStorage.getItem(GROUP_MODE_KEY)
    return v === "site" || v === "location" ? v : "role"
  } catch {
    return "role"
  }
}

// A row's height (px) before it is drawn - see LazyRows: a device or
// problem row, a site/location row, a link row with its cable's label.
const ROW_H = 26
const GROUP_ROW_H = 27.5
const LINK_ROW_H = 42.5

/** down < degraded < everything else - the sidebar's triage order. */
function checkRank(check: string | null | undefined): number {
  return check === "down" ? 0 : check === "degraded" ? 1 : 2
}

const byName = <T extends { name: string }>(a: T, b: T) =>
  a.name.localeCompare(b.name, undefined, { numeric: true })

interface DeviceRow {
  id: string
  device_id: string
  name: string
  check: string | null
  data: TopoNode["data"]
  node: TopoNode
}

function groupTitle(d: TopoNode["data"], mode: GroupMode): string {
  if (mode === "site") return d.site ?? NO_SITE
  if (mode === "location") return d.location ?? NO_LOCATION
  return d.role?.name ?? NO_ROLE
}
/** The hidden-set key a device grouping's eyes write. */
const GROUP_KEY: Record<GroupMode, keyof TopoHidden> = {
  role: "roles",
  site: "sites",
  location: "locations",
}

export function TopologyObjectsSidebar({
  graph,
  checks,
  zones,
  hidden,
  onHiddenChange,
  selectedDeviceId,
  selectedGroupId,
  selectedEdgeId,
  onPickNode,
  onPickGroup,
  onDrillGroup,
  onPickEdge,
  onFocusZone,
  onRenameZone,
  onReorderBands,
}: {
  /** The whole graph, hidden objects included - they are listed dimmed. */
  graph: TopologyGraph
  /** Monitoring roll-up per device id, for the chips. */
  checks: Record<string, BulkStatusEntry>
  zones: Zone[] | undefined
  hidden: TopoHidden
  onHiddenChange: (next: TopoHidden) => void
  selectedDeviceId: string | null
  selectedGroupId: string | null
  selectedEdgeId: string | null
  onPickNode: (node: TopoNode) => void
  onPickGroup: (node: TopoNode) => void
  onDrillGroup: (data: TopoGroupData) => void
  onPickEdge: (edge: TopoEdge) => void
  onFocusZone: (zone: Zone) => void
  onRenameZone: (id: string, label: string) => void
  /** The layer bands (rows) in a new top-to-bottom order. */
  onReorderBands?: (ids: string[]) => void
}) {
  const [q, setQ] = useState("")
  const [status, setStatus] = useState<CheckFilter>(null)
  const [mode, setModeState] = useState<GroupMode>(readGroupMode)
  const setMode = (m: GroupMode) => {
    try {
      localStorage.setItem(GROUP_MODE_KEY, m)
    } catch {
      /* private mode - the choice just doesn't stick */
    }
    setModeState(m)
  }
  const [editingZone, setEditingZone] = useState<string | null>(null)
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } })
  )
  // The panel the long lists scroll in: they draw only what is near view.
  const [scroller, setScroller] = useState<HTMLElement | null>(null)

  const filter = q.trim().toLowerCase()
  const matchNode = (d: TopoNode["data"]) =>
    !filter ||
    d.name.toLowerCase().includes(filter) ||
    (d.primary_ip ?? "").includes(filter) ||
    (d.device_type ?? "").toLowerCase().includes(filter)
  const matchStatus = (check: string | null | undefined) =>
    !status || check === status

  const grouped = graph.nodes.some((n) => n.type === "group")
  const toggle = (key: keyof TopoHidden, value: string, shown: boolean) =>
    onHiddenChange(setHidden(hidden, key, value, !shown))
  const shown = (n: TopoNode) => !nodeHidden(n, hidden)

  // The lists are rebuilt on every render - a few hundred nodes at most, and
  // the search and status filters are render-time inputs anyway.
  const groupRows = graph.nodes
    .filter((n) => n.type === "group")
    .filter((n) => matchNode(n.data))
    .sort((a, b) => byName(a.data, b.data))

  const deviceGroups = (() => {
    const map = new Map<
      string,
      { title: string; role: TopoNode["data"]["role"]; rows: DeviceRow[] }
    >()
    for (const n of graph.nodes) {
      if (n.type !== "device" || !n.data.device_id) continue
      const check =
        (checks[n.data.device_id] as BulkStatusEntry | undefined)?.status ??
        null
      if (!matchNode(n.data) || !matchStatus(check)) continue
      const key = groupTitle(n.data, mode)
      const g = map.get(key) ?? {
        title: key,
        role: mode === "role" ? n.data.role : null,
        rows: [],
      }
      g.rows.push({
        id: n.id,
        device_id: n.data.device_id,
        name: n.data.name,
        check,
        data: n.data,
        node: n,
      })
      map.set(key, g)
    }
    return [...map.values()]
      .map((g) => ({
        ...g,
        down: g.rows.filter((d) => d.check === "down").length,
        degraded: g.rows.filter((d) => d.check === "degraded").length,
        rows: g.rows.sort(byName),
      }))
      .sort((a, b) =>
        a.title.startsWith("No ")
          ? 1
          : b.title.startsWith("No ")
            ? -1
            : a.title.localeCompare(b.title)
      )
  })()

  const nodeById = useMemo(
    () => new Map(graph.nodes.map((n) => [n.id, n])),
    [graph]
  )

  // The filter's counts: every device the search matches, before the status
  // filter narrows the list - so each tab says what picking it would show.
  const statusCounts = checkCounts(
    graph.nodes
      .filter((n) => n.type === "device" && n.data.device_id)
      .filter((n) => matchNode(n.data))
      .map(
        (n) =>
          (checks[n.data.device_id!] as BulkStatusEntry | undefined)?.status
      )
  )

  // Everything unhealthy, worst-first - the sidebar's own triage list.
  // Hidden while a status filter narrows the sections themselves.
  const problems = status
    ? []
    : deviceGroups
        .flatMap((g) => g.rows)
        // Hidden objects are off the map, so they are not this map's problems.
        .filter((d) => shown(d.node))
        .filter((d) => d.check === "down" || d.check === "degraded")
        .sort((a, b) => checkRank(a.check) - checkRank(b.check) || byName(a, b))

  const linkGroups = (() => {
    const map = new Map<string, TopoEdge[]>()
    for (const e of graph.edges) {
      const fam = linkFamily(e)
      if (!fam) continue
      const a = nodeById.get(e.source)?.data.name ?? ""
      const b = nodeById.get(e.target)?.data.name ?? ""
      if (
        filter &&
        !a.toLowerCase().includes(filter) &&
        !b.toLowerCase().includes(filter) &&
        !(e.data?.cable_label ?? "").toLowerCase().includes(filter)
      )
        continue
      map.set(fam, [...(map.get(fam) ?? []), e])
    }
    return [...map.entries()].sort(([a], [b]) =>
      a === DISCOVERED ? 1 : b === DISCOVERED ? -1 : a.localeCompare(b)
    )
  })()

  const shownZones = (zones ?? []).filter(
    (z) => !filter || z.label.toLowerCase().includes(filter)
  )
  // Layer bands top to bottom, then side bands left to right, then zones.
  const bandRows = shownZones.filter(isRow).sort((a, b) => a.y - b.y)
  const sideRows = shownZones.filter(isSide).sort((a, b) => a.x - b.x)
  const zoneRows = shownZones.filter((z) => z.kind !== "band")
  // Reordering needs every row in the list: not while a search hides some.
  const sortable = !!onReorderBands && !filter && bandRows.length > 1
  const onBandDragEnd = (e: DragEndEvent) => {
    const { active, over } = e
    if (!over || active.id === over.id) return
    const ids = bandRows.map((r) => r.id)
    const from = ids.indexOf(String(active.id))
    const to = ids.indexOf(String(over.id))
    if (from < 0 || to < 0) return
    onReorderBands?.(arrayMove(ids, from, to))
  }
  const regionRow = (z: Zone, grip?: React.ReactNode) =>
    editingZone === z.id ? (
      <ZoneLabelInput
        key={z.id}
        zone={z}
        onDone={(label) => {
          if (label && label !== z.label) onRenameZone(z.id, label)
          setEditingZone(null)
        }}
      />
    ) : (
      <div key={z.id} className="flex items-center">
        {grip ?? (sortable && <span className="w-[18px] shrink-0" />)}
        <button
          type="button"
          onClick={() => onFocusZone(z)}
          onDoubleClick={() => setEditingZone(z.id)}
          className="flex min-w-0 flex-1 items-center gap-2 rounded px-1.5 py-1 text-left text-[13px] hover:bg-muted/60"
        >
          {/* The name on the box's own fill, as the canvas titles it. */}
          <span
            className={cn(
              "min-w-0 truncate rounded-[5px] border px-1.5 leading-5 whitespace-nowrap",
              z.kind === "band" && bandLook(z.color).className
            )}
            style={
              z.kind === "band"
                ? {
                    ...bandLook(z.color).style,
                    borderColor: bandLook(z.color).edge,
                  }
                : {
                    background: `color-mix(in srgb, ${z.color ?? ZONE_COLORS[0]} 22%, var(--card))`,
                    borderColor: `color-mix(in srgb, ${z.color ?? ZONE_COLORS[0]} 45%, var(--card))`,
                  }
            }
          >
            {z.label ||
              (isSide(z) ? "Side band" : z.kind === "band" ? "Band" : "Zone")}
          </span>
          {isRow(z) && (z.rule?.ids.length ?? 0) > 1 && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="num ml-auto flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground">
                  <Layers className="size-3" />
                  {z.rule!.ids.length}
                </span>
              </TooltipTrigger>
              <TooltipContent side="left" variant="default">
                {z.rule!.ids.length} layers
              </TooltipContent>
            </Tooltip>
          )}
        </button>
      </div>
    )

  const deviceCount = deviceGroups.reduce((n, g) => n + g.rows.length, 0)
  const total =
    groupRows.length +
    deviceCount +
    (status
      ? 0
      : linkGroups.reduce((n, [, rows]) => n + rows.length, 0) +
        shownZones.length)

  /** A link is off the map when its family is, or either end is. */
  const edgeDim = (e: TopoEdge) => {
    if (edgeHidden(e, hidden)) return true
    const a = nodeById.get(e.source)
    const b = nodeById.get(e.target)
    return (!!a && !shown(a)) || (!!b && !shown(b))
  }
  const edgeEnds = (e: TopoEdge) =>
    `${nodeById.get(e.source)?.data.name ?? "?"} ↔ ${
      nodeById.get(e.target)?.data.name ?? "?"
    }`

  return (
    <ObjectsPanel
      ref={setScroller}
      total={total}
      query={q}
      onQueryChange={setQ}
      onSearchEnter={() => {
        // Enter jumps straight to the first hit.
        const g = groupRows.at(0)
        const d = deviceGroups.at(0)?.rows.at(0)
        if (g) onPickGroup(g)
        else if (d) onPickNode(nodeById.get(d.id)!)
      }}
      status={status}
      onStatusChange={setStatus}
      statusCounts={statusCounts}
      hiddenCount={hiddenCount(hidden)}
      onShowAll={() => onHiddenChange(NO_TOPO_HIDDEN)}
    >
      {total === 0 && <ObjectsEmpty filtered={!!filter || !!status} />}

      {problems.length > 0 && (
        <ObjectsSection heading="Problems">
          <LazyRows
            root={scroller}
            rows={problems}
            estimate={ROW_H}
            row={(p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => onPickNode(nodeById.get(p.id)!)}
                className={cn(
                  "flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-[13px]",
                  selectedDeviceId === p.device_id
                    ? "bg-muted font-medium"
                    : "hover:bg-muted/60"
                )}
              >
                <span className="min-w-0 truncate">{p.name}</span>
                <span className="ml-auto shrink-0">
                  <RowCheckBadge check={p.check} />
                </span>
              </button>
            )}
          />
        </ObjectsSection>
      )}

      {groupRows.length > 0 && (
        <ObjectsSection
          heading={
            (groupRows[0].data as unknown as TopoGroupData).kind === "site"
              ? "Sites"
              : "Locations"
          }
        >
          <LazyRows
            root={scroller}
            rows={groupRows}
            estimate={GROUP_ROW_H}
            row={(n) => {
              const g = n.data as unknown as TopoGroupData
              const key = g.kind === "site" ? "sites" : "locations"
              return (
                <button
                  key={n.id}
                  type="button"
                  onClick={() => onPickGroup(n)}
                  onDoubleClick={() => onDrillGroup(g)}
                  className={cn(
                    "flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-[13px]",
                    !shown(n) && "text-muted-foreground/60",
                    selectedGroupId === g.group_id
                      ? "bg-muted font-medium"
                      : "hover:bg-muted/60"
                  )}
                >
                  <span className="min-w-0 truncate">{g.name}</span>
                  <span className="ml-auto flex shrink-0 items-center gap-1.5">
                    <VisibilityToggle
                      vis={{
                        shown: shown(n),
                        onChange: (v) => toggle(key, g.name, v),
                        what: g.name,
                      }}
                    />
                    <span className="num text-[11px] text-muted-foreground/70">
                      {g.device_count}
                    </span>
                  </span>
                </button>
              )
            }}
          />
        </ObjectsSection>
      )}

      {!grouped && deviceCount > 0 && (
        <ObjectsSection
          heading="Devices"
          action={
            <SegmentedTabs<GroupMode>
              className="[&>button]:h-6 [&>button]:px-2 [&>button]:text-[12px]"
              value={mode}
              onValueChange={setMode}
              items={GROUP_MODES.map(([value, label]) => ({ value, label }))}
            />
          }
        >
          {deviceGroups.map((g) => (
            <FoldableGroup
              key={`${mode}:${g.title}`}
              name={g.title}
              count={g.rows.length}
              label={
                // A role is a colored catalog object - its badge, and
                // "No role" as the plain one. Sites and locations are names.
                mode === "role" ? (
                  <ColorBadge
                    name={g.title}
                    color={g.role?.color || undefined}
                    className="max-w-44"
                  />
                ) : undefined
              }
              storageId={FOLDS}
              visibility={{
                shown: !hidden[GROUP_KEY[mode]].includes(g.title),
                onChange: (v) => toggle(GROUP_KEY[mode], g.title, v),
                what: g.title,
              }}
              extra={
                <>
                  <CheckCountBadge check="down" n={g.down} />
                  <CheckCountBadge check="degraded" n={g.degraded} />
                </>
              }
            >
              <LazyRows
                root={scroller}
                rows={g.rows}
                estimate={ROW_H}
                row={(d) => (
                  <button
                    key={d.id}
                    type="button"
                    onClick={() => onPickNode(d.node)}
                    className={cn(
                      "flex w-full items-center gap-2 rounded px-1.5 py-1 pl-6 text-left text-[13px]",
                      !shown(d.node) && "text-muted-foreground/60",
                      selectedDeviceId === d.device_id
                        ? "bg-muted font-medium"
                        : "hover:bg-muted/60"
                    )}
                  >
                    <span className="min-w-0 truncate">{d.name}</span>
                    {mode !== "role" && d.data.role && (
                      <ColorBadge
                        name={d.data.role.name}
                        color={d.data.role.color || undefined}
                        className="h-4 max-w-28 min-w-0 truncate px-1.5 text-[10px]"
                      />
                    )}
                    {filter && d.data.device_type && (
                      <span className="min-w-0 truncate text-[10px] text-muted-foreground/70">
                        {d.data.device_type}
                      </span>
                    )}
                    <span className="ml-auto flex shrink-0 items-center gap-1.5">
                      <VisibilityToggle
                        vis={{
                          shown: !hidden.devices.includes(d.id),
                          onChange: (v) => toggle("devices", d.id, v),
                          what: d.name,
                        }}
                      />
                      <RowCheckBadge check={d.check} />
                    </span>
                  </button>
                )}
              />
            </FoldableGroup>
          ))}
        </ObjectsSection>
      )}

      {linkGroups.length > 0 && !status && (
        <ObjectsSection heading="Links">
          {linkGroups.map(([fam, rows]) => (
            <FoldableGroup
              key={fam}
              // The stored family key: the fold state and the hidden set
              // keep it, while the badge shows the family's display name.
              name={fam}
              count={rows.length}
              defaultOpen={false}
              storageId={FOLDS}
              label={
                <ColorBadge
                  name={familyLabel(fam)}
                  color={
                    // Colored as a cable of its type is on the map; the
                    // families that are not a media type stay neutral.
                    fam === DISCOVERED ||
                    fam === BGP_SESSIONS ||
                    fam === UNTYPED
                      ? undefined
                      : typeColor(fam)
                  }
                  className="max-w-44"
                />
              }
              visibility={{
                shown: !hidden.kinds.includes(fam),
                onChange: (v) => toggle("kinds", fam, v),
                what: familyLabel(fam),
              }}
            >
              <LazyRows
                root={scroller}
                rows={rows}
                estimate={(e) =>
                  e.data?.cable_label || e.data?.cable_numid
                    ? LINK_ROW_H
                    : ROW_H
                }
                row={(e) => (
                  <button
                    key={e.id}
                    type="button"
                    onClick={() => onPickEdge(e)}
                    className={cn(
                      "flex w-full items-center gap-2 rounded px-1.5 py-1 pl-6 text-left text-[12px]",
                      edgeDim(e) && "text-muted-foreground/60",
                      selectedEdgeId === e.id
                        ? "bg-muted font-medium"
                        : "hover:bg-muted/60"
                    )}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{edgeEnds(e)}</span>
                      {(e.data?.cable_label || e.data?.cable_numid) && (
                        <span className="block truncate font-mono text-[11px] text-muted-foreground">
                          {e.data.cable_label || `#${e.data.cable_numid}`}
                        </span>
                      )}
                    </span>
                  </button>
                )}
              />
            </FoldableGroup>
          ))}
        </ObjectsSection>
      )}

      {shownZones.length > 0 && !status && (
        <ObjectsSection heading="Bands and zones">
          {sortable ? (
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={onBandDragEnd}
            >
              <SortableContext
                items={bandRows.map((r) => r.id)}
                strategy={verticalListSortingStrategy}
              >
                {bandRows.map((z) => (
                  <SortableBand key={z.id} id={z.id}>
                    {(grip) => regionRow(z, grip)}
                  </SortableBand>
                ))}
              </SortableContext>
            </DndContext>
          ) : (
            bandRows.map((z) => regionRow(z))
          )}
          {sideRows.map((z) => regionRow(z))}
          {zoneRows.map((z) => regionRow(z))}
        </ObjectsSection>
      )}
    </ObjectsPanel>
  )
}

/** A layer band's sidebar row, draggable by its grip to restack. */
function SortableBand({
  id,
  children,
}: {
  id: string
  children: (grip: React.ReactNode) => React.ReactNode
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id })
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(isDragging && "opacity-60")}
    >
      {children(
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label="Reorder"
              className="cursor-grab px-0.5 text-muted-foreground active:cursor-grabbing"
              {...attributes}
              {...listeners}
            >
              <GripVertical className="size-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="left" variant="default">
            Reorder
          </TooltipContent>
        </Tooltip>
      )}
    </div>
  )
}

function ZoneLabelInput({
  zone,
  onDone,
}: {
  zone: Zone
  onDone: (label: string) => void
}) {
  const [value, setValue] = useState(zone.label)
  return (
    <Input
      autoFocus
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => onDone(value.trim())}
      onKeyDown={(e) => {
        if (e.key === "Enter") onDone(value.trim())
        if (e.key === "Escape") onDone(zone.label)
      }}
      aria-label="Rename"
      className="mb-0.5 h-7 text-[13px]"
    />
  )
}
