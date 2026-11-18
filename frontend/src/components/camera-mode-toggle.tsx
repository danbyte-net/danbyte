import { Move, Rotate3d } from "lucide-react"

import { BarTip, BarToggle } from "@/components/map-toolbar"
import { setCameraMode, useCameraMode } from "@/lib/camera-mode"
import { cn } from "@/lib/utils"

/**
 * Orbit | Pan for a 3D view's toolbar: what a left-drag does. Pan locks
 * rotation. Shared by every 3D view and kept in this browser.
 */
export function CameraModeToggle({
  className,
  buttonClassName,
  tipSide,
}: {
  className?: string
  /** On each button (an overlay's `bg-popover/95`). */
  buttonClassName?: string
  tipSide?: "top" | "right" | "bottom" | "left"
}) {
  const mode = useCameraMode()
  return (
    <div className={cn("flex items-center gap-1", className)}>
      <BarTip tip="Drag orbits" side={tipSide}>
        <BarToggle
          pressed={mode === "orbit"}
          className={buttonClassName}
          onClick={() => setCameraMode("orbit")}
        >
          <Rotate3d />
          Orbit
        </BarToggle>
      </BarTip>
      <BarTip tip="Drag pans, no rotation" side={tipSide}>
        <BarToggle
          pressed={mode === "pan"}
          className={buttonClassName}
          onClick={() => setCameraMode("pan")}
        >
          <Move />
          Pan
        </BarToggle>
      </BarTip>
    </div>
  )
}
