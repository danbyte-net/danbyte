import { useState } from "react"
import { Pencil } from "lucide-react"

import { Button } from "@/components/ui/button"
import { ServerBulkEditDialog } from "@/components/bulk-edit-dialog"
import { SafeBulkDeleteBar } from "@/components/safe-bulk-delete-bar"

export interface SafeBulkEditBarProps<T extends { id: string }> {
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
}

/**
 * The selection bar for a list whose viewset declares a BulkEditSpec (#314):
 * Edit opens the shared bulk-edit dialog with the fields the server names,
 * Delete is the safe bulk delete with its preview and kept rows.
 */
export function SafeBulkEditBar<T extends { id: string }>({
  selected,
  endpoint,
  noun,
  invalidate,
  onCleared,
  canEdit = true,
  canDelete = true,
}: SafeBulkEditBarProps<T>) {
  const [editOpen, setEditOpen] = useState(false)
  return (
    <>
      <SafeBulkDeleteBar
        selected={selected}
        endpoint={endpoint}
        noun={noun}
        invalidate={invalidate}
        onCleared={onCleared}
        canDelete={canDelete}
        actions={
          canEdit ? (
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2"
              onClick={() => setEditOpen(true)}
            >
              <Pencil className="mr-1 h-3 w-3" /> Edit
            </Button>
          ) : undefined
        }
      />
      {editOpen && selected.length > 0 && (
        <ServerBulkEditDialog
          endpoint={endpoint}
          noun={noun}
          ids={selected.map((r) => r.id)}
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
