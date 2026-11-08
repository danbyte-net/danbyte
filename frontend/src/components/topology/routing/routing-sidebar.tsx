import { useMemo, useState } from "react"

import type {
  RoutingEdge,
  RoutingLayer,
  RoutingNode,
  RoutingTopology,
} from "@/lib/api"
import { ColorBadge } from "@/components/cells/color-badge"
import {
  FoldableGroup,
  ObjectRow,
  VisibilityToggle,
} from "@/components/foldable-group"
import { hiddenCount, setHidden } from "@/components/hidden-objects"
import { LegendLine } from "@/components/map-legend"
import {
  ObjectsEmpty,
  ObjectsPanel,
  ObjectsSection,
} from "@/components/objects-panel"
import { naturalCompare } from "@/lib/natural-sort"
import { cn } from "@/lib/utils"
import { NO_TOPO_HIDDEN } from "../hidden"
import type { TopoHidden } from "../hidden"
import { ZONE_COLORS } from "../view-positions"
import type { Zone } from "../view-positions"
import {
  ROUTING_LAYERS,
  layerOf,
  routingEdgeLook,
  routingEdgeTitle,
} from "./routing-model"

// The Routing tab's Objects sidebar, in the shared ObjectsPanel: the line
// layers first, each with its eye (a layer switched off is off the map and
// out of the exports) and its lines, each with its own; then the AS boxes
// and the routers, by AS box, with an eye each.

const FOLDS = "topology:routing:folds"

export function RoutingObjectsSidebar({
  map,
  layers,
  available,
  onLayer,
  zones,
  hidden,
  onHiddenChange,
  selectedId,
  onPickNode,
  onPickEdge,
  onFocusZone,
}: {
  /** Everything the map returned, hidden or not. */
  map: RoutingTopology
  layers: Record<RoutingLayer, boolean>
  /** The layers the caller may see. */
  available: Record<RoutingLayer, boolean>
  onLayer: (layer: RoutingLayer, on: boolean) => void
  zones: readonly Zone[]
  hidden: TopoHidden
  onHiddenChange: (next: TopoHidden) => void
  selectedId: string | null
  onPickNode: (n: RoutingNode) => void
  onPickEdge: (e: RoutingEdge) => void
  onFocusZone: (z: Zone) => void
}) {
  const [q, setQ] = useState("")
  const filter = q.trim().toLowerCase()
  const names = useMemo(
    () => new Map(map.nodes.map((n) => [n.id, n.data.name])),
    [map.nodes]
  )
  const name = (id: string) => names.get(id) ?? "?"
  const match = (text: string) => !filter || text.toLowerCase().includes(filter)

  const lines = (layer: RoutingLayer) =>
    map.edges
      .filter((e) => layerOf(e) === layer)
      .filter((e) => match(`${name(e.source)} ${name(e.target)}`))
  const routers = map.nodes.filter((n) => match(n.data.name))
  const groups = (() => {
    const out = new Map<string, { asn: number | null; rows: RoutingNode[] }>()
    for (const n of routers) {
      const asn = n.type === "router" ? n.data.as_group : null
      const key =
        n.type !== "router"
          ? "Provider networks"
          : asn === null
            ? "No AS"
            : `AS${asn}`
      const g = out.get(key) ?? { asn, rows: [] }
      g.rows.push(n)
      out.set(key, g)
    }
    return [...out.entries()]
      .map(([title, g]) => ({
        title,
        ...g,
        rows: g.rows.sort((a, b) => naturalCompare(a.data.name, b.data.name)),
      }))
      .sort((a, b) =>
        a.asn !== null && b.asn !== null
          ? a.asn - b.asn
          : a.asn !== null
            ? -1
            : b.asn !== null
              ? 1
              : naturalCompare(a.title, b.title)
      )
  })()
  const shownZones = zones.filter((z) => match(z.label))
  const layerRows = ROUTING_LAYERS.filter((l) => available[l.key])
  const total =
    routers.length +
    shownZones.length +
    layerRows.reduce((n, l) => n + lines(l.key).length, 0)
  const toggle = (key: keyof TopoHidden, id: string, shown: boolean) =>
    onHiddenChange(setHidden(hidden, key, id, !shown))

  return (
    <ObjectsPanel
      total={total}
      query={q}
      onQueryChange={setQ}
      onSearchEnter={() => {
        const n = groups.at(0)?.rows.at(0)
        if (n) onPickNode(n)
      }}
      hiddenCount={hiddenCount(hidden)}
      onShowAll={() => onHiddenChange(NO_TOPO_HIDDEN)}
    >
      {total === 0 && layerRows.length === 0 && (
        <ObjectsEmpty filtered={!!filter} />
      )}

      <ObjectsSection heading="Layers">
        {layerRows.map((l) => {
          const rows = lines(l.key)
          const sample = map.edges.find((e) => layerOf(e) === l.key)
          const look = sample ? routingEdgeLook(sample) : null
          return (
            <FoldableGroup
              key={l.key}
              name={l.key}
              label={
                <span className="flex items-center gap-2">
                  {look && (
                    <LegendLine
                      color={l.key === "ebgp" ? undefined : look.stroke}
                      width={look.width}
                      dash={look.dash}
                    />
                  )}
                  {l.label}
                </span>
              }
              count={rows.length}
              defaultOpen={false}
              storageId={FOLDS}
              visibility={{
                shown: layers[l.key],
                onChange: (v) => onLayer(l.key, v),
                what: l.label,
              }}
            >
              {rows.map((e) => (
                <ObjectRow
                  key={e.id}
                  onClick={() => onPickEdge(e)}
                  selected={selectedId === e.id}
                  className={cn(
                    "pl-6 text-[12px]",
                    (!layers[l.key] || hidden.edges.includes(e.id)) &&
                      "text-muted-foreground/60"
                  )}
                  trailing={
                    <VisibilityToggle
                      vis={{
                        shown: !hidden.edges.includes(e.id),
                        onChange: (v) => toggle("edges", e.id, v),
                        what: routingEdgeTitle(e, name),
                      }}
                    />
                  }
                >
                  <span className="min-w-0 truncate">
                    {name(e.source)} ⇄ {name(e.target)}
                  </span>
                </ObjectRow>
              ))}
            </FoldableGroup>
          )
        })}
      </ObjectsSection>

      {shownZones.length > 0 && (
        <ObjectsSection heading="AS boxes and zones">
          {shownZones.map((z) => (
            <ObjectRow key={z.id} onClick={() => onFocusZone(z)}>
              <span
                className="min-w-0 truncate rounded-[5px] border px-1.5 leading-5 whitespace-nowrap"
                style={{
                  background: `color-mix(in srgb, ${z.color ?? ZONE_COLORS[0]} 22%, var(--card))`,
                  borderColor: `color-mix(in srgb, ${z.color ?? ZONE_COLORS[0]} 45%, var(--card))`,
                }}
              >
                {z.label || "Zone"}
              </span>
            </ObjectRow>
          ))}
        </ObjectsSection>
      )}

      {routers.length > 0 && (
        <ObjectsSection heading="Routers">
          {groups.map((g) => (
            <FoldableGroup
              key={g.title}
              name={g.title}
              count={g.rows.length}
              storageId={FOLDS}
            >
              {g.rows.map((n) => (
                <ObjectRow
                  key={n.id}
                  onClick={() => onPickNode(n)}
                  selected={selectedId === n.id}
                  className={cn(
                    "pl-6",
                    hidden.devices.includes(n.id) && "text-muted-foreground/60"
                  )}
                  trailing={
                    <VisibilityToggle
                      vis={{
                        shown: !hidden.devices.includes(n.id),
                        onChange: (v) => toggle("devices", n.id, v),
                        what: n.data.name,
                      }}
                    />
                  }
                >
                  <span className="min-w-0 truncate">{n.data.name}</span>
                  {n.type === "router" && n.data.role && (
                    <ColorBadge
                      name={n.data.role.name}
                      color={n.data.role.color || undefined}
                      className="h-4 max-w-28 min-w-0 truncate px-1.5 text-[10px]"
                    />
                  )}
                </ObjectRow>
              ))}
            </FoldableGroup>
          ))}
        </ObjectsSection>
      )}
    </ObjectsPanel>
  )
}
