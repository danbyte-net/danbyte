import { Suspense, lazy, useEffect, useRef, useState } from "react"
import { useNavigate } from "@tanstack/react-router"
import { Maximize2, Minimize2, Scan } from "lucide-react"

import type { Model3DEffective } from "@/lib/api"
import type { ModelPortsDoc } from "@/lib/model-ports"
import { Loading } from "@/components/loading"
import { BarButton, BarIconButton, BarToggle } from "@/components/map-toolbar"
import { Section } from "@/components/ui/section"
import { cn } from "@/lib/utils"
import type {
  ModelViewerProps,
  ViewPreset,
} from "@/components/floorplan3d/model-viewer"

/** The viewer, in the 3D chunk: three.js loads only when a model shows. */
export const LazyModelViewer = lazy(
  () => import("@/components/floorplan3d/model-viewer")
)

export interface ViewerSource {
  model: Pick<Model3DEffective, "url" | "fit" | "up" | "front">
  sizeMm?: ModelViewerProps["sizeMm"]
  /** A device: markers coloured by port state, clicks open the port. */
  deviceId?: string | null
  /** A type: its mapping, drawn neutral. */
  templatePorts?: ModelPortsDoc | null
}

const PRESETS: { value: Exclude<ViewPreset, "fit">; label: string }[] = [
  { value: "front", label: "Front" },
  { value: "rear", label: "Rear" },
  { value: "top", label: "Top" },
]

/**
 * The model with its toolbar - Front / Rear / Top / Fit, port markers on or
 * off, fullscreen - for the Overview's "3D model" card and the device
 * Panel's 3D view. `note` sits at the toolbar's end.
 */
export function ModelViewerFrame({
  source,
  note,
  className = "h-80",
}: {
  source: ViewerSource
  note?: React.ReactNode
  className?: string
}) {
  const navigate = useNavigate()
  const wrap = useRef<HTMLDivElement>(null)
  const [view, setView] = useState<{ preset: ViewPreset; n: number }>({
    preset: "fit",
    n: 0,
  })
  const [markers, setMarkers] = useState(true)
  const [full, setFull] = useState(false)
  useEffect(() => {
    const onChange = () =>
      setFull(!!wrap.current && document.fullscreenElement === wrap.current)
    document.addEventListener("fullscreenchange", onChange)
    return () => document.removeEventListener("fullscreenchange", onChange)
  }, [])
  const go = (preset: ViewPreset) => setView((v) => ({ preset, n: v.n + 1 }))
  const hasPorts = !!source.deviceId || !!source.templatePorts?.ports.length
  return (
    <div
      ref={wrap}
      className={cn("flex flex-col bg-card", full && "h-full")}
      data-model-frame
    >
      <div className="flex flex-wrap items-center gap-1 border-b border-border px-2 py-1.5">
        {PRESETS.map((p) => (
          <BarButton
            key={p.value}
            variant="ghost"
            className={cn(view.preset !== p.value && "text-muted-foreground")}
            aria-pressed={view.preset === p.value}
            onClick={() => go(p.value)}
          >
            {p.label}
          </BarButton>
        ))}
        <BarIconButton label="Fit" onClick={() => go("fit")}>
          <Scan />
        </BarIconButton>
        {hasPorts && (
          <BarToggle pressed={markers} onClick={() => setMarkers((m) => !m)}>
            Ports
          </BarToggle>
        )}
        <span className="ml-auto flex items-center gap-2">
          {note && (
            <span className="text-[11px] whitespace-nowrap text-muted-foreground">
              {note}
            </span>
          )}
          <BarIconButton
            label={full ? "Exit fullscreen" : "Fullscreen"}
            onClick={() => {
              if (document.fullscreenElement) void document.exitFullscreen()
              else void wrap.current?.requestFullscreen?.()
            }}
          >
            {full ? <Minimize2 /> : <Maximize2 />}
          </BarIconButton>
        </span>
      </div>
      <Suspense fallback={<Loading className={className} />}>
        <LazyModelViewer
          {...source}
          markers={markers}
          view={view}
          className={full ? "min-h-0 flex-1" : className}
          onPort={(pk) => {
            const port = pk.port
            if (!port.id || !source.deviceId) return
            if (port.kind === "interface")
              void navigate({ to: "/interfaces/$id", params: { id: port.id } })
            else
              void navigate({
                to: "/devices/$id",
                params: { id: source.deviceId },
                search: { tab: "components" },
              })
          }}
        />
      </Suspense>
    </div>
  )
}

/**
 * The Overview's "3D model" card: the right column's viewer on a device
 * type's and a device's Overview. `sourceLabel` names whose model a device
 * draws ("From type" / "Own model").
 */
export function ModelViewerCard({
  source,
  sourceLabel,
}: {
  source: ViewerSource
  sourceLabel?: string
}) {
  return (
    <Section title="3D model" description={sourceLabel}>
      <div className="overflow-hidden rounded-lg border border-border bg-card">
        <ModelViewerFrame source={source} />
      </div>
    </Section>
  )
}

/**
 * An Overview with the model's sticky right column: the page's own content
 * left, the viewer right from `xl`, kept in view while the left scrolls.
 * Narrower, the viewer stacks first, under the header. No `aside`: the
 * content alone, as before.
 */
export function OverviewWithAside({
  aside,
  children,
}: {
  aside: React.ReactNode
  children: React.ReactNode
}) {
  if (!aside) return <>{children}</>
  return (
    <div
      className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_24rem]"
      data-overview-aside
    >
      <aside className="min-w-0 xl:sticky xl:top-4 xl:col-start-2 xl:row-start-1">
        {aside}
      </aside>
      <div className="min-w-0 xl:col-start-1 xl:row-start-1">{children}</div>
    </div>
  )
}
