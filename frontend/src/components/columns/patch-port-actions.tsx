import { Link } from "@tanstack/react-router"
import type { ColumnDef } from "@tanstack/react-table"
import { Cable as CableIcon, Pencil, Trash2, Waypoints } from "lucide-react"

import type { FrontPort, RearPort } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { CableStatusControl } from "@/components/cable-status-control"
import type { CableTraceTarget } from "@/components/cable-trace-dialog"
import {
  MarkConnectedToggle,
  PortReserveAction,
} from "@/components/port-reservation-dialog"
import { hereUrl } from "@/lib/return-url"

/** The parts front and rear ports share: the cable chip and the row actions
 * of a patch-panel port. Each port type keeps its own column factory
 * (`front-port-columns.tsx`, `rear-port-columns.tsx`). */

// CableMini chip - the one place a cable color is allowed to show (it's the
// physical cable). Plain "-" when the port isn't cabled.
export function PatchCableCell({ cable }: { cable: RearPort["cable"] }) {
  if (!cable) return <span className="text-muted-foreground">-</span>
  return (
    <Link
      to="/cables/$id"
      params={{ id: cable.id }}
      className="link inline-flex items-center gap-1.5"
    >
      <span
        className="h-2.5 w-2.5 rounded-sm border border-border"
        style={cable.color ? { backgroundColor: cable.color } : undefined}
      />
      <span className="font-mono text-xs">{cable.type || "cable"}</span>
    </Link>
  )
}

export interface PatchPortActionOpts<T> {
  canEdit: boolean
  canDelete: boolean
  canEditCable: boolean
  canConnect: boolean
  canReserve: boolean
  onEdit: (row: T) => void
  onDelete: (row: T) => void
  onTrace: (target: CableTraceTarget) => void
}

/** Cable status, trace, connect / reserve / mark connected, edit, delete. */
export function patchPortActionsColumn<T extends FrontPort | RearPort>(
  kind: "front_port" | "rear_port",
  o: PatchPortActionOpts<T>
): ColumnDef<T> {
  const endpoint =
    kind === "front_port" ? "/api/front-ports/" : "/api/rear-ports/"
  return {
    id: "actions",
    header: "",
    enableHiding: false,
    cell: ({ row }) => {
      const p = row.original
      return (
        <div className="flex justify-end gap-1">
          {p.cable && (
            <CableStatusControl
              cableId={p.cable.id}
              status={p.cable.status}
              canEdit={o.canEditCable}
            />
          )}
          {p.cable && (
            <Button
              size="icon"
              variant="ghost"
              className="h-7 w-7"
              title="Trace this run"
              aria-label={`Trace ${p.name}`}
              onClick={() => o.onTrace({ id: p.cable!.id, label: p.name })}
            >
              <Waypoints className="h-3.5 w-3.5" />
            </Button>
          )}
          {!p.cable && (
            <>
              {o.canConnect && (
                <Button
                  size="icon"
                  variant="ghost"
                  asChild
                  className="h-7 w-7 text-muted-foreground hover:text-primary"
                  title="Connect cable"
                >
                  <Link
                    to="/cables/new"
                    search={{ a_kind: kind, a_id: p.id, ret: hereUrl() }}
                  >
                    <CableIcon className="h-3.5 w-3.5" />
                  </Link>
                </Button>
              )}
              {!p.mark_connected && (
                <PortReserveAction
                  kind={kind}
                  portId={p.id}
                  name={p.name}
                  reservation={p.reservation}
                  canReserve={o.canReserve}
                />
              )}
              <MarkConnectedToggle
                endpoint={endpoint}
                portId={p.id}
                name={p.name}
                marked={!!p.mark_connected}
                canEdit={o.canEdit}
              />
            </>
          )}
          {o.canEdit && (
            <Button
              size="icon"
              variant="ghost"
              className="h-7 w-7"
              aria-label={`Edit ${p.name}`}
              onClick={() => o.onEdit(p)}
            >
              <Pencil className="h-3.5 w-3.5" />
            </Button>
          )}
          {o.canDelete && (
            <Button
              size="icon"
              variant="ghost"
              className="h-7 w-7 text-destructive hover:text-destructive"
              aria-label={`Delete ${p.name}`}
              onClick={() => o.onDelete(p)}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      )
    },
  }
}
