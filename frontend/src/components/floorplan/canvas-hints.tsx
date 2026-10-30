import { Button } from "@/components/ui/button"

import type { EditorMode } from "./use-plan-edit-state"

/** The one-line hints at the foot of the canvas while a tray or wall is
 * being drawn, a door is armed, or the trays are being reshaped. */
export function CanvasHints({
  mode,
  drawPoints,
  doorArmed,
  trayEditMode,
  setTrayEditMode,
}: {
  mode: EditorMode
  drawPoints: [number, number][] | null
  doorArmed: boolean
  trayEditMode: boolean
  setTrayEditMode: (v: boolean) => void
}) {
  return (
    <>
      {mode === "cable" && drawPoints !== null && (
        <div className="absolute bottom-4 left-1/2 z-10 -translate-x-1/2 rounded-full border border-border bg-background px-4 py-1.5 text-xs shadow-sm">
          Click corners to route the tray · double-click to finish · Esc to
          cancel ({drawPoints.length})
        </div>
      )}
      {mode === "structure" && drawPoints !== null && (
        <div className="absolute bottom-4 left-1/2 z-10 -translate-x-1/2 rounded-full border border-border bg-background px-4 py-1.5 text-xs shadow-sm">
          Click corners to run the wall · double-click to finish · Esc to cancel
          ({drawPoints.length})
        </div>
      )}
      {doorArmed && (
        <div className="absolute bottom-4 left-1/2 z-10 -translate-x-1/2 rounded-full border border-border bg-background px-4 py-1.5 text-xs shadow-sm">
          Click a wall to place a 900 mm door · Esc to cancel
        </div>
      )}
      {trayEditMode && (
        <div className="absolute bottom-4 left-1/2 z-10 flex -translate-x-1/2 items-center gap-3 rounded-full border border-border bg-background px-4 py-1.5 text-xs shadow-sm">
          <span>
            <span className="font-medium">Editing trays</span> - cables hidden.
            Click a tray, drag its points, click{" "}
            <span className="font-medium">＋</span> to add a bend, right-click a
            point to remove.
          </span>
          <Button
            size="sm"
            className="h-6 px-2"
            onClick={() => setTrayEditMode(false)}
          >
            Done
          </Button>
        </div>
      )}
    </>
  )
}
