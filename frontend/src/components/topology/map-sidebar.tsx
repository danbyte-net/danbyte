import { useMemo, useState } from "react"
import { EyeOff, Search } from "lucide-react"

import type {
  BulkStatusEntry,
  TopoEdge,
  TopoNode,
  TopologyGraph,
} from "@/lib/api"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import {
  CheckChip,
  CheckCountChip,
  FoldableGroup,
  VisibilityToggle,
} from "@/components/foldable-group"
import { hiddenCount, setHidden } from "@/components/hidden-objects"
import type { TopoGroupData } from "./group-node"
import {
  DISCOVERED,
  NO_LOCATION,
  NO_ROLE,
  NO_SITE,
  NO_TOPO_HIDDEN,
  edgeHidden,
  linkFamily,
  nodeHidden,
} from "./hidden"
import type { TopoHidden } from "./hidden"
import { typeColor } from "./topology-canvas"
import type { Zone } from "./view-positions"

// "On this map" for the topology page - the site map's sidebar with the
// graph's own objects: device cards grouped by role, site or location, the
// site/location aggregates when the map is grouped, the links by media
// type, and the zones drawn behind the cards. Click flies to and selects,
// like clicking the card; a zone row pans to the box and renames it on
// double-click, like the box itself. The eyes are the site map's: a group
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

type StatusFilter = "down" | "degraded" | "up" | null

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
}) {
  const [q, setQ] = useState("")
  const [status, setStatus] = useState<StatusFilter>(null)
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
    <aside className="flex w-72 shrink-0 flex-col overflow-y-auto border-l border-border p-3">
      <div className="mb-2 flex items-center justify-between">
        <p className="text-[11px] font-semibold tracking-wide uppercase">
          On this map
        </p>
        <span className="num text-[11px] text-muted-foreground">{total}</span>
      </div>
      <div className="relative mb-2">
        <Search className="absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            // Enter jumps straight to the first hit.
            if (e.key !== "Enter") return
            const g = groupRows.at(0)
            const d = deviceGroups.at(0)?.rows.at(0)
            if (g) onPickGroup(g)
            else if (d) onPickNode(nodeById.get(d.id)!)
          }}
          placeholder="Search the map…"
          className="h-8 pl-7 text-[13px]"
        />
      </div>

      <div className="mb-3 flex items-center gap-1">
        {(
          [
            [null, "All"],
            ["down", "down"],
            ["degraded", "degraded"],
            ["up", "up"],
          ] as [StatusFilter, string][]
        ).map(([value, label]) => (
          <button
            key={label}
            type="button"
            onClick={() => setStatus(value)}
            className={cn(
              "rounded-[4px] px-1.5 py-0.5 text-[10px] font-medium",
              status === value
                ? "bg-foreground text-background"
                : "bg-muted text-muted-foreground hover:text-foreground"
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {hiddenCount(hidden) > 0 && (
        <button
          type="button"
          onClick={() => onHiddenChange(NO_TOPO_HIDDEN)}
          className="mb-3 flex w-full items-center gap-1.5 rounded px-1 py-1 text-left text-[11px] text-muted-foreground hover:bg-muted/60 hover:text-foreground"
        >
          <EyeOff className="size-3 shrink-0" />
          <span className="num">{hiddenCount(hidden)}</span> hidden
          <span className="ml-auto underline underline-offset-2">Show all</span>
        </button>
      )}

      {total === 0 && (
        <p className="px-1 text-[13px] text-muted-foreground">
          {filter || status ? "No matches." : "Nothing on the map."}
        </p>
      )}

      {problems.length > 0 && (
        <div className="mb-3">
          <p className="mb-1 px-1 text-[10px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
            Problems
          </p>
          {problems.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => onPickNode(nodeById.get(p.id)!)}
              className={cn(
                "flex w-full items-center gap-2 rounded px-1.5 py-1 text-left font-mono text-[12px]",
                selectedDeviceId === p.device_id
                  ? "bg-muted font-medium"
                  : "hover:bg-muted/60"
              )}
            >
              <span className="min-w-0 truncate">{p.name}</span>
              <span className="ml-auto shrink-0">
                <CheckChip check={p.check} />
              </span>
            </button>
          ))}
        </div>
      )}

      {groupRows.length > 0 && (
        <div className="mb-3">
          <p className="mb-1 px-1 text-[10px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
            {(groupRows[0].data as unknown as TopoGroupData).kind === "site"
              ? "Sites"
              : "Locations"}
          </p>
          {groupRows.map((n) => {
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
          })}
        </div>
      )}

      {!grouped && deviceCount > 0 && (
        <div className="mb-3">
          <div className="mb-1 flex items-center px-1">
            <p className="text-[10px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
              Devices
            </p>
            <span className="ml-auto flex items-center gap-0.5">
              {GROUP_MODES.map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setMode(value)}
                  className={cn(
                    "rounded-[4px] px-1 py-0.5 text-[10px]",
                    mode === value
                      ? "bg-muted font-medium text-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  {label}
                </button>
              ))}
            </span>
          </div>
          {deviceGroups.map((g) => (
            <FoldableGroup
              key={`${mode}:${g.title}`}
              title={g.title}
              count={g.rows.length}
              badge={
                g.role ? (
                  <span
                    className="size-2.5 shrink-0 rounded-sm"
                    style={{ background: g.role.color || "#71717a" }}
                  />
                ) : undefined
              }
              storageId={FOLDS}
              visibility={{
                shown: !hidden[GROUP_KEY[mode]].includes(g.title),
                onChange: (v) => toggle(GROUP_KEY[mode], g.title, v),
                what: `${g.title} devices`,
              }}
              extra={
                <>
                  <CheckCountChip check="down" n={g.down} />
                  <CheckCountChip check="degraded" n={g.degraded} />
                </>
              }
            >
              {g.rows.map((d) => (
                <button
                  key={d.id}
                  type="button"
                  onClick={() => onPickNode(d.node)}
                  className={cn(
                    "flex w-full items-center gap-2 rounded px-1.5 py-1 pl-6 text-left font-mono text-[12px]",
                    !shown(d.node) && "text-muted-foreground/60",
                    selectedDeviceId === d.device_id
                      ? "bg-muted font-medium"
                      : "hover:bg-muted/60"
                  )}
                >
                  <span className="min-w-0 truncate">{d.name}</span>
                  {mode !== "role" && d.data.role && (
                    <span className="flex min-w-0 items-center gap-1 font-sans text-[10px] text-muted-foreground/70">
                      <span
                        className="size-2 shrink-0 rounded-sm"
                        style={{ background: d.data.role.color || "#71717a" }}
                      />
                      <span className="truncate">{d.data.role.name}</span>
                    </span>
                  )}
                  {filter && d.data.device_type && (
                    <span className="min-w-0 truncate font-sans text-[10px] text-muted-foreground/70">
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
                    <CheckChip check={d.check} />
                  </span>
                </button>
              ))}
            </FoldableGroup>
          ))}
        </div>
      )}

      {linkGroups.length > 0 && !status && (
        <div className="mb-3">
          <p className="mb-1 px-1 text-[10px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
            Links
          </p>
          {linkGroups.map(([fam, rows]) => (
            <FoldableGroup
              key={fam}
              title={fam}
              count={rows.length}
              defaultOpen={false}
              storageId={FOLDS}
              badge={
                <span
                  className="size-2.5 shrink-0 rounded-full"
                  style={{
                    background: fam === DISCOVERED ? "#71717a" : typeColor(fam),
                  }}
                />
              }
              visibility={{
                shown: !hidden.kinds.includes(fam),
                onChange: (v) => toggle("kinds", fam, v),
                what: `${fam} links`,
              }}
            >
              {rows.map((e) => (
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
                    <span className="block truncate font-mono">
                      {edgeEnds(e)}
                    </span>
                    {(e.data?.cable_label || e.data?.cable_numid) && (
                      <span className="block truncate text-[11px] text-muted-foreground">
                        {e.data.cable_label || `#${e.data.cable_numid}`}
                      </span>
                    )}
                  </span>
                </button>
              ))}
            </FoldableGroup>
          ))}
        </div>
      )}

      {shownZones.length > 0 && !status && (
        <div className="mb-3">
          <p className="mb-1 px-1 text-[10px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
            Zones
          </p>
          {shownZones.map((z) =>
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
              <button
                key={z.id}
                type="button"
                onClick={() => onFocusZone(z)}
                onDoubleClick={() => setEditingZone(z.id)}
                className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-[13px] hover:bg-muted/60"
              >
                <span
                  className="size-2.5 shrink-0 rounded-sm"
                  style={{ background: z.color }}
                />
                <span className="min-w-0 truncate">{z.label}</span>
              </button>
            )
          )}
        </div>
      )}
    </aside>
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
      className="mb-0.5 h-7 text-[13px]"
    />
  )
}
