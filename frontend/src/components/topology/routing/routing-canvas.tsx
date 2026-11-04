import "@xyflow/react/dist/style.css"

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react"
import {
  Background,
  BackgroundVariant,
  MarkerType,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
} from "@xyflow/react"
import type { Edge, Node, NodeTypes, EdgeTypes } from "@xyflow/react"

import type {
  RoutingEdge as RoutingEdgeT,
  RoutingNode,
  RoutingTopology,
} from "@/lib/api"
import type { DiagramDocument, DiagramMeta } from "@/lib/diagram/types"
import { useTheme } from "@/components/theme-provider"
import type { ExportRequest } from "../export/export-menu"
import { FLOW_ARIA_LABELS } from "../flow-aria"
import { MIN_ZOOM } from "../opening-view"
import { PROVIDER_NETWORK, ProviderNetworkNode } from "../provider-network-node"
import { ZONE_DRAG_HANDLE, ZoneNode } from "../zone-node"
import { ZoomControls } from "../zoom-controls"
import type { PosMap, Zone } from "../view-positions"
import { RouterNode } from "./router-node"
import type { RouterNodeData } from "./router-node"
import { RoutingEdge } from "./routing-edge"
import type { RoutingEdgeData } from "./routing-edge"
import { routingDocument } from "./routing-document"
import {
  arrangeByAs,
  cardsInside,
  edgeLanes,
  isFlagged,
  nodeSizes,
  routerBox,
  routingEdgeLabel,
  routingEdgeLook,
} from "./routing-model"
import type { RoutingSettings } from "./routing-model"

// The Routing tab's canvas: router cards, the provider networks of the
// Circuits layer, the AS boxes behind them and the lines between them, on
// its own React Flow (the Diagram's canvas is about ports and cables).
//
// Where things stand: the saved arrangement (`positions`, card centres, and
// `zones`, the AS boxes) or, for a map never arranged, Arrange ▸ By AS
// worked out on the spot. A card the arrangement has no place for joins it
// in a row under the rest. Dragging a card, or an AS box (which carries the
// cards inside it), or resizing a box hands the whole arrangement back
// (`onArrange`): from then on the map is arranged by hand.

const nodeTypes: NodeTypes = {
  router: RouterNode,
  [PROVIDER_NETWORK]: ProviderNetworkNode,
  zone: ZoneNode,
}
const edgeTypes: EdgeTypes = { routing: RoutingEdge }

const FIT_PAD = 0.15
const ZONE_PREFIX = "zone:"
const isZone = (n: Pick<Node, "id">) => n.id.startsWith(ZONE_PREFIX)

export interface RoutingCanvasHandle {
  /** The middle of the screen, in map coordinates. */
  center: () => { x: number; y: number }
  /** Every card's centre and every box as drawn now. */
  arrangement: () => { positions: PosMap; zones: Zone[] }
  focusNode: (id: string) => void
  focusEdge: (id: string) => void
  focusZone: (box: { x: number; y: number; w: number; h: number }) => void
  /** Open a box's name for editing. */
  renameZone: (id: string) => void
  /** Arrange ▸ By AS from the cards as they are sized now. */
  arrangeByAs: (roleOrder: readonly string[]) => {
    positions: PosMap
    zones: Zone[]
  }
  document: (
    req: ExportRequest & { meta: Omit<DiagramMeta, "mode">; origin?: string }
  ) => DiagramDocument | null
}

export interface RoutingCanvasProps {
  /** What is shown: layers on, nothing hidden. */
  map: RoutingTopology
  settings: RoutingSettings
  /** The saved card centres; undefined = never arranged. */
  positions?: PosMap
  /** The saved AS boxes and zones; undefined = never arranged. */
  zones?: Zone[]
  roleOrder: readonly string[]
  /** A new key re-fits the camera (a different map). */
  fitKey: string
  matchedIds: ReadonlySet<string> | null
  /** The arrangement after a drag or a resize: every card's centre and
   * every box. */
  onArrange: (positions: PosMap, zones: Zone[]) => void
  onZonesChange: (zones: Zone[]) => void
  onSelectNode: (n: RoutingNode) => void
  onSelectEdge: (e: RoutingEdgeT) => void
  onOpenNode: (n: RoutingNode) => void
  onCanvasClick: () => void
  onNodeContext: (n: RoutingNode, x: number, y: number) => void
  onZoneContext: (id: string, x: number, y: number) => void
  onEdgeContext: (e: RoutingEdgeT, x: number, y: number) => void
  onPaneContext: (x: number, y: number, fx: number, fy: number) => void
  /** The boxes drawn: the saved ones, or By AS's for a map never
   * arranged (the sidebar lists them). */
  onZonesShown?: (zones: readonly Zone[]) => void
}

/** Cards an arrangement has no place for, in a row under the rest. */
function placeNewcomers(
  ids: readonly string[],
  have: PosMap,
  sizes: ReadonlyMap<string, { w: number; h: number }>
): PosMap {
  const out: PosMap = {}
  if (!ids.length) return out
  const ys = Object.values(have).map(([, y]) => y)
  const xs = Object.values(have).map(([x]) => x)
  let x = xs.length ? Math.min(...xs) : 0
  const y = (ys.length ? Math.max(...ys) : 0) + 160
  for (const id of ids) {
    const s = sizes.get(id) ?? { w: 120, h: 40 }
    out[id] = [x + s.w / 2, y]
    x += s.w + 48
  }
  return out
}

const Inner = forwardRef<RoutingCanvasHandle, RoutingCanvasProps>(
  function Inner(props, ref) {
    const { map, settings, positions, zones, roleOrder, fitKey, matchedIds } =
      props
    const flow = useReactFlow()
    const { theme } = useTheme()
    const wrapper = useRef<HTMLDivElement>(null)
    const cb = useRef(props)
    cb.current = props
    const [renameAt, setRenameAt] = useState<{ id: string; at: number }>()

    const sizes = useMemo(
      () => nodeSizes(map.nodes, settings.mode, settings.fields),
      [map.nodes, settings.mode, settings.fields]
    )
    const roleKey = roleOrder.join("\u0000")
    // Never arranged (or laid out afresh): By AS, worked out here and not
    // saved until touched. Zones drawn by hand stay; the AS boxes follow
    // the cards.
    const auto = useMemo(
      () =>
        positions
          ? null
          : arrangeByAs(map, sizes, {
              roleOrder: roleKey ? roleKey.split("\u0000") : [],
              zones,
            }),
      [positions, map, sizes, roleKey, zones]
    )
    const centres = useMemo<PosMap>(() => {
      if (auto) return auto.positions
      const have: PosMap = {}
      const missing: string[] = []
      for (const n of map.nodes) {
        const p = positions?.[n.id]
        if (p) have[n.id] = p
        else missing.push(n.id)
      }
      return { ...have, ...placeNewcomers(missing, have, sizes) }
    }, [auto, positions, map.nodes, sizes])
    const shownZones = useMemo(() => auto?.zones ?? zones ?? [], [zones, auto])
    useEffect(() => cb.current.onZonesShown?.(shownZones), [shownZones])
    const lanes = useMemo(() => edgeLanes(map.edges), [map.edges])
    /** Hands the arrangement back (`commit`, below). */
    const commitRef = useRef<() => void>(() => {})

    const zoneNodes = useCallback(
      (list: readonly Zone[]): Node[] =>
        list.map((z) => ({
          id: `${ZONE_PREFIX}${z.id}`,
          type: "zone",
          position: { x: z.x, y: z.y },
          width: z.w,
          height: z.h,
          zIndex: 0,
          selectable: true,
          draggable: true,
          dragHandle: `.${ZONE_DRAG_HANDLE}`,
          data: {
            label: z.label,
            color: z.color,
            renameAt: renameAt?.id === z.id ? renameAt.at : undefined,
            onRename: (label: string) =>
              cb.current.onZonesChange(
                list.map((x) => (x.id === z.id ? { ...x, label } : x))
              ),
            onRecolor: (color: string) =>
              cb.current.onZonesChange(
                list.map((x) => (x.id === z.id ? { ...x, color } : x))
              ),
            onDelete: () =>
              cb.current.onZonesChange(list.filter((x) => x.id !== z.id)),
            onResizeEnd: () => commitRef.current(),
          },
        })),
      [renameAt]
    )

    const built = useMemo(() => {
      const nodes: Node[] = [...zoneNodes(shownZones)]
      for (const n of map.nodes) {
        const s = sizes.get(n.id)
        if (!Object.hasOwn(centres, n.id) || !s) continue
        const c = centres[n.id]
        const dimmed = !!matchedIds && !matchedIds.has(n.id)
        nodes.push({
          id: n.id,
          type: n.type,
          position: { x: c[0] - s.w / 2, y: c[1] - s.h / 2 },
          width: s.w,
          height: s.h,
          zIndex: 1,
          data:
            n.type === "router"
              ? ({
                  ...n.data,
                  box: routerBox(n.data, settings.mode, settings.fields),
                  dimmed,
                } satisfies RouterNodeData)
              : { ...n.data, dimmed },
        })
      }
      const edges: Edge[] = map.edges.map((e) => {
        const look = routingEdgeLook(e)
        const dimmed =
          !!matchedIds && !matchedIds.has(e.source) && !matchedIds.has(e.target)
        return {
          id: e.id,
          source: e.source,
          target: e.target,
          type: "routing",
          zIndex: look.faint ? 0 : 1,
          ...(look.arrow
            ? {
                markerEnd: {
                  type: MarkerType.ArrowClosed,
                  color: look.stroke,
                  width: 16,
                  height: 16,
                },
              }
            : {}),
          data: {
            look,
            label: routingEdgeLabel(e),
            lane: lanes.get(e.id) ?? 0,
            dimmed,
            flagged: isFlagged(e, settings),
          } satisfies RoutingEdgeData,
        }
      })
      return { nodes, edges }
    }, [
      map,
      centres,
      sizes,
      shownZones,
      zoneNodes,
      matchedIds,
      lanes,
      settings.mode,
      settings.fields,
      settings.checks,
    ])

    const [nodes, setNodes, onNodesChange] = useNodesState(built.nodes)
    const [edges, setEdges, onEdgesChange] = useEdgesState(built.edges)
    useEffect(() => {
      // Keep what is selected selected across a rebuild.
      setNodes((cur) => {
        const sel = new Set(cur.filter((n) => n.selected).map((n) => n.id))
        return built.nodes.map((n) =>
          sel.has(n.id) ? { ...n, selected: true } : n
        )
      })
      setEdges((cur) => {
        const sel = new Set(cur.filter((e) => e.selected).map((e) => e.id))
        return built.edges.map((e) =>
          sel.has(e.id) ? { ...e, selected: true } : e
        )
      })
    }, [built, setNodes, setEdges])

    // A different map: fit it once it is drawn.
    const fitted = useRef<string | null>(null)
    useEffect(() => {
      if (fitted.current === fitKey || !built.nodes.length) return
      fitted.current = fitKey
      requestAnimationFrame(() => {
        void flow.fitView({ padding: FIT_PAD, duration: 0 })
      })
    }, [fitKey, built.nodes.length, flow])

    /** The arrangement as drawn now, handed to the page. */
    const live = useRef({ zones: shownZones })
    live.current.zones = shownZones
    const arrangement = useCallback(() => {
      const pos: PosMap = {}
      const boxes: Zone[] = []
      const was = new Map(live.current.zones.map((z) => [z.id, z]))
      for (const n of flow.getNodes()) {
        const w = n.width ?? n.measured?.width ?? 0
        const h = n.height ?? n.measured?.height ?? 0
        if (isZone(n)) {
          const z = was.get(n.id.slice(ZONE_PREFIX.length))
          if (z)
            boxes.push({
              ...z,
              x: Math.round(n.position.x),
              y: Math.round(n.position.y),
              w: Math.round(w),
              h: Math.round(h),
            })
          continue
        }
        pos[n.id] = [
          Math.round(n.position.x + w / 2),
          Math.round(n.position.y + h / 2),
        ]
      }
      return { positions: pos, zones: boxes }
    }, [flow])
    const commit = useCallback(() => {
      const { positions: p, zones: z } = arrangement()
      cb.current.onArrange(p, z)
    }, [arrangement])
    commitRef.current = commit

    // An AS box carries the cards inside it.
    const carry = useRef<{
      zone: string
      from: { x: number; y: number }
      cards: Map<string, { x: number; y: number }>
    } | null>(null)
    const onNodeDragStart = (_: unknown, node: Node) => {
      if (!isZone(node)) {
        carry.current = null
        return
      }
      const z = live.current.zones.find(
        (x) => `${ZONE_PREFIX}${x.id}` === node.id
      )
      if (z?.asn === undefined) {
        carry.current = null
        return
      }
      const all = flow.getNodes()
      const at: PosMap = {}
      for (const n of all) {
        if (isZone(n)) continue
        const w = n.width ?? 0
        const h = n.height ?? 0
        at[n.id] = [n.position.x + w / 2, n.position.y + h / 2]
      }
      const inside = new Set(
        cardsInside(
          {
            x: node.position.x,
            y: node.position.y,
            w: node.width ?? z.w,
            h: node.height ?? z.h,
          },
          at
        )
      )
      carry.current = {
        zone: node.id,
        from: { ...node.position },
        cards: new Map(
          all.filter((n) => inside.has(n.id)).map((n) => [n.id, n.position])
        ),
      }
    }
    const onNodeDrag = (_: unknown, node: Node) => {
      const c = carry.current
      if (!c || c.zone !== node.id) return
      const dx = node.position.x - c.from.x
      const dy = node.position.y - c.from.y
      setNodes((cur) =>
        cur.map((n) => {
          const p = c.cards.get(n.id)
          return p ? { ...n, position: { x: p.x + dx, y: p.y + dy } } : n
        })
      )
    }
    const onNodeDragStop = () => {
      carry.current = null
      // After React Flow has settled the last move.
      requestAnimationFrame(commit)
    }

    const byId = useMemo(
      () => new Map(map.nodes.map((n) => [n.id, n])),
      [map.nodes]
    )
    const edgeById = useMemo(
      () => new Map(map.edges.map((e) => [e.id, e])),
      [map.edges]
    )

    useImperativeHandle(
      ref,
      () => ({
        center: () => {
          const el = wrapper.current
          if (!el) return { x: 0, y: 0 }
          const r = el.getBoundingClientRect()
          return flow.screenToFlowPosition({
            x: r.left + r.width / 2,
            y: r.top + r.height / 2,
          })
        },
        arrangement,
        focusNode: (id) => {
          const n = flow.getNode(id)
          if (!n) return
          flow.setCenter(
            n.position.x + (n.width ?? 0) / 2,
            n.position.y + (n.height ?? 0) / 2,
            { zoom: 1.1, duration: 500 }
          )
          setNodes((cur) =>
            cur.map((x) =>
              x.selected !== (x.id === id) ? { ...x, selected: x.id === id } : x
            )
          )
        },
        focusEdge: (id) => {
          const e = flow.getEdge(id)
          const a = e && flow.getNode(e.source)
          const b = e && flow.getNode(e.target)
          if (!a || !b) return
          flow.setCenter(
            (a.position.x + b.position.x) / 2,
            (a.position.y + b.position.y) / 2,
            { zoom: 1, duration: 500 }
          )
          setEdges((cur) =>
            cur.map((x) =>
              x.selected !== (x.id === id) ? { ...x, selected: x.id === id } : x
            )
          )
        },
        focusZone: (box) => {
          void flow.fitBounds(
            { x: box.x, y: box.y, width: box.w, height: box.h },
            { duration: 500, padding: 0.2 }
          )
        },
        renameZone: (id) => setRenameAt({ id, at: Date.now() }),
        arrangeByAs: (order) =>
          arrangeByAs(map, sizes, { roleOrder: order, zones: shownZones }),
        document: ({ area, meta, origin }) => {
          const el = wrapper.current
          let box = null
          if (area === "visible" && el) {
            const vp = flow.getViewport()
            box = {
              x: -vp.x / vp.zoom,
              y: -vp.y / vp.zoom,
              w: el.clientWidth / vp.zoom,
              h: el.clientHeight / vp.zoom,
            }
          }
          const now = arrangement()
          return routingDocument(
            {
              map,
              centres: now.positions,
              zones: now.zones,
              mode: settings.mode,
              fields: settings.fields,
              lanes,
            },
            { area: box, meta, origin }
          )
        },
      }),
      [
        flow,
        map,
        sizes,
        shownZones,
        settings,
        lanes,
        setNodes,
        setEdges,
        arrangement,
      ]
    )

    return (
      <div ref={wrapper} className="absolute inset-0">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          colorMode={theme}
          proOptions={{ hideAttribution: true }}
          nodesConnectable={false}
          deleteKeyCode={null}
          minZoom={MIN_ZOOM}
          ariaLabelConfig={FLOW_ARIA_LABELS}
          onNodeClick={(_, n) => {
            const r = byId.get(n.id)
            if (r) cb.current.onSelectNode(r)
          }}
          onNodeDoubleClick={(_, n) => {
            const r = byId.get(n.id)
            if (r) cb.current.onOpenNode(r)
          }}
          zoomOnDoubleClick={false}
          onEdgeClick={(_, e) => {
            const r = edgeById.get(e.id)
            if (r) cb.current.onSelectEdge(r)
          }}
          onNodeContextMenu={(ev, n) => {
            ev.preventDefault()
            if (isZone(n))
              cb.current.onZoneContext(
                n.id.slice(ZONE_PREFIX.length),
                ev.clientX,
                ev.clientY
              )
            else {
              const r = byId.get(n.id)
              if (r) cb.current.onNodeContext(r, ev.clientX, ev.clientY)
            }
          }}
          onEdgeContextMenu={(ev, e) => {
            const r = edgeById.get(e.id)
            if (!r) return
            ev.preventDefault()
            cb.current.onEdgeContext(r, ev.clientX, ev.clientY)
          }}
          onPaneContextMenu={(ev) => {
            ev.preventDefault()
            const p = flow.screenToFlowPosition({
              x: ev.clientX,
              y: ev.clientY,
            })
            cb.current.onPaneContext(ev.clientX, ev.clientY, p.x, p.y)
          }}
          onPaneClick={() => cb.current.onCanvasClick()}
          onNodeDragStart={onNodeDragStart}
          onNodeDrag={onNodeDrag}
          onNodeDragStop={onNodeDragStop}
          onlyRenderVisibleElements
        >
          <Background variant={BackgroundVariant.Dots} gap={20} size={1} />
          <ZoomControls
            onFit={() => void flow.fitView({ padding: FIT_PAD, duration: 300 })}
          />
          <MiniMap
            pannable
            zoomable
            nodeColor={(n) =>
              isZone(n)
                ? "transparent"
                : ((n.data as Partial<RouterNodeData>).box?.fill ?? "#94a3b8")
            }
            className="rounded-md border !border-border !bg-card"
          />
        </ReactFlow>
      </div>
    )
  }
)

/** The Routing tab's map. Lazy-loaded with the page's other canvases. */
export const RoutingCanvas = forwardRef<
  RoutingCanvasHandle,
  RoutingCanvasProps
>(function RoutingCanvas(props, ref) {
  return (
    <ReactFlowProvider>
      <Inner {...props} ref={ref} />
    </ReactFlowProvider>
  )
})
