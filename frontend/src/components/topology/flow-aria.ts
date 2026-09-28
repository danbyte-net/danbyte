import type { AriaLabelConfig } from "@xyflow/react"

/**
 * React Flow's own control and landmark names, in the app's sentence case
 * ("Zoom in", not "Zoom In"). Its zoom buttons also show these as their
 * hover text. Pass to every `<ReactFlow ariaLabelConfig>` so a map's
 * controls read the same on each page.
 */
export const FLOW_ARIA_LABELS: Partial<AriaLabelConfig> = {
  "controls.ariaLabel": "Map controls",
  "controls.zoomIn.ariaLabel": "Zoom in",
  "controls.zoomOut.ariaLabel": "Zoom out",
  "controls.fitView.ariaLabel": "Fit view",
  "controls.interactive.ariaLabel": "Lock map",
  "minimap.ariaLabel": "Minimap",
}
