import { useRef } from "react"
import type { UseMutationResult } from "@tanstack/react-query"

import type { FloorPlan } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { SectionLabel } from "@/components/map-panel"

import { DrawingUpload } from "./cad-upload"
import type { CadDrawingState } from "./use-cad-drawing"

/** The background image's controls: a popover off the header on a wide
 * screen, a dialog from More on a narrow one. */
export function BackgroundControls({
  plan,
  cad,
  uploadBackground,
  patchPlan,
  onImageOverDrawing,
}: {
  plan: FloorPlan
  cad: CadDrawingState
  uploadBackground: UseMutationResult<FloorPlan, Error, File | null>
  patchPlan: UseMutationResult<FloorPlan, Error, Record<string, unknown>>
  /** An image picked while the plan has a drawing - it replaces the
   * drawing, after a confirm. */
  onImageOverDrawing: (file: File) => void
}) {
  const fileInput = useRef<HTMLInputElement>(null)
  return (
    <>
      <SectionLabel>Image</SectionLabel>
      <input
        ref={fileInput}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0]
          // One background per plan: an image replaces the drawing.
          if (f && plan.drawing) onImageOverDrawing(f)
          else if (f) uploadBackground.mutate(f)
          e.target.value = ""
        }}
      />
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={uploadBackground.isPending}
          onClick={() => fileInput.current?.click()}
        >
          {plan.background_image ? "Replace image…" : "Upload image…"}
        </Button>
        {plan.background_image && (
          <Button
            variant="ghost"
            size="sm"
            disabled={uploadBackground.isPending}
            onClick={() => uploadBackground.mutate(null)}
          >
            Remove
          </Button>
        )}
      </div>
      {plan.background_image && (
        <label className="grid gap-1 text-xs">
          <span className="text-muted-foreground">
            Opacity - <span className="num">{plan.background_opacity}%</span>
          </span>
          <input
            type="range"
            min={0}
            max={100}
            defaultValue={plan.background_opacity}
            onMouseUp={(e) =>
              patchPlan.mutate({
                background_opacity: Number(
                  (e.target as HTMLInputElement).value
                ),
              })
            }
            onTouchEnd={(e) =>
              patchPlan.mutate({
                background_opacity: Number(
                  (e.target as HTMLInputElement).value
                ),
              })
            }
          />
        </label>
      )}
      <SectionLabel className="mt-1">Drawing</SectionLabel>
      <DrawingUpload cad={cad} hasImage={!!plan.background_image} />
    </>
  )
}
