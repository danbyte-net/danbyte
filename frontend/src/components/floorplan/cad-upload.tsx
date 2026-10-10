import { useRef, useState } from "react"
import { toast } from "sonner"

import type { FloorPlanDrawingSupport } from "@/lib/api"
import { ConfirmDialog } from "@/components/confirm-dialog"
import { Loading } from "@/components/loading"
import { Button } from "@/components/ui/button"

import type { CadDrawingState } from "./use-cad-drawing"
import {
  drawingAccept,
  drawingFileProblem,
  useDrawingSupport,
} from "./use-cad-drawing"

// The drawing half of the plan's Background controls: upload a DXF (or a
// DWG when the server has a converter), the processing status, Reprocess
// and Remove. A plan has one background - choosing a drawing replaces the
// image, after a confirm.

export function DrawingUpload({
  cad,
  hasImage,
  support: supportProp,
}: {
  cad: CadDrawingState
  /** The plan has a background image, which a drawing replaces. */
  hasImage: boolean
  /** For tests; read from the server otherwise. */
  support?: FloorPlanDrawingSupport
}) {
  const supportQuery = useDrawingSupport(!supportProp)
  const support = supportProp ?? supportQuery.data
  const input = useRef<HTMLInputElement>(null)
  const [pending, setPending] = useState<File | null>(null)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const status = cad.drawing?.status ?? cad.summary?.status ?? null
  const busy =
    cad.upload.isPending || cad.remove.isPending || cad.reprocess.isPending

  const send = (file: File) => {
    const problem = drawingFileProblem(file, support)
    if (problem) {
      toast.error(problem)
      return
    }
    if (hasImage) setPending(file)
    else cad.upload.mutate(file)
  }

  return (
    <div data-part="drawing-upload" className="grid gap-2">
      <input
        ref={input}
        type="file"
        accept={drawingAccept(support)}
        className="hidden"
        data-testid="drawing-file"
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) send(f)
          e.target.value = ""
        }}
      />
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => input.current?.click()}
        >
          {cad.upload.isPending
            ? "Uploading…"
            : cad.summary
              ? "Replace drawing…"
              : "Upload drawing…"}
        </Button>
        {cad.summary && (
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => setConfirmRemove(true)}
          >
            Remove
          </Button>
        )}
      </div>
      {support && !support.dwg && (
        <p
          data-part="dwg-note"
          className="text-[11px] leading-snug text-muted-foreground"
        >
          {support.message}
        </p>
      )}
      {cad.summary && (
        <div className="grid gap-1 text-xs">
          <span className="truncate font-medium">
            {cad.summary.source_name}
          </span>
          {status === "queued" && <Loading className="min-h-12" />}
          {status === "failed" && (
            <>
              <p data-part="drawing-error" className="text-destructive">
                {cad.drawing?.error || "Processing failed."}
              </p>
              <Button
                variant="outline"
                size="sm"
                className="justify-self-start"
                disabled={busy}
                onClick={() => cad.reprocess.mutate()}
              >
                {cad.reprocess.isPending ? "Reprocessing…" : "Reprocess"}
              </Button>
            </>
          )}
          {status === "ready" &&
            cad.drawing &&
            cad.drawing.simplified.length > 0 && (
              <p className="text-[11px] text-muted-foreground">
                Simplified to fit: {cad.drawing.simplified.join(", ")}
              </p>
            )}
        </div>
      )}

      <ConfirmDialog
        open={!!pending}
        onOpenChange={(o) => !o && setPending(null)}
        title="Replace the background image?"
        description="A plan has one background. The drawing replaces the image."
        confirmLabel="Replace"
        pendingLabel="Uploading…"
        pending={cad.upload.isPending}
        onConfirm={() => {
          if (!pending) return
          cad.upload.mutate(pending, { onSettled: () => setPending(null) })
        }}
      />
      <ConfirmDialog
        open={confirmRemove}
        onOpenChange={setConfirmRemove}
        title="Remove the drawing?"
        description="Its file, layers and calibration go with it."
        confirmLabel="Remove"
        pendingLabel="Removing…"
        pending={cad.remove.isPending}
        onConfirm={() =>
          cad.remove.mutate(undefined, {
            onSettled: () => setConfirmRemove(false),
          })
        }
      />
    </div>
  )
}
