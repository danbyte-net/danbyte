import { useState } from "react"
import { Pencil } from "lucide-react"

import { Button } from "@/components/ui/button"
import { BulkExport } from "@/components/bulk-export"
import { ServerBulkEditDialog } from "@/components/bulk-edit-dialog"
import { SafeBulkDeleteBar } from "@/components/safe-bulk-delete-bar"

export interface SafeBulkEditBarProps<T extends { id: string | number }> {
  selected: T[]
  /** The list endpoint; `bulk-delete/`, `bulk-update/` and
   * `bulk-edit-fields/` hang off it. */
  endpoint: string
  /** ["BGP session", "BGP sessions"] */
  noun: [string, string]
  /** Query key prefixes to refresh after a write. */
  invalidate: string[][]
  onCleared: () => void
  canEdit?: boolean
  canDelete?: boolean
  /** Object slug for "Export" of the selection (round-trip export). */
  ioType?: string
  /** The type's own actions, first in the bar - Enable and Disable. */
  actions?: React.ReactNode
}

/**
 * The selection bar for a list whose viewset declares a BulkEditSpec (#314):
 * Edit opens the shared bulk-edit dialog with the fields the server names,
 * Delete is the safe bulk delete with its preview and kept rows. Users and
 * groups have whole-number ids; they go to the server as text.
 */
export function SafeBulkEditBar<T extends { id: string | number }>({
  selected,
  endpoint,
  noun,
  invalidate,
  onCleared,
  canEdit = true,
  canDelete = true,
  ioType,
  actions,
}: SafeBulkEditBarProps<T>) {
  const [editOpen, setEditOpen] = useState(false)
  const rows = selected.map((r) => ({ id: String(r.id) }))
  const ids = rows.map((r) => r.id)
  return (
    <>
      <SafeBulkDeleteBar
        selected={rows}
        endpoint={endpoint}
        noun={noun}
        invalidate={invalidate}
        onCleared={onCleared}
        canDelete={canDelete}
        actions={
          actions || ioType || canEdit ? (
            <>
              {actions}
              {ioType && <BulkExport ioType={ioType} ids={ids} />}
              {canEdit && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2"
                  onClick={() => setEditOpen(true)}
                >
                  <Pencil className="mr-1 h-3 w-3" /> Edit
                </Button>
              )}
            </>
          ) : undefined
        }
      />
      {editOpen && selected.length > 0 && (
        <ServerBulkEditDialog
          endpoint={endpoint}
          noun={noun}
          ids={ids}
          invalidate={invalidate}
          onClose={() => setEditOpen(false)}
          onDone={() => {
            setEditOpen(false)
            onCleared()
          }}
        />
      )}
    </>
  )
}
