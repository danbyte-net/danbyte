import { X } from "lucide-react"

import type { VirtualMachine } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { ApplyProfileBulkButton } from "@/components/device-profile-bulk"

// Floating action bar for /virtual-machines - appears when rows are
// selected: apply a device profile to the selection.
export function VmBulkBar({
  selected,
  onCleared,
}: {
  selected: VirtualMachine[]
  onCleared: () => void
}) {
  if (selected.length === 0) return null
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-4 z-40 flex justify-center">
      <div className="pointer-events-auto flex items-center gap-2 rounded-lg border border-border bg-popover px-2 py-1.5 text-popover-foreground shadow-lg">
        <span className="pl-2 text-xs font-medium text-foreground">
          {selected.length} selected
        </span>
        <span className="h-4 w-px bg-border" />
        <ApplyProfileBulkButton
          kind="vm"
          ids={selected.map((v) => v.id)}
          onDone={onCleared}
        />
        <Button
          size="sm"
          variant="ghost"
          className="h-7 w-7 p-0"
          onClick={onCleared}
          title="Clear selection"
        >
          <X className="h-3 w-3" />
        </Button>
      </div>
    </div>
  )
}
