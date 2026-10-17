import { Link } from "@tanstack/react-router"
import type { ColumnDef } from "@tanstack/react-table"
import { Cable as CableIcon, Pencil, Trash2 } from "lucide-react"

import type { PortReservationMini } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { PortReserveAction } from "@/components/port-reservation-dialog"
import { hereUrl } from "@/lib/return-url"

/** A cabled device component the row actions work on - console and power
 * ports and outlets. */
interface CablePortRow {
  id: string
  name: string
  cable: unknown | null
  reservation: PortReservationMini | null
}

export interface CablePortActionOpts<T> {
  canEdit: boolean
  canDelete: boolean
  canConnect: boolean
  canReserve: boolean
  onEdit: (row: T) => void
  onDelete: (row: T) => void
}

/** Connect / reserve while uncabled, then edit and delete. */
export function cablePortActionsColumn<T extends CablePortRow>(
  kind: "console_port" | "console_server_port" | "power_port" | "power_outlet",
  o: CablePortActionOpts<T>
): ColumnDef<T> {
  return {
    id: "actions",
    header: "",
    enableHiding: false,
    cell: ({ row }) => (
      <div className="flex justify-end gap-1">
        {!row.original.cable && (
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
                  search={{
                    a_kind: kind,
                    a_id: row.original.id,
                    ret: hereUrl(),
                  }}
                >
                  <CableIcon className="h-3.5 w-3.5" />
                </Link>
              </Button>
            )}
            <PortReserveAction
              kind={kind}
              portId={row.original.id}
              name={row.original.name}
              reservation={row.original.reservation}
              canReserve={o.canReserve}
            />
          </>
        )}
        {o.canEdit && (
          <Button
            size="icon"
            variant="ghost"
            className="h-7 w-7"
            aria-label={`Edit ${row.original.name}`}
            onClick={() => o.onEdit(row.original)}
          >
            <Pencil className="h-3.5 w-3.5" />
          </Button>
        )}
        {o.canDelete && (
          <Button
            size="icon"
            variant="ghost"
            className="h-7 w-7 text-destructive hover:text-destructive"
            aria-label={`Delete ${row.original.name}`}
            onClick={() => o.onDelete(row.original)}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>
    ),
  }
}
