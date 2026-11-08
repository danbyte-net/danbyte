import { useState } from "react"
import { Pencil, Trash2, X } from "lucide-react"

import type { VirtualMachine } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { ServerBulkEditDialog } from "@/components/bulk-edit-dialog"
import { ApplyProfileBulkButton } from "@/components/device-profile-bulk"
import { SafeBulkDeleteDialog } from "@/components/safe-bulk-delete-bar"

const ENDPOINT = "/api/virtual-machines/"
const NOUN: [string, string] = ["virtual machine", "virtual machines"]
const INVALIDATE = [
  ["virtual-machines"],
  ["virtual-machines-picker"],
  ["prtg-links"],
]

// Floating action bar for /virtual-machines - appears when rows are
// selected: edit (the fields the server names), apply a device profile,
// delete.
export function VmBulkBar({
  selected,
  onCleared,
  canEdit = false,
  profiles = false,
  canDelete = false,
}: {
  selected: VirtualMachine[]
  onCleared: () => void
  /** Offer Edit. */
  canEdit?: boolean
  /** Offer Apply profile. */
  profiles?: boolean
  /** Offer Delete, with "Also remove from PRTG". */
  canDelete?: boolean
}) {
  const [editing, setEditing] = useState(false)
  const [deleting, setDeleting] = useState(false)
  if (selected.length === 0) return null
  return (
    <>
      <div className="pointer-events-none fixed inset-x-0 bottom-4 z-40 flex justify-center">
        <div className="pointer-events-auto flex items-center gap-2 rounded-lg border border-border bg-popover px-2 py-1.5 text-popover-foreground shadow-lg">
          <span className="pl-2 text-xs font-medium text-foreground">
            {selected.length} selected
          </span>
          <span className="h-4 w-px bg-border" />
          {canEdit && (
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2"
              onClick={() => setEditing(true)}
            >
              <Pencil className="mr-1 h-3 w-3" /> Edit
            </Button>
          )}
          {profiles && (
            <ApplyProfileBulkButton
              kind="vm"
              ids={selected.map((v) => v.id)}
              onDone={onCleared}
            />
          )}
          {canDelete && (
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-destructive hover:text-destructive"
              onClick={() => setDeleting(true)}
            >
              <Trash2 className="mr-1 h-3 w-3" /> Delete
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            className="h-7 w-7 p-0"
            onClick={onCleared}
            aria-label="Clear selection"
          >
            <X className="h-3 w-3" />
          </Button>
        </div>
      </div>
      {editing && (
        <ServerBulkEditDialog
          endpoint={ENDPOINT}
          noun={NOUN}
          ids={selected.map((v) => v.id)}
          invalidate={INVALIDATE}
          onClose={() => setEditing(false)}
          onDone={() => {
            setEditing(false)
            onCleared()
          }}
        />
      )}
      {deleting && (
        <SafeBulkDeleteDialog
          ids={selected.map((v) => v.id)}
          endpoint={ENDPOINT}
          noun={NOUN}
          invalidate={INVALIDATE}
          prtg
          onClose={() => setDeleting(false)}
          onDone={onCleared}
        />
      )}
    </>
  )
}
