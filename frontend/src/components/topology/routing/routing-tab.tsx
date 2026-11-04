import { lazy, Suspense, useMemo, useState } from "react"
import type { RefObject } from "react"

import type {
  RoutingEdge,
  RoutingLayer,
  RoutingNode,
  RoutingTopology,
} from "@/lib/api"
import { EmptyState } from "@/components/empty-state"
import { HiddenChip } from "@/components/hidden-chip"
import {
  setHidden as withHidden,
  useHideKeys,
} from "@/components/hidden-objects"
import { LegendFrame, LegendItems } from "@/components/map-legend"
import { Loading } from "@/components/loading"
import { PointerMenu } from "@/components/pointer-menu"
import { QueryError } from "@/components/query-error"
import { EdgeMenuItems, RegionMenuItems, edgeMenuKeys } from "../context-menu"
import type { TopoHidden } from "../hidden"
import { ZONE_COLORS, ZONE_H, ZONE_W } from "../view-positions"
import type { PosMap, Zone } from "../view-positions"
import type { RoutingCanvasHandle } from "./routing-canvas"
import { routingLegendRows } from "./routing-document"
import { RouterMenuItems, RoutingPaneMenuItems } from "./routing-menus"
import { hiddenRouting, shownRouting } from "./routing-model"
import type { RoutingSettings } from "./routing-model"
import { RoutingEdgePanel, RoutingNodePanel } from "./routing-panels"
import { RoutingObjectsSidebar } from "./routing-sidebar"

const RoutingCanvas = lazy(() =>
  import("./routing-canvas").then((m) => ({ default: m.RoutingCanvas }))
)

/** The legend's open state, shared with the other tabs. */
const LEGEND_KEY = "topology:legend"

type Menu = {
  x: number
  y: number
  fx?: number
  fy?: number
  node?: RoutingNode
  edge?: RoutingEdge
  zoneId?: string
}

/**
 * The Routing tab under the page's two bars: its canvas, the chips and the
 * legend over it, the panel of what is selected, and the Objects sidebar.
 * The page owns the map (its query, filters and URL), the view document
 * (where things stand, the boxes, what is hidden) and the toolbar; this
 * draws them.
 */
export function RoutingTab({
  data,
  loading,
  error,
  settings,
  onLayer,
  positions,
  zones,
  onArrange,
  hidden,
  onHiddenChange,
  showObjects,
  search,
  roleOrder,
  fitKey,
  canvasRef,
  onFocusDevice,
  builder,
  onBackToFiltered,
}: {
  data: RoutingTopology | undefined
  loading: boolean
  error: unknown
  settings: RoutingSettings
  onLayer: (layer: RoutingLayer, on: boolean) => void
  positions?: PosMap
  zones?: Zone[]
  /** Where every card and box stands now: one undo step. */
  onArrange: (positions: PosMap, zones: Zone[]) => void
  hidden: TopoHidden
  onHiddenChange: (next: TopoHidden) => void
  showObjects: boolean
  search: string
  roleOrder: readonly string[]
  fitKey: string
  canvasRef: RefObject<RoutingCanvasHandle | null>
  onFocusDevice: (deviceId: string) => void
  builder: boolean
  onBackToFiltered: () => void
}) {
  const [selNode, setSelNode] = useState<RoutingNode | null>(null)
  const [selEdge, setSelEdge] = useState<RoutingEdge | null>(null)
  const [menu, setMenu] = useState<Menu | null>(null)
  const clearSel = () => {
    setSelNode(null)
    setSelEdge(null)
  }

  const shown = useMemo(
    () => (data ? shownRouting(data, settings.layers, hidden) : undefined),
    [data, settings.layers, hidden]
  )
  const names = useMemo(
    () => new Map((data?.nodes ?? []).map((n) => [n.id, n.data.name])),
    [data]
  )
  const name = (id: string) => names.get(id) ?? "?"
  const matchedIds = useMemo(() => {
    const needle = search.trim().toLowerCase()
    if (!needle || !shown) return null
    return new Set(
      shown.nodes
        .filter((n) => {
          if (n.data.name.toLowerCase().includes(needle)) return true
          if (n.type !== "router") return false
          const r = n.data
          return (
            (r.router_id ?? "").includes(needle) ||
            (r.loopback ?? "").includes(needle) ||
            r.asns.some((a) => `as${a.asn}`.includes(needle))
          )
        })
        .map((n) => n.id)
    )
  }, [search, shown])

  /** Boxes as drawn, an edit to them pinning the arrangement too. */
  const editZones = (next: Zone[]) => {
    const now = canvasRef.current?.arrangement()
    onArrange(now?.positions ?? positions ?? {}, next)
  }
  const drawnZones = () => canvasRef.current?.arrangement().zones ?? zones ?? []
  const addZone = (x: number, y: number) => {
    const list = drawnZones()
    editZones([
      ...list,
      {
        id: `z${Date.now().toString(36)}`,
        label: "Zone",
        x: Math.round(x - ZONE_W / 2),
        y: Math.round(y - ZONE_H / 2),
        w: ZONE_W,
        h: ZONE_H,
        color: ZONE_COLORS[list.length % ZONE_COLORS.length],
      },
    ])
  }
  const hideNode = (id: string) => {
    onHiddenChange(withHidden(hidden, "devices", id, true))
    clearSel()
  }
  const hideEdge = (id: string) => {
    onHiddenChange(withHidden(hidden, "edges", id, true))
    clearSel()
  }
  useHideKeys(
    selNode
      ? () => hideNode(selNode.id)
      : selEdge
        ? () => hideEdge(selEdge.id)
        : null,
    () => {}
  )

  const hiddenHere = data ? hiddenRouting(data, hidden) : 0
  /** The boxes as the canvas draws them (By AS's until arranged). */
  const [sidebarZones, setSidebarZones] = useState<readonly Zone[]>([])

  return (
    <>
      <div className="relative min-h-0 flex-1">
        {loading && !data && <Loading className="absolute inset-0" />}
        {!!error && !data && (
          <div className="absolute inset-0 flex items-center justify-center p-6">
            <QueryError error={error} />
          </div>
        )}
        {shown && (
          <Suspense fallback={<Loading className="absolute inset-0" />}>
            <RoutingCanvas
              ref={canvasRef}
              map={shown}
              settings={settings}
              positions={positions}
              zones={zones}
              roleOrder={roleOrder}
              fitKey={fitKey}
              matchedIds={matchedIds}
              onArrange={onArrange}
              onZonesChange={editZones}
              onSelectNode={(n) => {
                clearSel()
                setSelNode(n)
              }}
              onSelectEdge={(e) => {
                clearSel()
                setSelEdge(e)
              }}
              onOpenNode={(n) => {
                if (n.type === "router" && n.data.device_id)
                  onFocusDevice(n.data.device_id)
              }}
              onCanvasClick={clearSel}
              onNodeContext={(node, x, y) => setMenu({ x, y, node })}
              onZoneContext={(zoneId, x, y) => setMenu({ x, y, zoneId })}
              onEdgeContext={(edge, x, y) => setMenu({ x, y, edge })}
              onPaneContext={(x, y, fx, fy) => setMenu({ x, y, fx, fy })}
              onZonesShown={setSidebarZones}
            />
          </Suspense>
        )}
        {shown && shown.nodes.length === 0 && (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center p-6">
            <EmptyState title="No routers on this map." className="bg-card">
              Devices and VMs with a routing process show here.
            </EmptyState>
          </div>
        )}
        <div className="pointer-events-none absolute top-3 left-3 z-10 flex flex-col items-start gap-2 [&>*]:pointer-events-auto">
          {!showObjects && (
            <HiddenChip
              count={hiddenHere}
              position="top-left"
              className="static"
              onShowAll={() =>
                onHiddenChange({ ...hidden, devices: [], edges: [] })
              }
            />
          )}
        </div>
        {shown && (
          <div className="absolute bottom-4 left-16 z-10">
            <LegendFrame storageKey={LEGEND_KEY}>
              <LegendItems rows={routingLegendRows(shown)} />
            </LegendFrame>
          </div>
        )}
        {selNode && (
          <RoutingNodePanel
            node={selNode}
            onClose={() => setSelNode(null)}
            onFocus={(id) => {
              onFocusDevice(id)
              setSelNode(null)
            }}
          />
        )}
        {selEdge && (
          <RoutingEdgePanel
            edge={selEdge}
            name={name}
            onClose={() => setSelEdge(null)}
          />
        )}
      </div>

      {showObjects && data && (
        <RoutingObjectsSidebar
          map={data}
          layers={settings.layers}
          available={data.meta.layers}
          onLayer={onLayer}
          zones={sidebarZones}
          hidden={hidden}
          onHiddenChange={onHiddenChange}
          selectedId={selNode?.id ?? selEdge?.id ?? null}
          onPickNode={(n) => {
            canvasRef.current?.focusNode(n.id)
            clearSel()
            setSelNode(n)
          }}
          onPickEdge={(e) => {
            canvasRef.current?.focusEdge(e.id)
            clearSel()
            setSelEdge(e)
          }}
          onFocusZone={(z) => canvasRef.current?.focusZone(z)}
        />
      )}

      <PointerMenu
        menu={menu}
        onClose={() => setMenu(null)}
        label={
          menu?.node
            ? "Router"
            : menu?.edge
              ? "Line"
              : menu?.zoneId
                ? "Area"
                : "Map"
        }
        keys={(m) =>
          m.node
            ? { h: () => hideNode(m.node!.id) }
            : m.edge
              ? edgeMenuKeys({ onHide: () => hideEdge(m.edge!.id) })
              : {}
        }
      >
        {(m) => {
          if (m.node)
            return (
              <RouterMenuItems
                node={m.node}
                onFocus={onFocusDevice}
                onHide={() => hideNode(m.node!.id)}
              />
            )
          if (m.edge)
            return (
              <EdgeMenuItems
                {...(m.edge.type === "cable" && m.edge.data.cables.length === 1
                  ? { cableId: m.edge.data.cables[0].id }
                  : {})}
                onHide={() => hideEdge(m.edge!.id)}
              />
            )
          if (m.zoneId) {
            const id = m.zoneId
            const list = drawnZones()
            const z = list.find((x) => x.id === id)
            return (
              <RegionMenuItems
                kind="zone"
                color={z?.color || null}
                onRename={() => canvasRef.current?.renameZone(id)}
                onRecolor={(c) =>
                  editZones(
                    list.map((x) => (x.id === id ? { ...x, color: c } : x))
                  )
                }
                onDelete={() => editZones(list.filter((x) => x.id !== id))}
              />
            )
          }
          return (
            <RoutingPaneMenuItems
              builder={builder}
              onAddZone={() => addZone(m.fx ?? 0, m.fy ?? 0)}
              onBackToFiltered={onBackToFiltered}
            />
          )
        }}
      </PointerMenu>
    </>
  )
}
