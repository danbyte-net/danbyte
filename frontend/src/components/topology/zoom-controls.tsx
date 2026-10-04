import { Panel, useReactFlow } from "@xyflow/react"
import { Maximize, ZoomIn, ZoomOut } from "lucide-react"

import { BarIconButton } from "@/components/map-toolbar"

/** How long a zoom step animates, ms. */
const STEP_MS = 150

/** Opaque over the canvas's dots in both themes, and flat: a map's corner
 * controls are no overlay. */
const SOLID = "shadow-none dark:bg-background"

/**
 * The map's zoom buttons: Zoom in, Zoom out and Fit view, stacked in the
 * bottom-left corner. The toolbars' own icon buttons (outline, no shadow)
 * in place of React Flow's Controls, so the corner reads like the rest of
 * the page; each tip opens to the right, clear of the buttons below.
 */
export function ZoomControls({ onFit }: { onFit: () => void }) {
  const flow = useReactFlow()
  return (
    <Panel
      position="bottom-left"
      role="group"
      aria-label="Map controls"
      className="flex flex-col gap-1"
    >
      <BarIconButton
        label="Zoom in"
        tipSide="right"
        className={SOLID}
        onClick={() => void flow.zoomIn({ duration: STEP_MS })}
      >
        <ZoomIn />
      </BarIconButton>
      <BarIconButton
        label="Zoom out"
        tipSide="right"
        className={SOLID}
        onClick={() => void flow.zoomOut({ duration: STEP_MS })}
      >
        <ZoomOut />
      </BarIconButton>
      <BarIconButton
        label="Fit view"
        tipSide="right"
        className={SOLID}
        onClick={onFit}
      >
        <Maximize />
      </BarIconButton>
    </Panel>
  )
}
