import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react"
import { Link } from "@tanstack/react-router"
import { ArrowUpRight, Crosshair, EyeOff, Workflow } from "lucide-react"

import { PointerMenu } from "@/components/pointer-menu"
import {
  DropdownMenuItem,
  DropdownMenuShortcut,
} from "@/components/ui/dropdown-menu"
import type { ApplicationFlow } from "@/lib/api"

import { AppMapCanvas } from "./app-map-canvas"
import type { AppMapCanvasHandle } from "./app-map-canvas"
import { refPath } from "./document"
import { AppMapLegend } from "./legend"
import type {
  AppBand,
  AppCardNode,
  AppEdge,
  AppMapGraph,
  AppMapRef,
  AppMapView,
} from "./model"
import { BandPanel, CardPanel, FlowsPanel } from "./panels"

// The Application map's drawing area (#163), shared by the Maps page and
// an application's Diagram tab: the canvas, the legend in the bottom-left
// corner, the detail panel top-right for what was clicked, and the
// right-click menu on a card (Open, Focus, its flows, Hide).

export interface AppMapStageHandle {
  focusNode: (id: string) => void
  select: (id: string) => void
}

type Selection =
  | { kind: "node"; id: string; ref: AppMapRef }
  | { kind: "edge"; id: string; flows: readonly ApplicationFlow[] }
  | { kind: "band"; band: AppBand }

interface Menu {
  x: number
  y: number
  node: AppCardNode
}

/** A host's key for the flows filter, from a card. */
function hostFilter(ref: AppMapRef): string | null {
  if (ref.kind === "host") return `${ref.host.kind}:${ref.host.id}`
  if (ref.kind === "end")
    return ref.end.device
      ? `device:${ref.end.device.id}`
      : ref.end.vm
        ? `vm:${ref.end.vm.id}`
        : null
  return null
}

export const AppMapStage = forwardRef<
  AppMapStageHandle,
  {
    graph: AppMapGraph
    view: AppMapView
    fitKey: string
    flows: readonly ApplicationFlow[]
    matched?: Set<string> | null
    legendKey?: string
    legendOpen?: boolean
    onMoved?: (centres: Record<string, [number, number]>) => void
    /** Hide a card (its eye in the Objects sidebar). */
    onHide?: (id: string) => void
    /** Show the flows that touch a host (`device:<id>` or `vm:<id>`). */
    onShowFlows?: (host: string) => void
  }
>(function AppMapStage(
  {
    graph,
    view,
    fitKey,
    flows,
    matched,
    legendKey,
    legendOpen,
    onMoved,
    onHide,
    onShowFlows,
  },
  ref
) {
  const canvas = useRef<AppMapCanvasHandle>(null)
  const [sel, setSel] = useState<Selection | null>(null)
  const [menu, setMenu] = useState<Menu | null>(null)
  // Another map: what was open belonged to the last one.
  useEffect(() => setSel(null), [fitKey])
  // Esc lets go of what is selected, and of the focus it brings.
  useEffect(() => {
    if (!sel) return
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape" && !ev.defaultPrevented) setSel(null)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [sel])

  useImperativeHandle(
    ref,
    () => ({
      focusNode: (id) => canvas.current?.focusNode(id),
      select: (id) => {
        const n = graph.nodes.find((x) => x.id === id)
        if (n) setSel({ kind: "node", id, ref: n.data.ref })
      },
    }),
    [graph]
  )

  const onSelectNode = (n: AppCardNode) =>
    setSel({ kind: "node", id: n.id, ref: n.data.ref })
  const onSelectEdge = (e: AppEdge) =>
    e.data?.flows?.length
      ? setSel({ kind: "edge", id: e.id, flows: e.data.flows })
      : setSel(null)
  const onSelectBand = (b: AppBand) =>
    b.application ? setSel({ kind: "band", band: b }) : setSel(null)

  const bandFlows = (b: AppBand) =>
    flows.filter((f) => f.application.id === b.application?.id).length

  return (
    <div className="relative h-full w-full">
      <AppMapCanvas
        ref={canvas}
        graph={graph}
        fitKey={fitKey}
        matched={matched}
        selectedNodeId={sel?.kind === "node" ? sel.id : null}
        selectedEdgeId={sel?.kind === "edge" ? sel.id : null}
        onSelectNode={onSelectNode}
        onSelectEdge={onSelectEdge}
        onSelectBand={onSelectBand}
        onPaneClick={() => setSel(null)}
        onMoved={onMoved}
        onNodeContext={(node, x, y) => setMenu({ x, y, node })}
      />
      {/* left-16 clears the zoom buttons in the corner. */}
      <div className="absolute bottom-4 left-16 z-10">
        <AppMapLegend
          view={view}
          flows={flows}
          storageKey={legendKey}
          defaultOpen={legendOpen}
        />
      </div>
      {sel?.kind === "node" && (
        <CardPanel refd={sel.ref} onClose={() => setSel(null)} />
      )}
      {sel?.kind === "edge" && (
        <FlowsPanel flows={sel.flows} onClose={() => setSel(null)} />
      )}
      {sel?.kind === "band" && (
        <BandPanel
          band={sel.band}
          flows={bandFlows(sel.band)}
          onClose={() => setSel(null)}
        />
      )}
      <PointerMenu
        menu={menu}
        onClose={() => setMenu(null)}
        label={
          menu?.node.data.ref.kind === "application" ? "Application" : "Card"
        }
        keys={(m) => (onHide ? { h: () => onHide(m.node.id) } : {})}
      >
        {(m) => {
          const path = refPath(m.node.data.ref)
          const host = hostFilter(m.node.data.ref)
          return (
            <>
              {path && (
                <DropdownMenuItem asChild>
                  <Link to={path as never}>
                    <ArrowUpRight /> Open
                  </Link>
                </DropdownMenuItem>
              )}
              <DropdownMenuItem
                onSelect={() => canvas.current?.focusNode(m.node.id)}
              >
                <Crosshair /> Focus
              </DropdownMenuItem>
              {host && onShowFlows && (
                <DropdownMenuItem onSelect={() => onShowFlows(host)}>
                  <Workflow /> Flows touching this host
                </DropdownMenuItem>
              )}
              {onHide && (
                <DropdownMenuItem onSelect={() => onHide(m.node.id)}>
                  <EyeOff /> Hide
                  <DropdownMenuShortcut>H</DropdownMenuShortcut>
                </DropdownMenuItem>
              )}
            </>
          )
        }}
      </PointerMenu>
    </div>
  )
})
