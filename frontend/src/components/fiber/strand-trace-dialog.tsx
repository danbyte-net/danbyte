import { useQuery } from "@tanstack/react-query"

import { api } from "@/lib/api"
import type { FiberColorEntry } from "@/lib/fiber"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { PathStrip } from "@/components/cable-trace-path"
import type { PathStep } from "@/components/cable-trace-path"
import { FiberDot } from "./fiber-dot"

interface StrandStep {
  t: "seg" | "chip"
  // seg
  cable_id?: string
  label?: string
  cable_label?: string | null
  color?: string | null
  strand?: number
  strand_color?: { name: string; hex: string }
  // chip
  device_id?: string
  device?: string
  panel?: boolean
  ports?: { name: string; interface_id: string | null }[]
}

interface StrandPath {
  strand: number
  color: { name: string; hex: string }
  cable: { id: string; label: string | null; type: string }
  steps: StrandStep[]
  complete: boolean
}

/** Maps the backend strand-path steps into the shared PathStrip format. The
 * trunk segment is drawn in the strand's fibre colour and tagged "strand N". */
function toSteps(steps: StrandStep[]): PathStep[] {
  return steps.map(
    (s): PathStep =>
      s.t === "seg"
        ? {
            t: "seg",
            seg: {
              cableId: s.cable_id,
              label: s.cable_label ?? s.label ?? "cable",
              tag: s.cable_label ?? undefined,
              color: s.color ?? undefined,
              self: false,
              fiber: true,
              strand: s.strand,
              strandColor: s.strand_color,
            },
          }
        : {
            t: "chip",
            chip: {
              deviceId: s.device_id,
              device: s.device ?? "",
              ports: (s.ports ?? []).map((p) => ({
                name: p.name,
                interfaceId: p.interface_id ?? undefined,
              })),
            },
          }
  )
}

export function StrandTraceDialog({
  cableId,
  position,
  palette,
  onOpenChange,
}: {
  cableId: string
  position: number | null
  palette: FiberColorEntry[]
  onOpenChange: (open: boolean) => void
}) {
  const q = useQuery({
    queryKey: ["cable-strand", cableId, position],
    queryFn: () =>
      api<StrandPath>(`/api/cables/${cableId}/strand/?n=${position}`),
    enabled: position != null,
  })

  return (
    <Dialog open={position != null} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {position != null && (
              <FiberDot
                position={position}
                palette={palette}
                size={16}
                showTracer
              />
            )}
            Fibre strand {position}
            {q.data && (
              <span className="text-sm font-normal text-muted-foreground">
                · {q.data.color.name}
                {q.data.complete ? "" : " · incomplete"}
              </span>
            )}
          </DialogTitle>
        </DialogHeader>
        {q.isLoading ? (
          <p className="text-sm text-muted-foreground">Tracing…</p>
        ) : q.data ? (
          <div className="overflow-x-auto py-2">
            <PathStrip steps={toSteps(q.data.steps)} />
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No path.</p>
        )}
      </DialogContent>
    </Dialog>
  )
}
