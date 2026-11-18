import { Suspense, lazy, useEffect, useRef, useState } from "react"
import { Maximize2, Minimize2, Scan } from "lucide-react"

import type { Model3DEffective } from "@/lib/api"
import type { ModelPortsDoc } from "@/lib/model-ports"
import { CameraModeToggle } from "@/components/camera-mode-toggle"
import { Loading } from "@/components/loading"
import {
  BarButton,
  BarIconButton,
  BarMenuTrigger,
  BarToggle,
} from "@/components/map-toolbar"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Section } from "@/components/ui/section"
import {
  PLUGGABLES_LABEL,
  PLUGGABLES_MODES,
  readPluggablesMode,
  setPluggablesMode,
  usePluggablesMode,
} from "@/lib/pluggables-pref"
import { setStackViewOn, useStackViewOn } from "@/lib/stack-view"
import {
  STACKS_LABEL,
  STACKS_MODES,
  readStacksMode,
  setStacksMode,
  useStacksMode,
} from "@/lib/stacks-pref"
import { StackLinkStore } from "@/lib/stacks"
import { cn } from "@/lib/utils"
import {
  StackCableCard,
  StackCablesMenu,
  StackLinksContext,
} from "@/components/stack-cable-tools"
import type {
  ModelViewerProps,
  ViewPreset,
} from "@/components/floorplan3d/model-viewer"

/** The viewer, in the 3D chunk: three.js loads only when a model shows. */
export const LazyModelViewer = lazy(
  () => import("@/components/floorplan3d/model-viewer")
)

export interface ViewerSource {
  model: Pick<Model3DEffective, "url" | "fit" | "up" | "front"> &
    Partial<Pick<Model3DEffective, "bays" | "empty_mode">>
  sizeMm?: ModelViewerProps["sizeMm"]
  /** A device: markers coloured by port state; a click selects a port or
   * bay, a right-click opens its menu. */
  deviceId?: string | null
  deviceName?: string
  /** The chassis' manufacturer: its module types are offered first. */
  manufacturerId?: string | null
  /** A type: its mapping, drawn neutral. */
  templatePorts?: ModelPortsDoc | null
  /** A stack member's stack: the toolbar offers Stack, the whole stack
   * with its stack cables (stack-viewer). */
  stackId?: string | null
  /** Drawn beside the model, in its frame (model-viewer). */
  overlay?: ModelViewerProps["overlay"]
}

const PRESETS: { value: ViewPreset; label: string }[] = [
  { value: "front", label: "Front" },
  { value: "rear", label: "Rear" },
  { value: "top", label: "Top" },
  { value: "iso", label: "3D" },
]

/**
 * The model with its toolbar - Front / Rear / Top (straight on,
 * orthographic) / 3D (perspective), Fit to re-frame the current view,
 * Ports to outline every port (else only hovered, selected, cabled and
 * held ones show), Pluggables to show, ghost or hide the transceivers,
 * cords and plugs in a device's ports (the viewer's choice, shared with
 * the room; Ports ghosts them while it's on), on a stack member Stack to
 * draw the whole stack (and Stacks to show, ghost or hide its cables, the
 * room's choice), fullscreen - for the
 * Overview's "3D model" card and the device Panel's 3D view. `note` sits
 * at the toolbar's end.
 */
export function ModelViewerFrame({
  source,
  note,
  tools,
  stackOnly = false,
  className = "h-80",
}: {
  source: ViewerSource
  /** Always the whole stack, with no Stack switch (the virtual chassis
   * page, where the stack is the subject). */
  stackOnly?: boolean
  note?: React.ReactNode
  /** More toolbar controls, after the views. */
  tools?: React.ReactNode
  className?: string
}) {
  const wrap = useRef<HTMLDivElement>(null)
  const [view, setView] = useState<{ preset: ViewPreset; n: number }>({
    preset: "front",
    n: 0,
  })
  const [outlineAll, setOutlineAll] = useState(false)
  const pluggables = usePluggablesMode()
  const stacksMode = useStacksMode()
  const stackPref = useStackViewOn()
  const stackOn =
    (stackOnly || stackPref) && !!source.deviceId && !!source.stackId
  // The stack view's cables, for the Cables list and the picked one's
  // card (stack-cable-tools).
  const [links] = useState(() => new StackLinkStore())
  // The frame while it is fullscreen: menus mount inside it.
  const [fullEl, setFullEl] = useState<HTMLElement | null>(null)
  const full = fullEl !== null
  useEffect(() => {
    const onChange = () =>
      setFullEl(
        wrap.current && document.fullscreenElement === wrap.current
          ? wrap.current
          : null
      )
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
        <BarIconButton label="Fit" onClick={() => go(view.preset)}>
          <Scan />
        </BarIconButton>
        <CameraModeToggle />
        {hasPorts && (
          <BarToggle
            pressed={outlineAll}
            onClick={() => setOutlineAll((m) => !m)}
          >
            Ports
          </BarToggle>
        )}
        {tools}
        {source.deviceId && (
          <ModeMenu
            label="Pluggables"
            value={pluggables}
            modes={PLUGGABLES_MODES}
            labels={PLUGGABLES_LABEL}
            container={fullEl}
            onChange={(v) => setPluggablesMode(readPluggablesMode(v))}
          />
        )}
        {source.deviceId && source.stackId && !stackOnly && (
          <BarToggle pressed={stackOn} onClick={() => setStackViewOn(!stackOn)}>
            Stack
          </BarToggle>
        )}
        {stackOn && (
          <ModeMenu
            label="Stacks"
            value={stacksMode}
            modes={STACKS_MODES}
            labels={STACKS_LABEL}
            container={fullEl}
            onChange={(v) => setStacksMode(readStacksMode(v))}
          />
        )}
        {stackOn && stacksMode !== "hide" && (
          <StackCablesMenu store={links} container={fullEl} />
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
      <div className={cn("relative", full && "flex min-h-0 flex-1 flex-col")}>
        <StackLinksContext.Provider value={stackOn ? links : null}>
          <Suspense fallback={<Loading className={className} />}>
            <LazyModelViewer
              {...source}
              outlineAll={outlineAll}
              stackView={stackOn}
              view={view}
              className={full ? "min-h-0 flex-1" : className}
            />
          </Suspense>
        </StackLinksContext.Provider>
        {stackOn && <StackCableCard store={links} />}
      </div>
    </div>
  )
}

/** A Show / Ghost / Hide choice on the toolbar, muted at its default. */
function ModeMenu<TMode extends string>({
  label,
  value,
  modes,
  labels,
  container,
  onChange,
}: {
  label: string
  value: TMode
  modes: readonly TMode[]
  labels: Record<TMode, string>
  /** The fullscreen frame: the menu mounts inside it. */
  container: HTMLElement | null
  onChange: (v: string) => void
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <BarMenuTrigger
          className={cn(value === modes[0] && "text-muted-foreground")}
        >
          {label}
        </BarMenuTrigger>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="min-w-32"
        container={container ?? undefined}
      >
        <DropdownMenuRadioGroup value={value} onValueChange={onChange}>
          {modes.map((m) => (
            <DropdownMenuRadioItem key={m} value={m}>
              {labels[m]}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
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
